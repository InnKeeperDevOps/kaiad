// Package k8slog ships Kubernetes pod logs to the platform on agents
// running the kubernetes runtime backend.
//
// Background: the docker-mode log path (cmd/agent.streamExistingContainerLogs)
// reads container logs off a Docker daemon via /var/run/docker.sock. On a
// CRI-O / containerd cluster there is no Docker daemon and the agent pod
// has no docker.sock, so that path silently tails nothing — the platform
// never sees a crashing pod and no incident / auto-fix is ever raised.
//
// This package instead enumerates the pods Kaiad deployed (labelled
// kaiad.dev/service-id, same as appstats.K8sSampler) via kubectl and
// streams their logs into the shared logship.Sender, so error-level
// lines become app_log_error frames exactly like in docker mode. The
// agent's in-cluster service account already carries get/list pods +
// get pods/log.
package k8slog

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

const serviceIDLabel = "kaiad.dev/service-id"

// pollEvery is how often we re-list pods to attach to new ones / drop
// vanished ones. Crash loops cycle on the order of minutes, so 15s is
// responsive without hammering the API server.
const pollEvery = 15 * time.Second

// tailLines is how much history we pull on each (re)attach. A JVM/Spring
// startup stack trace is well under this; enough to capture the crash
// that already happened on a CrashLoopBackOff pod.
const tailLines = "200"

type podListJSON struct {
	Items []struct {
		Metadata struct {
			Name      string            `json:"name"`
			Namespace string            `json:"namespace"`
			Labels    map[string]string `json:"labels"`
		} `json:"metadata"`
	} `json:"items"`
}

// Stream blocks until ctx is cancelled, keeping a per-pod log tail alive
// for every Kaiad-managed pod. Safe to call once at agent startup in a
// goroutine.
func Stream(ctx context.Context, agentID string, sender docker.LogSender) {
	active := make(map[string]context.CancelFunc) // key: ns/name
	defer func() {
		for _, cancel := range active {
			cancel()
		}
	}()

	t := time.NewTicker(pollEvery)
	defer t.Stop()

	reconcile := func() {
		pods, err := listManagedPods(ctx)
		if err != nil {
			// Non-fatal: SA may lack rights momentarily, or kubectl
			// transient failure. Try again next tick.
			log.Printf("k8slog: pod list failed (will retry): %v", err)
			return
		}
		seen := make(map[string]struct{}, len(pods))
		for _, p := range pods {
			key := p.ns + "/" + p.name
			seen[key] = struct{}{}
			if _, ok := active[key]; ok {
				continue
			}
			podCtx, cancel := context.WithCancel(ctx)
			active[key] = cancel
			go tailPod(podCtx, p, agentID, sender)
			log.Printf("k8slog: tailing pod %s (service=%s)", key, p.sid)
		}
		// Drop tails for pods that no longer exist.
		for key, cancel := range active {
			if _, ok := seen[key]; !ok {
				cancel()
				delete(active, key)
			}
		}
	}

	reconcile()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			reconcile()
		}
	}
}

type podRef struct {
	ns, name, sid string
}

func listManagedPods(ctx context.Context) ([]podRef, error) {
	lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(lctx, "kubectl", "get", "pods", "-A",
		"-l", serviceIDLabel, "-o", "json").Output()
	if err != nil {
		return nil, err
	}
	var list podListJSON
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	refs := make([]podRef, 0, len(list.Items))
	for _, it := range list.Items {
		sid := it.Metadata.Labels[serviceIDLabel]
		if sid == "" || it.Metadata.Name == "" {
			continue
		}
		refs = append(refs, podRef{ns: it.Metadata.Namespace, name: it.Metadata.Name, sid: sid})
	}
	return refs, nil
}

// tailPod keeps shipping a pod's logs until its context is cancelled
// (pod deleted or agent shutting down). It alternates between a bounded
// history pull (captures the crash on a CrashLoopBackOff pod, whose
// container is not currently running so `-f` returns immediately) and a
// live follow. A per-pod signature suppresses re-shipping an unchanged
// history batch every cycle while the pod sits in back-off — the
// platform also dedupes by error fingerprint, so this is just politeness.
func tailPod(ctx context.Context, p podRef, agentID string, sender docker.LogSender) {
	var lastSig string
	for {
		if ctx.Err() != nil {
			return
		}

		// Phase 1: bounded history (includes the most recent, possibly
		// terminated, container instance — i.e. the crash trace).
		hist := runKubectl(ctx, 20*time.Second,
			"logs", "-n", p.ns, p.name,
			"--all-containers=true", "--timestamps=false",
			"--tail="+tailLines)
		if sig := signature(hist); sig != "" && sig != lastSig {
			shipLines(hist, p.sid, agentID, sender)
			lastSig = sig
		}

		// Phase 2: live follow. Returns quickly if the container is not
		// running (back-off); streams until the container dies/restarts
		// when it is.
		_ = followKubectl(ctx, p, agentID, sender)

		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func runKubectl(ctx context.Context, timeout time.Duration, args ...string) []string {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", args...).Output()
	if err != nil && len(out) == 0 {
		return nil
	}
	return splitNonEmpty(string(out))
}

func followKubectl(ctx context.Context, p podRef, agentID string, sender docker.LogSender) error {
	cmd := exec.CommandContext(ctx, "kubectl", "logs", "-f",
		"-n", p.ns, p.name,
		"--all-containers=true", "--timestamps=false", "--since=1s")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}
		line := strings.TrimRight(scanner.Text(), "\r\n")
		if line == "" {
			continue
		}
		_ = sender.SendLogEvent(agentID, p.sid, classifyLogLevel(line), line)
	}
	_ = cmd.Wait()
	return nil
}

func shipLines(lines []string, sid, agentID string, sender docker.LogSender) {
	for _, line := range lines {
		_ = sender.SendLogEvent(agentID, sid, classifyLogLevel(line), line)
	}
}

func splitNonEmpty(s string) []string {
	raw := strings.Split(s, "\n")
	out := make([]string, 0, len(raw))
	for _, l := range raw {
		l = strings.TrimRight(l, "\r")
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// signature is a cheap "did this history batch change" key: line count
// plus the last line. Good enough to skip re-shipping an identical
// back-off dump without tracking every line.
func signature(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(lines)))
	b.WriteByte('|')
	b.WriteString(lines[len(lines)-1])
	return b.String()
}

// classifyLogLevel mirrors docker.classifyLogLevel / logfile's copy —
// keep them aligned. Any line that smells like an error escalates so
// logship emits an app_log_error frame with context.
func classifyLogLevel(line string) string {
	upper := strings.ToUpper(line)
	for _, kw := range []string{"ERROR", "FATAL"} {
		if strings.Contains(upper, kw) {
			return "error"
		}
	}
	return "info"
}
