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
	"time"
)

const serviceIDLabel = "kaiad.dev/service-id"

// K8sSampler emits app_stats frames for kaiad-deployed pods via kubectl.
type K8sSampler struct {
	backendFn func() string
	timeout   time.Duration
}

func NewK8sSampler(getBackend func() string) *K8sSampler {
	return &K8sSampler{backendFn: getBackend, timeout: 10 * time.Second}
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
		if buf, merr := json.Marshal(msg); merr == nil {
			frames = append(frames, buf)
		}
	}
	return frames, nil
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
