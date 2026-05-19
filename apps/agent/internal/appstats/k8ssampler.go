// Kubernetes-mode app_stats. Docker-mode agents sample the docker
// daemon; k8s-mode agents have no docker socket on containerd nodes, so
// instead we enumerate the pods Kaiad deployed (labelled
// kaiad.dev/service-id) via kubectl and emit one app_stats frame per
// pod. CPU/memory come from `kubectl top` when the metrics API +
// RBAC are available (best-effort — instances/state are always
// reported). Network is not exposed by kubectl, so it's omitted in k8s.
package appstats

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const serviceIDLabel = "kaiad.dev/service-id"

type netSample struct {
	at time.Time
	rx uint64
	tx uint64
}

// K8sSampler emits app_stats frames for kaiad-deployed pods via kubectl.
type K8sSampler struct {
	backendFn func() string
	timeout   time.Duration

	mu     sync.Mutex
	lastNet map[string]netSample // keyed by "namespace/pod"
}

func NewK8sSampler(getBackend func() string) *K8sSampler {
	return &K8sSampler{
		backendFn: getBackend,
		timeout:   10 * time.Second,
		lastNet:   make(map[string]netSample),
	}
}

type k8sPodList struct {
	Items []struct {
		Metadata struct {
			Name      string            `json:"name"`
			Namespace string            `json:"namespace"`
			Labels    map[string]string `json:"labels"`
		} `json:"metadata"`
		Spec struct {
			Containers []struct {
				Image string `json:"image"`
			} `json:"containers"`
		} `json:"spec"`
		Status struct {
			Phase             string `json:"phase"`
			ContainerStatuses []struct {
				Ready bool `json:"ready"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

// Build returns one app_stats frame per kaiad-deployed pod. Returns no
// frames for non-kubernetes backends (the docker Sampler handles those).
func (k *K8sSampler) Build(agentID string) ([][]byte, error) {
	if k.backendFn == nil || strings.ToLower(strings.TrimSpace(k.backendFn())) != "kubernetes" {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, "kubectl", "get", "pods", "-A",
		"-l", serviceIDLabel, "-o", "json").Output()
	if err != nil {
		// Non-fatal: agent SA may not have list rights yet, or kubectl
		// missing. No frames this tick.
		return nil, nil
	}
	var list k8sPodList
	if jerr := json.Unmarshal(out, &list); jerr != nil {
		return nil, nil
	}

	// Best-effort metrics: `kubectl top pods` (metrics-server + RBAC).
	cpuMilli, memBytes := k.topMetrics(ctx)

	now := time.Now().UTC().Format(time.RFC3339Nano)
	frames := make([][]byte, 0, len(list.Items))
	for _, p := range list.Items {
		sid := p.Metadata.Labels[serviceIDLabel]
		if sid == "" {
			continue
		}
		msg := map[string]interface{}{
			"type":        "app_stats",
			"agentId":     agentID,
			"ts":          now,
			"containerId": p.Metadata.Name,
			"name":        p.Metadata.Name,
			"serviceId":   sid,
		}
		if len(p.Spec.Containers) > 0 && p.Spec.Containers[0].Image != "" {
			msg["image"] = p.Spec.Containers[0].Image
		}
		// Surface "running" only when the pod is Running AND all its
		// containers are ready — otherwise the phase (Pending/Failed…).
		state := strings.ToLower(p.Status.Phase)
		if p.Status.Phase == "Running" {
			ready := len(p.Status.ContainerStatuses) > 0
			for _, cs := range p.Status.ContainerStatuses {
				if !cs.Ready {
					ready = false
				}
			}
			if !ready {
				state = "starting"
			}
		}
		if state != "" {
			msg["state"] = state
		}
		key := p.Metadata.Namespace + "/" + p.Metadata.Name
		if m, ok := cpuMilli[key]; ok {
			// Report as % of one core (120m -> 12.0). The schema's
			// app cpuPercent has no upper bound, so multi-core is fine.
			msg["cpuPercent"] = float64(m) / 10.0
		}
		if b, ok := memBytes[key]; ok {
			msg["memUsedBytes"] = b
		}
		// Per-pod network: no first-party k8s API exposes it on common
		// containerd+CNI setups, so read the kernel counters from inside
		// the pod's net namespace and rate them from the prior sample.
		if rx, tx, ok := k.podNet(ctx, p.Metadata.Namespace, p.Metadata.Name); ok {
			now := time.Now()
			k.mu.Lock()
			prev, had := k.lastNet[key]
			k.lastNet[key] = netSample{at: now, rx: rx, tx: tx}
			k.mu.Unlock()
			if had {
				dt := now.Sub(prev.at).Seconds()
				if dt > 0 && rx >= prev.rx && tx >= prev.tx {
					msg["netRxBytesPerSec"] = float64(rx-prev.rx) / dt
					msg["netTxBytesPerSec"] = float64(tx-prev.tx) / dt
				}
			}
		}
		if buf, merr := json.Marshal(msg); merr == nil {
			frames = append(frames, buf)
		}
	}
	// Prune net history for pods that disappeared.
	live := make(map[string]struct{}, len(list.Items))
	for _, p := range list.Items {
		live[p.Metadata.Namespace+"/"+p.Metadata.Name] = struct{}{}
	}
	k.mu.Lock()
	for kk := range k.lastNet {
		if _, ok := live[kk]; !ok {
			delete(k.lastNet, kk)
		}
	}
	k.mu.Unlock()
	return frames, nil
}

// podNet reads cumulative rx/tx bytes (summed over non-loopback
// interfaces) from inside a pod via `kubectl exec … cat /proc/net/dev`.
// Best-effort: returns ok=false on any error (no shell/cat, exec
// forbidden, distroless image, timeout) — that pod just shows no net.
func (k *K8sSampler) podNet(ctx context.Context, ns, pod string) (uint64, uint64, bool) {
	ectx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ectx, "kubectl", "-n", ns, "exec", pod,
		"--", "cat", "/proc/net/dev").Output()
	if err != nil {
		return 0, 0, false
	}
	return parseProcNetDev(out)
}

// parseProcNetDev sums rx/tx bytes over all non-loopback interfaces in
// /proc/net/dev content. Returns ok=false when no usable iface line is
// found. Pure (no I/O) so it's unit-testable.
func parseProcNetDev(out []byte) (uint64, uint64, bool) {
	var rx, tx uint64
	any := false
	for _, line := range strings.Split(string(out), "\n") {
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue // header lines have no ':'
		}
		iface := strings.TrimSpace(line[:i])
		if iface == "" || iface == "lo" {
			continue
		}
		f := strings.Fields(line[i+1:])
		// receive: bytes packets errs drop fifo frame compressed multicast
		// transmit: bytes(8) packets errs drop fifo colls carrier compressed
		if len(f) < 9 {
			continue
		}
		r, e1 := strconv.ParseUint(f[0], 10, 64)
		t, e2 := strconv.ParseUint(f[8], 10, 64)
		if e1 != nil || e2 != nil {
			continue
		}
		rx += r
		tx += t
		any = true
	}
	return rx, tx, any
}

// topMetrics parses `kubectl top pods -A -l <label> --no-headers`.
// Returns ns/name -> cpu millicores and ns/name -> mem bytes. Empty
// maps when metrics aren't available (Forbidden / no metrics-server).
func (k *K8sSampler) topMetrics(ctx context.Context) (map[string]int64, map[string]int64) {
	cpu := map[string]int64{}
	mem := map[string]int64{}
	out, err := exec.CommandContext(ctx, "kubectl", "top", "pods", "-A",
		"-l", serviceIDLabel, "--no-headers").Output()
	if err != nil {
		return cpu, mem
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		// NAMESPACE NAME CPU(cores) MEMORY(bytes)
		if len(f) < 4 {
			continue
		}
		key := f[0] + "/" + f[1]
		if v, ok := parseMilliCPU(f[2]); ok {
			cpu[key] = v
		}
		if v, ok := parseMemBytes(f[3]); ok {
			mem[key] = v
		}
	}
	return cpu, mem
}

// parseMilliCPU: "120m" -> 120; "1" -> 1000.
func parseMilliCPU(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if strings.HasSuffix(s, "m") {
		n, err := strconv.ParseInt(strings.TrimSuffix(s, "m"), 10, 64)
		return n, err == nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return int64(f * 1000), true
}

// parseMemBytes: "34Mi" -> 35651584, "1Gi", "512Ki", "100" (bytes).
func parseMemBytes(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	mult := int64(1)
	switch {
	case strings.HasSuffix(s, "Ki"):
		mult, s = 1024, strings.TrimSuffix(s, "Ki")
	case strings.HasSuffix(s, "Mi"):
		mult, s = 1024*1024, strings.TrimSuffix(s, "Mi")
	case strings.HasSuffix(s, "Gi"):
		mult, s = 1024*1024*1024, strings.TrimSuffix(s, "Gi")
	case strings.HasSuffix(s, "Ti"):
		mult, s = 1024*1024*1024*1024, strings.TrimSuffix(s, "Ti")
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, false
	}
	return n * mult, true
}
