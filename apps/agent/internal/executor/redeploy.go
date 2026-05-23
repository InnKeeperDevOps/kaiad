package executor

// redeploy_service handler. Platform side dispatches one of these per
// bound agent after a manual build succeeds, with the per-environment
// resolved deployment metadata (instances, domains, loadBalancer).
//
// Backends:
//   docker     — pull image; stop+remove old containers labeled with
//                this service id; create+start `instances` new ones.
//                Port-publishes to the host when instances == 1
//                (multi-replica needs a fronting LB which is the
//                loadBalancer's job — out of v1 docker scope).
//   kubernetes — render Deployment/Service/Ingress YAML and
//                `kubectl apply`. Uses the in-cluster service-account
//                token; the operator grants the SA the necessary verbs
//                (apps/Deployment, /Service, networking.k8s.io/Ingress).
//   shell      — not supported; nothing to deploy onto.

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/lb"
)

// LabelServiceID is set on every container the agent creates so a future
// redeploy can find and clean up its own previous replicas without
// touching containers it didn't create.
const LabelServiceID = "kaiad.dev/service-id"
const LabelServiceName = "kaiad.dev/service-name"
const LabelBuildID = "kaiad.dev/build-id"
const LabelEnvironment = "kaiad.dev/environment"
const LabelNamespace = "kaiad.dev/namespace"

// DefaultDockerNamespace is the docker-mode fallback when kaiad.yaml
// declares no namespace. Used as the container-name prefix and label
// so kaiad-managed containers cluster naturally in `docker ps`.
const DefaultDockerNamespace = "kaiad"

type redeployInput struct {
	commandID    string
	serviceID    string
	// serviceName is the human-readable name (MonitoredService.name).
	// Used as the DNS-discoverable handle for the workload: docker
	// network alias on every replica + k8s Service.metadata.name.
	// Empty falls back to UUID-derived naming for backwards compat.
	serviceName  string
	buildID      string
	environment  string
	// namespace is the k8s namespace for k8s mode or the docker
	// "project name" for docker mode. Empty means "use the runtime's
	// default" (k8s: agent pod's own ns; docker: "kaiad").
	namespace    string
	imageRef     string
	instances    int
	domains      []domainSpec
	loadBalancer loadBalancerSpec
	// env is the resolved plain env-var map (runtime.env merged with the
	// per-environment override) injected into the deployed container.
	env map[string]string
	// volumes are the resolved runtime.volumes (or per-env override)
	// rendered as pod.spec.volumes + container.volumeMounts.
	volumes []volumeSpec
	// secretEnv are env vars sourced from existing k8s Secrets,
	// rendered as container env valueFrom.secretKeyRef.
	secretEnv []secretEnvSpec
}

type domainSpec struct {
	host     string
	port     int
	protocol string // "http" | "https"
}

type secretEnvSpec struct {
	name     string
	secret   string
	key      string
	optional bool
}
type volumeMountSpec struct {
	path     string
	subPath  string
	readOnly bool
}
type volumeSpec struct {
	name        string
	nfsServer   string
	nfsPath     string
	nfsReadOnly bool
	hostPath    string
	hostPathTyp string
	emptyDir    bool
	pvcClaim    string
	mounts      []volumeMountSpec
}
type loadBalancerSpec struct {
	typ             string            // "none" | "k8s" | "metallb" | "nginx"
	annotations     map[string]string // type=k8s
	addressPool     string            // type=metallb
	loadBalancerIPs string            // type=metallb (pinned fixed IP/IPs)
	ingressClass    string            // type=nginx
	tlsSecret       string            // type=nginx
}

// parseRedeployPayload pulls fields out of the loosely-typed JSON map
// the transport hands us. We tolerate missing optional fields (they
// fall back to safe defaults) and surface a single error string for
// any required field we couldn't read.
func parseRedeployPayload(payload map[string]interface{}) (redeployInput, error) {
	in := redeployInput{instances: 1, loadBalancer: loadBalancerSpec{typ: "none"}}
	if s, ok := payload["commandId"].(string); ok {
		in.commandID = s
	}
	if s, ok := payload["serviceId"].(string); ok {
		in.serviceID = s
	} else {
		return in, fmt.Errorf("payload missing serviceId")
	}
	if s, ok := payload["serviceName"].(string); ok {
		in.serviceName = s
	}
	if s, ok := payload["buildId"].(string); ok {
		in.buildID = s
	}
	if s, ok := payload["imageRef"].(string); ok && s != "" {
		in.imageRef = s
	} else {
		return in, fmt.Errorf("payload missing imageRef")
	}
	if s, ok := payload["environment"].(string); ok && s != "" {
		in.environment = s
	} else {
		in.environment = "development"
	}
	if s, ok := payload["namespace"].(string); ok {
		in.namespace = s
	}
	if n, ok := payload["instances"].(float64); ok && n >= 0 {
		in.instances = int(n)
	}
	if raw, ok := payload["env"].(map[string]interface{}); ok {
		in.env = make(map[string]string, len(raw))
		for k, v := range raw {
			if s, ok := v.(string); ok {
				in.env[k] = s
			}
		}
	}
	if raw, ok := payload["volumes"].([]interface{}); ok {
		for _, item := range raw {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			v := volumeSpec{}
			if s, ok := m["name"].(string); ok {
				v.name = s
			}
			if nfs, ok := m["nfs"].(map[string]interface{}); ok {
				v.nfsServer, _ = nfs["server"].(string)
				v.nfsPath, _ = nfs["path"].(string)
				v.nfsReadOnly, _ = nfs["readOnly"].(bool)
			}
			if hp, ok := m["hostPath"].(map[string]interface{}); ok {
				v.hostPath, _ = hp["path"].(string)
				v.hostPathTyp, _ = hp["type"].(string)
			}
			if b, ok := m["emptyDir"].(bool); ok {
				v.emptyDir = b
			}
			if pvc, ok := m["persistentVolumeClaim"].(map[string]interface{}); ok {
				v.pvcClaim, _ = pvc["claimName"].(string)
			}
			if mts, ok := m["mounts"].([]interface{}); ok {
				for _, mi := range mts {
					mm, ok := mi.(map[string]interface{})
					if !ok {
						continue
					}
					vm := volumeMountSpec{}
					vm.path, _ = mm["path"].(string)
					vm.subPath, _ = mm["subPath"].(string)
					vm.readOnly, _ = mm["readOnly"].(bool)
					if vm.path != "" {
						v.mounts = append(v.mounts, vm)
					}
				}
			}
			if v.name != "" && len(v.mounts) > 0 {
				in.volumes = append(in.volumes, v)
			}
		}
	}
	if raw, ok := payload["secretEnv"].([]interface{}); ok {
		for _, item := range raw {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			se := secretEnvSpec{}
			se.name, _ = m["name"].(string)
			se.secret, _ = m["secret"].(string)
			se.key, _ = m["key"].(string)
			se.optional, _ = m["optional"].(bool)
			if se.name != "" && se.secret != "" && se.key != "" {
				in.secretEnv = append(in.secretEnv, se)
			}
		}
	}
	if raw, ok := payload["domains"].([]interface{}); ok {
		for _, item := range raw {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			d := domainSpec{}
			if s, ok := m["host"].(string); ok {
				d.host = s
			}
			if n, ok := m["port"].(float64); ok {
				d.port = int(n)
			}
			if s, ok := m["protocol"].(string); ok {
				d.protocol = s
			}
			if d.host != "" && d.port > 0 {
				in.domains = append(in.domains, d)
			}
		}
	}
	if raw, ok := payload["loadBalancer"].(map[string]interface{}); ok {
		if s, ok := raw["type"].(string); ok && s != "" {
			in.loadBalancer.typ = s
		}
		if s, ok := raw["addressPool"].(string); ok {
			in.loadBalancer.addressPool = s
		}
		if s, ok := raw["loadBalancerIPs"].(string); ok {
			in.loadBalancer.loadBalancerIPs = s
		}
		if s, ok := raw["ingressClass"].(string); ok {
			in.loadBalancer.ingressClass = s
		}
		if s, ok := raw["tlsSecret"].(string); ok {
			in.loadBalancer.tlsSecret = s
		}
		if anns, ok := raw["annotations"].(map[string]interface{}); ok {
			in.loadBalancer.annotations = make(map[string]string, len(anns))
			for k, v := range anns {
				if s, ok := v.(string); ok {
					in.loadBalancer.annotations[k] = s
				}
			}
		}
	}
	return in, nil
}

// executeTeardownService is the inverse of redeploy_service — removes
// the workload the agent had previously deployed for this service.
// Triggered by the platform when an operator detaches the service from
// this agent (or deletes the service entirely).
//
// Docker: stop+remove every container labeled
//   kaiad.dev/service-id=<id> AND kaiad.dev/namespace=<ns>
// K8s: kubectl -n <ns> delete deployment/service/ingress for the
//   synthesized resource name (k8sName). All with --ignore-not-found
//   so the operation is idempotent — replays after a partial failure
//   are no-ops once the resources are gone.
//
// Best-effort: even if some resources don't exist or RBAC blocks part
// of the cleanup, we still ack so the platform can drop the
// service_loadbalancer_status row. Anything we couldn't clean up
// shows up in the command_ack output for an operator to chase down.
func (e *Executor) executeTeardownService(
	ctx context.Context,
	backend RuntimeBackend,
	dc *docker.Client,
	payload map[string]interface{},
) CommandResult {
	serviceID, _ := payload["serviceId"].(string)
	if serviceID == "" {
		return CommandResult{Success: false, Output: "teardown_service: payload missing serviceId"}
	}
	serviceName, _ := payload["serviceName"].(string)
	namespace, _ := payload["namespace"].(string)
	environment, _ := payload["environment"].(string)
	log.Printf(
		"[agent:executor] teardown_service backend=%s service=%s name=%s ns=%s env=%s",
		backend, serviceID, serviceName, namespace, environment,
	)
	switch backend {
	case RuntimeDocker:
		return teardownDocker(ctx, dc, serviceID, namespace)
	case RuntimeKubernetes:
		return teardownKubernetes(ctx, serviceID, serviceName, namespace)
	case RuntimeShell:
		return CommandResult{Success: true, Output: "teardown_service: shell mode — nothing to remove"}
	default:
		return CommandResult{
			Success: false,
			Output:  fmt.Sprintf("teardown_service: unsupported runtime backend %q", backend),
		}
	}
}

func teardownDocker(ctx context.Context, dc *docker.Client, serviceID, namespace string) CommandResult {
	if dc == nil {
		return CommandResult{Success: false, Output: "teardown_service: docker client unavailable"}
	}
	if namespace == "" {
		namespace = DefaultDockerNamespace
	}
	// Remove the service's nginx snippet first so the LB stops sending
	// traffic before the upstream containers vanish. The Detach call
	// is best-effort — failures are logged into the output but don't
	// block container teardown.
	lbm := lb.DefaultManager(dc)
	if err := lbm.DetachService(ctx, serviceID, namespace); err != nil {
		log.Printf("[agent:teardown] lb.DetachService(%s): %v", serviceID, err)
	}
	existing, err := dc.ListContainersAll(ctx)
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("list containers: %v", err)}
	}
	var out strings.Builder
	removed := 0
	for _, c := range existing {
		if c.Labels[LabelServiceID] != serviceID {
			continue
		}
		// If the platform sent a namespace, scope the cleanup to that
		// namespace — protects against tearing down the same service
		// id across multiple namespaces accidentally. When the
		// platform doesn't know a namespace yet (legacy row, agent
		// just attached) we fall through and remove anything matching
		// the service id.
		if namespace != DefaultDockerNamespace && c.Labels[LabelNamespace] != "" && c.Labels[LabelNamespace] != namespace {
			continue
		}
		if err := dc.RemoveContainer(ctx, c.ID); err != nil {
			fmt.Fprintf(&out, "remove %s: %v\n", shortID(c.ID), err)
			continue
		}
		fmt.Fprintf(&out, "removed %s (%s)\n", c.Names, shortID(c.ID))
		removed++
	}
	fmt.Fprintf(&out, "teardown ok: %d container(s) removed\n", removed)
	return CommandResult{Success: true, Output: out.String()}
}

// reapOrphanedK8sResources deletes every kaiad-managed k8s resource
// labeled kaiad.dev/service-id=<serviceID> that lives OUTSIDE
// `keepNamespace`. Used after a successful redeploy to clean up a
// namespace change in kaiad.yaml (the old ns is left behind today —
// pods there keep crashing and raising bogus incidents), and as part
// of teardown_service (then keepNamespace="" — sweep everything).
// Failures are captured into `out` but do not abort the sweep —
// orphan cleanup is best-effort.
func reapOrphanedK8sResources(ctx context.Context, serviceID, keepNamespace string, out *strings.Builder) {
	if _, err := exec.LookPath("kubectl"); err != nil {
		fmt.Fprintf(out, "orphan-reap: kubectl not on PATH; skipping\n")
		return
	}
	// One list per kind keeps the parser dumb. Covers every resource
	// the agent's renderK8sManifests creates for a service.
	for _, kind := range []string{"deployment", "service", "ingress", "secret"} {
		lctx, lcancel := context.WithTimeout(ctx, 15*time.Second)
		listCmd := exec.CommandContext(lctx, "kubectl", "get", kind,
			"--all-namespaces", "-l", LabelServiceID+"="+serviceID,
			"-o", "jsonpath={range .items[*]}{.metadata.namespace}\t{.metadata.name}\n{end}")
		listOut, listErr := listCmd.Output()
		lcancel()
		if listErr != nil {
			continue // RBAC / kind-doesn't-apply: skip quietly.
		}
		for _, line := range strings.Split(strings.TrimSpace(string(listOut)), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) != 2 {
				continue
			}
			ns, name := parts[0], parts[1]
			if keepNamespace != "" && ns == keepNamespace {
				continue
			}
			dctx, dcancel := context.WithTimeout(ctx, 30*time.Second)
			delCmd := exec.CommandContext(dctx, "kubectl", "delete", kind, name,
				"-n", ns, "--ignore-not-found=true", "--wait=false")
			delOutput, delErr := delCmd.CombinedOutput()
			dcancel()
			if delErr != nil {
				fmt.Fprintf(out, "orphan-reap %s/%s in ns=%s: ERR %v: %s\n",
					kind, name, ns, delErr, strings.TrimSpace(string(delOutput)))
				log.Printf("[agent:orphan-reap] delete %s/%s ns=%q FAILED: %v: %s",
					kind, name, ns, delErr, strings.TrimSpace(string(delOutput)))
				continue
			}
			fmt.Fprintf(out, "orphan-reap %s/%s in ns=%s: %s\n",
				kind, name, ns, strings.TrimSpace(string(delOutput)))
			log.Printf("[agent:orphan-reap] deleted %s/%s ns=%q (svc=%s keep=%q): %s",
				kind, name, ns, serviceID, keepNamespace, strings.TrimSpace(string(delOutput)))
		}
	}
}

func teardownKubernetes(ctx context.Context, serviceID, serviceName, namespace string) CommandResult {
	if _, err := exec.LookPath("kubectl"); err != nil {
		return CommandResult{Success: false, Output: "teardown_service: kubectl not on PATH"}
	}
	if namespace == "" {
		// Best-effort fallback so we at least try the agent's own ns.
		if b, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
			namespace = strings.TrimSpace(string(b))
		}
		if namespace == "" {
			namespace = "default"
		}
	}
	name := k8sResourceName(serviceID, serviceName)
	log.Printf("[agent:teardown:k8s] start service=%s name=%q ns=%q", serviceID, name, namespace)
	var out strings.Builder
	for _, kind := range []string{"deployment", "service", "ingress"} {
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cmd := exec.CommandContext(cctx, "kubectl", "delete", kind, name, "-n", namespace, "--ignore-not-found=true")
		combined, err := cmd.CombinedOutput()
		cancel()
		fmt.Fprintf(&out, "%s/%s: %s", kind, name, strings.TrimSpace(string(combined)))
		if err != nil {
			fmt.Fprintf(&out, " (err: %v)", err)
			log.Printf("[agent:teardown:k8s] delete %s/%s ns=%q FAILED: %v: %s",
				kind, name, namespace, err, strings.TrimSpace(string(combined)))
		} else {
			log.Printf("[agent:teardown:k8s] delete %s/%s ns=%q: %s",
				kind, name, namespace, strings.TrimSpace(string(combined)))
		}
		out.WriteString("\n")
	}
	// Even after deleting the named-resource trio, OTHER namespaces
	// may still hold older labelled resources (e.g. namespace was
	// changed mid-life). Sweep all of them — teardown means the
	// service is GONE from this agent's perspective.
	reapOrphanedK8sResources(ctx, serviceID, "", &out)
	return CommandResult{Success: true, Output: out.String()}
}

// executeRedeployService is the entry point — dispatches by runtime backend.
func (e *Executor) executeRedeployService(
	ctx context.Context,
	backend RuntimeBackend,
	dc *docker.Client,
	payload map[string]interface{},
) CommandResult {
	in, err := parseRedeployPayload(payload)
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("redeploy_service: %v", err)}
	}
	log.Printf(
		"[agent:executor] redeploy_service backend=%s service=%s image=%s instances=%d env=%s build=%s",
		backend, in.serviceID, in.imageRef, in.instances, in.environment, in.buildID,
	)
	switch backend {
	case RuntimeDocker:
		res := e.redeployDocker(ctx, dc, in)
		log.Printf("[agent:executor] redeploy_service done backend=docker service=%s success=%t", in.serviceID, res.Success)
		return res
	case RuntimeKubernetes:
		res := e.redeployKubernetes(ctx, in)
		log.Printf("[agent:executor] redeploy_service done backend=kubernetes service=%s success=%t", in.serviceID, res.Success)
		return res
	case RuntimeShell:
		return CommandResult{
			Success: false,
			Output:  "redeploy_service: shell runtime is observation-only — nothing to deploy onto",
		}
	default:
		return CommandResult{
			Success: false,
			Output:  fmt.Sprintf("redeploy_service: unsupported runtime backend %q", backend),
		}
	}
}

// ── docker mode ──────────────────────────────────────────────────────────

func (e *Executor) redeployDocker(
	ctx context.Context,
	dc *docker.Client,
	in redeployInput,
) CommandResult {
	if dc == nil {
		return CommandResult{Success: false, Output: "redeploy_service: docker client unavailable"}
	}
	var out strings.Builder
	logf := func(format string, args ...any) {
		fmt.Fprintf(&out, format+"\n", args...)
		log.Printf("[agent:redeploy] "+format, args...)
	}

	// 1) Pull the new image. The kaiad registry needs basic auth — we
	// use admin:dev-token in dev compose and a configurable credential
	// in production via KAIAD_REGISTRY_USER / KAIAD_REGISTRY_PASSWORD.
	auth := registryAuthFromEnv(in.imageRef)
	logf("pulling %s", in.imageRef)
	if err := dc.PullImage(ctx, in.imageRef, auth); err != nil {
		return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("pull failed: %v\n", err)}
	}
	logf("pulled %s", in.imageRef)

	namespace := strings.TrimSpace(in.namespace)
	if namespace == "" {
		namespace = DefaultDockerNamespace
	}

	// 2) Find this service's existing containers and remove them.
	//    Scope by (service-id, namespace) so two services using the
	//    same id in different namespaces don't trample each other.
	existing, err := dc.ListContainersAll(ctx)
	if err != nil {
		return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("list containers: %v\n", err)}
	}
	var toRemove []docker.ContainerInfo
	for _, c := range existing {
		if c.Labels[LabelServiceID] == in.serviceID && c.Labels[LabelNamespace] == namespace {
			toRemove = append(toRemove, c)
		}
	}
	for _, c := range toRemove {
		logf("removing previous replica %s (%s)", shortID(c.ID), c.Image)
		if err := dc.RemoveContainer(ctx, c.ID); err != nil {
			return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("remove %s: %v\n", c.ID, err)}
		}
	}

	// 3) Per-agent LB. The kaiad-lb nginx singleton fronts every
	// service container by name on a shared docker bridge — that
	// removes the old `instances == 1` limitation around host port
	// publishing, because nothing in this path actually publishes to
	// the host anymore. The LB does, on :80, on behalf of every
	// service that has domains.
	lbm := lb.DefaultManager(dc)
	if err := lbm.Ensure(ctx); err != nil {
		// Continue without LB rather than failing the deploy outright —
		// the containers still come up, just unreachable via domains
		// until the LB recovers. Surface the error in the output so
		// it's visible in the build/redeploy log.
		fmt.Fprintf(&out, "[agent:redeploy] lb.Ensure failed (proceeding without LB): %v\n", err)
		log.Printf("[agent:redeploy] lb.Ensure failed: %v", err)
	}

	labels := map[string]string{
		LabelServiceID:   in.serviceID,
		LabelBuildID:     in.buildID,
		LabelEnvironment: in.environment,
		LabelNamespace:   namespace,
	}
	if in.serviceName != "" {
		labels[LabelServiceName] = in.serviceName
	}

	// Build the list of container names ahead of CreateContainer
	// loop so we can hand the same slice to the LB without an extra
	// docker-list round trip after.
	containerNames := make([]string, 0, in.instances)
	// DNS aliases attached to every replica. When the platform sent
	// a service name we register it as a network alias so siblings
	// can dial `http://php` instead of needing to know the UUID-
	// prefixed container name. Docker's embedded DNS round-robins
	// among replicas sharing the alias automatically.
	aliases := []string{}
	if in.serviceName != "" {
		aliases = append(aliases, in.serviceName)
		// Also expose `<svcname>.<namespace>` so callers in a
		// different namespace within the same agent (rare in v1
		// but reasonable in future) can disambiguate.
		if namespace != "" && namespace != DefaultDockerNamespace {
			aliases = append(aliases, fmt.Sprintf("%s.%s", in.serviceName, namespace))
		}
	}
	for i := 0; i < in.instances; i++ {
		// <namespace>-<svc-uuid-short>-<replica> so all containers in
		// one namespace cluster in `docker ps` and the namespace
		// shows up in the container name.
		name := fmt.Sprintf("%s-%s-%d", namespace, shortServiceName(in.serviceID), i)
		containerNames = append(containerNames, name)
		// docker create rejects names that already exist; remove any
		// stale name from a prior run that wasn't caught by label scan.
		_ = dc.RemoveContainer(ctx, name)
		id, err := dc.CreateContainer(ctx, docker.CreateContainerOpts{
			Name:           name,
			Image:          in.imageRef,
			Labels:         labels,
			Restart:        "unless-stopped",
			Network:        lbm.NetworkName(),
			NetworkAliases: aliases,
		})
		if err != nil {
			return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("create %s: %v\n", name, err)}
		}
		if err := dc.StartContainer(ctx, id); err != nil {
			return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("start %s: %v\n", name, err)}
		}
		logf("started %s (%s)", name, shortID(id))
	}

	// Wire (or rewire) the per-service nginx conf so the new replica
	// set takes over instantly. AttachService handles a swap-on-reload
	// with `nginx -t` before reload — if the conf doesn't validate the
	// reload is skipped and the prior conf stays serving.
	port := upstreamPort(in.domains)
	if err := lbm.AttachService(ctx, in.serviceID, in.serviceName, namespace, containerNames, port, toLBDomains(in.domains)); err != nil {
		fmt.Fprintf(&out, "[agent:redeploy] lb.AttachService failed: %v\n", err)
		log.Printf("[agent:redeploy] lb.AttachService failed: %v", err)
	}

	// Report the per-service endpoint to the platform so the panel's
	// Load Balancers page can show domain → host:port for docker
	// agents too. The "external endpoint" is the docker host itself,
	// reachable on the LB's port — surfaced via
	// KAIAD_AGENT_EXTERNAL_HOST or os.Hostname() as a fallback.
	reporter, agentID := e.reporterAndID()
	if reporter != nil {
		report := buildDockerLbStatusReport(agentID, in, namespace, len(in.domains) > 0)
		if err := reporter(report); err != nil {
			fmt.Fprintf(&out, "lb_status_report send failed: %v\n", err)
		}
	}

	return CommandResult{
		Success: true,
		Output: out.String() +
			fmt.Sprintf("redeploy ok: %d replica(s) running %s\n", in.instances, in.imageRef),
	}
}

// buildDockerLbStatusReport mirrors the k8s-mode reporter for docker
// agents. The external endpoint is the per-agent nginx LB sitting on
// the docker host:
//   - KAIAD_AGENT_EXTERNAL_HOST env var if the operator set it (the
//     stable answer — e.g. "edge-01.example.com" or "203.0.113.5")
//   - else os.Hostname() (best-effort; what the kernel reports)
//
// Domains are emitted whenever the kaiad.yaml declared any, because
// the per-agent LB now routes them all (no host-port-collision
// limitation when instances > 1).
func buildDockerLbStatusReport(agentID string, in redeployInput, namespace string, hasDomains bool) map[string]interface{} {
	host := strings.TrimSpace(os.Getenv("KAIAD_AGENT_EXTERNAL_HOST"))
	if host == "" {
		if hn, err := os.Hostname(); err == nil {
			host = hn
		}
	}
	var hostField interface{} = nil
	if host != "" {
		hostField = host
	}

	domains := make([]map[string]interface{}, 0, len(in.domains))
	if hasDomains {
		for _, d := range in.domains {
			domains = append(domains, map[string]interface{}{
				"host":     d.host,
				"port":     d.port,
				"protocol": d.protocol,
			})
		}
	}

	// Ports the LB exposes on the docker host. Only meaningful when
	// the service has domains — without domains the LB has nothing
	// routed for this service and reporting :80 would be misleading.
	ports := make([]map[string]interface{}, 0)
	if hasDomains {
		lbPort := 80
		if v := strings.TrimSpace(os.Getenv("KAIAD_LB_HTTP_PORT")); v != "" {
			var n int
			fmt.Sscanf(v, "%d", &n)
			if n > 0 && n < 65536 {
				lbPort = n
			}
		}
		ports = append(ports, map[string]interface{}{
			"port":       lbPort,
			"protocol":   "TCP",
			"name":       "http",
			"targetPort": upstreamPort(in.domains),
		})
	}

	// lbType: when the kaiad.yaml declares "nginx" we honor it; when
	// it declares "none" but there are still domains, the per-agent
	// LB IS the routing layer for docker-mode, so report "nginx" so
	// the panel groups consistently with the new behaviour.
	lbType := in.loadBalancer.typ
	if hasDomains && lbType == "none" {
		lbType = "nginx"
	}

	detail := map[string]interface{}{}
	if hasDomains {
		detail["lbMode"] = "per-agent-nginx"
	}

	return map[string]interface{}{
		"type":             "lb_status_report",
		"agentId":          agentID,
		"ts":               time.Now().UTC().Format(time.RFC3339Nano),
		"serviceId":        in.serviceID,
		"environment":      in.environment,
		"namespace":        namespace,
		"buildId":          in.buildID,
		"imageRef":         in.imageRef,
		"lbType":           lbType,
		"externalIp":       nil,
		"externalHostname": hostField,
		"ports":            ports,
		"domains":          domains,
		"detail":           detail,
	}
}

// upstreamPort picks the port the LB's nginx proxies to. All domain
// entries in kaiad.yaml SHOULD share a single container port (one
// upstream pool per service); when the user mixes ports the first
// one wins — the platform validates that domain.port appears in
// ports[], so any inconsistency is a kaiad.yaml authoring issue.
func upstreamPort(domains []domainSpec) int {
	for _, d := range domains {
		if d.port > 0 {
			return d.port
		}
	}
	return 0
}

// toLBDomains adapts the executor's domainSpec to the lb package's
// Domain (avoids the lb package importing the executor).
func toLBDomains(in []domainSpec) []lb.Domain {
	out := make([]lb.Domain, 0, len(in))
	for _, d := range in {
		out = append(out, lb.Domain{Host: d.host, Port: d.port, Protocol: d.protocol})
	}
	return out
}

func registryAuthFromEnv(imageRef string) *docker.RegistryAuth {
	user := os.Getenv("KAIAD_REGISTRY_USER")
	pass := os.Getenv("KAIAD_REGISTRY_PASSWORD")
	if user == "" {
		// Dev shortcut. The kaiad registry's /registry/token endpoint
		// accepts admin:dev-token in non-production.
		user = "admin"
		pass = "dev-token"
	}
	srv := registryHostFromImageRef(imageRef)
	return &docker.RegistryAuth{Username: user, Password: pass, ServerAddress: srv}
}

func registryHostFromImageRef(ref string) string {
	// e.g. "panel.dev.kaiad.dev/foo:bar" → "panel.dev.kaiad.dev"
	slash := strings.IndexByte(ref, '/')
	if slash < 0 {
		return ""
	}
	return ref[:slash]
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func shortServiceName(serviceID string) string {
	// First 8 hex chars of the UUID is unique enough for container naming.
	if len(serviceID) > 8 {
		return serviceID[:8]
	}
	return serviceID
}

// ── kubernetes mode ──────────────────────────────────────────────────────

// redeployKubernetes renders Deployment + Service + (optional) Ingress
// manifests and applies them via `kubectl`. The agent's pod is expected
// to ship with kubectl on PATH and a service account that has
// create/update verbs on apps/Deployment, /Service, and
// networking.k8s.io/Ingress — both wired by the operator.
func kubectlRun(ctx context.Context, args []string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func isAlreadyExists(s string) bool {
	return strings.Contains(s, "AlreadyExists") || strings.Contains(s, "already exists")
}

// ensureKubectlCreate runs a `kubectl create …` and logs the outcome.
// Used for namespace + pull-secret self-provisioning, where the agent's
// grant is create-only (no get/patch) so `kubectl apply`
// (read-modify-write) can't be used. Always non-fatal: a genuine RBAC
// failure is logged and the subsequent manifest apply surfaces a clear
// error if it mattered.
//
// If recreateDeleteArgs is non-nil, an AlreadyExists is repaired by
// delete + re-create (so e.g. a pull Secret with stale credentials
// self-heals every deploy — create-only can't overwrite in place). If
// nil, AlreadyExists is simply treated as idempotent success (correct
// for namespaces, whose identity carries no mutable payload).
func ensureKubectlCreate(ctx context.Context, kind, namespace, name string, createArgs, recreateDeleteArgs []string) {
	res, err := kubectlRun(ctx, createArgs)
	switch {
	case err == nil:
		log.Printf("[agent:redeploy:k8s] %s ensured ns=%q name=%q: %s", kind, namespace, name, res)
		return
	case !isAlreadyExists(res):
		log.Printf("[agent:redeploy:k8s] %s ensure FAILED (non-fatal) ns=%q name=%q: %v: %s",
			kind, namespace, name, err, res)
		return
	case recreateDeleteArgs == nil:
		log.Printf("[agent:redeploy:k8s] %s already present ns=%q name=%q (ok)", kind, namespace, name)
		return
	}
	// AlreadyExists + recreate requested: delete then re-create so the
	// payload (e.g. registry creds) is refreshed.
	if dres, derr := kubectlRun(ctx, recreateDeleteArgs); derr != nil {
		log.Printf("[agent:redeploy:k8s] %s recreate: delete FAILED (non-fatal) ns=%q name=%q: %v: %s",
			kind, namespace, name, derr, dres)
		return
	}
	if cres, cerr := kubectlRun(ctx, createArgs); cerr != nil {
		log.Printf("[agent:redeploy:k8s] %s recreate: re-create FAILED (non-fatal) ns=%q name=%q: %v: %s",
			kind, namespace, name, cerr, cres)
	} else {
		log.Printf("[agent:redeploy:k8s] %s recreated ns=%q name=%q (stale payload refreshed)", kind, namespace, name)
	}
}

// ensureNFSDirsExist runs a short-lived Job per (NFS server, parent
// path) referenced by the service's volume set, mkdir-p'ing each leaf
// directory inside the parent BEFORE the Deployment is applied.
//
// Why a Job and not an initContainer on the target Deployment: NFS
// volumes are mounted by the kubelet at the POD level, before any
// container (init or main) starts. A missing leaf on the NFS server
// therefore fails the Pod's setup outright — initContainers never get
// a chance to run. A separate Job that mounts only the parent (which
// IS exported and exists) is the only way to create the leaf from
// inside the cluster.
//
// Best-effort: errors here log and proceed. The kubectl apply that
// follows still attempts the deploy; if the prep didn't take, the Pod
// will surface the same FailedMount in events as before.
func ensureNFSDirsExist(ctx context.Context, namespace, serviceID string, volumes []volumeSpec) {
	type group struct {
		parentMount string              // path to mount in the Job pod, e.g. "/data/"
		leaves      map[string]struct{} // leaf dir names to mkdir within parentMount
	}
	// Group by (server, parent) — typically every volume on a service
	// hangs off the same NFS server + parent dir, so this collapses to
	// one Job. Multiple servers → one Job each.
	groups := map[string]*group{}
	keys := []string{} // deterministic order for the loop below

	for _, v := range volumes {
		if v.nfsServer == "" || v.nfsPath == "" {
			continue
		}
		// path.Dir/Base use forward-slash semantics regardless of host OS
		// (the agent's host is Linux, but NFS paths are POSIX either way).
		// Trim trailing slash so Base("/data/foo/") gives "foo", not "".
		p := strings.TrimRight(v.nfsPath, "/")
		if p == "" || !strings.HasPrefix(p, "/") {
			continue
		}
		parent := path.Dir(p)
		leaf := path.Base(p)
		// `/data` → parent="/", leaf="data". We refuse to mount "/" as
		// the parent (the NFS server almost certainly doesn't export root)
		// and we don't try to mkdir at the export root itself — that
		// directory's existence is the user's problem to provision.
		if parent == "" || parent == "/" || leaf == "" || leaf == "/" || leaf == "." {
			continue
		}
		parentMount := parent + "/"
		key := v.nfsServer + "|" + parentMount
		g, ok := groups[key]
		if !ok {
			g = &group{parentMount: parentMount, leaves: map[string]struct{}{}}
			groups[key] = g
			keys = append(keys, key)
		}
		g.leaves[leaf] = struct{}{}
	}
	if len(groups) == 0 {
		return
	}
	sort.Strings(keys)

	for _, key := range keys {
		g := groups[key]
		server := strings.SplitN(key, "|", 2)[0]

		leaves := make([]string, 0, len(g.leaves))
		for l := range g.leaves {
			leaves = append(leaves, l)
		}
		sort.Strings(leaves)

		// Deterministic 63-char-safe Job name. Hashing (serviceID, server,
		// parent) keeps concurrent mkdir Jobs for distinct services in the
		// same ns from colliding while letting retries of the same service
		// land on the same Job (delete+recreate below makes the retry
		// path idempotent).
		h := sha1.Sum([]byte(serviceID + "|" + server + "|" + g.parentMount))
		jobName := "kaiad-mkdir-" + hex.EncodeToString(h[:])[:12]

		// `set -e` → Job fails fast on the first path that can't be made
		// or chmod'd. After mkdir we `chmod 0777` so service Pods with
		// arbitrary container UIDs (image `USER`, runAsUser) can write —
		// without this, a freshly-mkdir'd NFS dir is mode 0755 owned by
		// whoever the export maps the Job container to (root, or
		// nfsnobody under root_squash), and any other UID gets EACCES.
		// 0777 mirrors the "any-UID can write" expectation of a
		// per-service data volume and matches what an admin would
		// hand-create. `ls -la /mnt` at the end leaves a breadcrumb in
		// the Pod log for `kubectl logs job/<name>` if anyone investigates.
		mkArgs := make([]string, 0, len(leaves))
		for _, l := range leaves {
			mkArgs = append(mkArgs, "/mnt/"+shellQuote(l))
		}
		joined := strings.Join(mkArgs, " ")
		cmd := "set -e; mkdir -p " + joined + "; chmod 0777 " + joined + "; ls -la /mnt"

		// We render and apply rather than driving the API directly:
		// stays in the same kubectl+yaml idiom the rest of this file
		// uses, no extra k8s.io client dependency.
		yamlText := fmt.Sprintf(`apiVersion: batch/v1
kind: Job
metadata:
  name: %s
  namespace: %s
  labels:
    kaiad.dev/service-id: %q
    kaiad.dev/purpose: nfs-mkdir
spec:
  ttlSecondsAfterFinished: 60
  backoffLimit: 0
  completions: 1
  template:
    metadata:
      labels:
        kaiad.dev/purpose: nfs-mkdir
        kaiad.dev/service-id: %q
    spec:
      restartPolicy: Never
      containers:
      - name: mkdir
        image: busybox:1.36
        command: ["sh", "-c", %q]
        volumeMounts:
        - name: nfs-root
          mountPath: /mnt
      volumes:
      - name: nfs-root
        nfs:
          server: %q
          path: %q
`,
			jobName, namespace, serviceID, serviceID, cmd, server, g.parentMount,
		)

		// Pre-delete a stale Job with the same name (`--wait` so the
		// re-create below isn't racing the old Job's finalizers).
		dctx, dcancel := context.WithTimeout(ctx, 15*time.Second)
		_ = exec.CommandContext(dctx, "kubectl", "delete", "job", jobName,
			"-n", namespace,
			"--ignore-not-found=true",
			"--wait=true",
			"--timeout=10s",
		).Run()
		dcancel()

		// Stage + apply.
		dir, err := os.MkdirTemp("", "kaiad-mkdir-")
		if err != nil {
			log.Printf("[agent:redeploy:k8s] nfs mkdir tmpdir err service=%s: %v", serviceID, err)
			continue
		}
		mp := filepath.Join(dir, "mkdir-job.yaml")
		if err := os.WriteFile(mp, []byte(yamlText), 0o600); err != nil {
			log.Printf("[agent:redeploy:k8s] nfs mkdir write err service=%s: %v", serviceID, err)
			os.RemoveAll(dir)
			continue
		}
		actx, acancel := context.WithTimeout(ctx, 20*time.Second)
		aout, aerr := exec.CommandContext(actx, "kubectl", "apply",
			"-n", namespace, "-f", mp,
		).CombinedOutput()
		acancel()
		os.RemoveAll(dir)
		if aerr != nil {
			log.Printf("[agent:redeploy:k8s] nfs mkdir apply FAILED ns=%q job=%q: %v: %s",
				namespace, jobName, aerr, strings.TrimSpace(string(aout)))
			continue
		}

		// Wait for the Job to reach `condition=complete`. mkdir -p over
		// NFS is fast; 60s covers cold-start image pull on the node.
		wctx, wcancel := context.WithTimeout(ctx, 90*time.Second)
		wout, werr := exec.CommandContext(wctx, "kubectl", "wait",
			"--for=condition=complete",
			"--timeout=60s",
			"-n", namespace,
			"job/"+jobName,
		).CombinedOutput()
		wcancel()
		if werr != nil {
			log.Printf("[agent:redeploy:k8s] nfs mkdir wait FAILED ns=%q job=%q server=%s leaves=%v: %v: %s",
				namespace, jobName, server, leaves, werr, strings.TrimSpace(string(wout)))
			continue
		}
		log.Printf("[agent:redeploy:k8s] nfs mkdir OK ns=%q job=%q server=%s parent=%s leaves=%v",
			namespace, jobName, server, g.parentMount, leaves)
	}
}

// shellQuote wraps s in single quotes so a path containing spaces or
// shell metacharacters can be passed safely to `sh -c`. Service /
// directory names in practice are kebab-case, but defending against a
// surprise is cheap.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (e *Executor) redeployKubernetes(ctx context.Context, in redeployInput) CommandResult {
	if _, err := exec.LookPath("kubectl"); err != nil {
		return CommandResult{
			Success: false,
			Output:  "redeploy_service: kubectl not found on PATH (is the agent image up to date?)",
		}
	}

	// Namespace selection priority: kaiad.yaml-resolved (in.namespace) →
	// KAIAD_AGENT_NAMESPACE env → in-cluster service-account ns →
	// "default". The yaml-resolved value lets a single agent deploy
	// services into multiple namespaces based on their environment.
	namespace := strings.TrimSpace(in.namespace)
	if namespace == "" {
		namespace = os.Getenv("KAIAD_AGENT_NAMESPACE")
	}
	if namespace == "" {
		// Standard in-cluster path.
		if b, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
			namespace = strings.TrimSpace(string(b))
		}
	}
	if namespace == "" {
		namespace = "default"
	}

	log.Printf("[agent:redeploy:k8s] start service=%s name=%q ns=%q lb=%s image=%s build=%s",
		in.serviceID, in.serviceName, namespace, in.loadBalancer.typ, in.imageRef, in.buildID)

	// Ensure the target namespace exists. Plain `kubectl create
	// namespace` (NOT `apply`): the agent's grant is namespaces
	// create-only (no get/patch), so apply's read-modify-write would
	// 403. "AlreadyExists" is the idempotent success case. Non-fatal —
	// a genuine failure surfaces on the manifest apply below.
	ensureKubectlCreate(ctx, "namespace", namespace, namespace,
		[]string{"create", "namespace", namespace}, nil)

	// Self-provision the image-pull Secret in the target namespace so
	// private Kaiad-registry images pull with no admin pre-step.
	//
	// Credentials match the panel quickstart's working secret: the Kaiad
	// token-auth registry accepts username "kaiad-agent" + an active
	// enrollment token as the password (the agent has it in
	// SM_ENROLLMENT_TOKEN). registryAuthFromEnv is the fallback, but its
	// dev default (admin/dev-token) is rejected by a production registry,
	// so prefer the enrollment token when present.
	//
	// delete+recreate on AlreadyExists (create-only can't overwrite) so
	// a secret previously written with stale/wrong creds self-heals.
	if ps := strings.TrimSpace(os.Getenv("KAIAD_IMAGE_PULL_SECRET")); ps != "" {
		server := registryHostFromImageRef(in.imageRef)
		user, pass := "kaiad-agent", strings.TrimSpace(os.Getenv("SM_ENROLLMENT_TOKEN"))
		if pass == "" {
			a := registryAuthFromEnv(in.imageRef)
			server, user, pass = a.ServerAddress, a.Username, a.Password
		}
		ensureKubectlCreate(ctx, "pull-secret", namespace, ps,
			[]string{"create", "secret", "docker-registry", ps, "-n", namespace,
				"--docker-server=" + server,
				"--docker-username=" + user,
				"--docker-password=" + pass},
			[]string{"delete", "secret", ps, "-n", namespace, "--ignore-not-found=true"})
	}

	// Pre-flight NFS leaf-directory creation. A Deployment whose Pod
	// references an NFS volume `path: /data/<svc>/` won't even reach the
	// initContainer stage if `/data/<svc>` doesn't exist on the NFS
	// server — the kubelet's pod-level mount fails with
	// `mount.nfs: ... reason given by server: No such file or directory`
	// and the Pod sits in ContainerCreating until someone creates it on
	// the NAS. Run a one-shot Job per NFS server that mounts the parent
	// path read-write and `mkdir -p`s every leaf this Deployment will
	// need. Idempotent (mkdir -p is a no-op on existing dirs); failure
	// here logs and proceeds (the kubectl apply that follows still
	// surfaces the underlying mount error if the prep didn't work).
	ensureNFSDirsExist(ctx, namespace, in.serviceID, in.volumes)

	yaml := renderK8sManifests(in, namespace)

	// Stage to a tmpfile and `kubectl apply -f`. Stays simpler than
	// piping stdin and keeps the manifest visible in the agent log on
	// failure.
	dir, err := os.MkdirTemp("", "kaiad-redeploy-")
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("redeploy_service: mkdir tmp: %v", err)}
	}
	defer os.RemoveAll(dir)
	manifestPath := filepath.Join(dir, "manifests.yaml")
	if err := os.WriteFile(manifestPath, []byte(yaml), 0o600); err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("redeploy_service: write manifest: %v", err)}
	}

	var out strings.Builder
	out.WriteString("rendered manifests:\n")
	out.WriteString(yaml)
	out.WriteString("\n")

	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	// Push the lb_status_report unconditionally on the way out — even
	// when kubectl apply / get fails. This gives the panel's Load
	// Balancers page a row with the configured slice (lbType, ports,
	// domains, namespace) so operators can see WHAT they tried to
	// deploy without waiting for a successful round-trip. externalIp
	// and externalHostname stay nil (rendered as "(pending)") when
	// the cluster hasn't actually assigned them.
	resourceName := k8sResourceName(in.serviceID, in.serviceName)
	var externalIP, externalHostname string
	defer func() {
		reporter, agentID := e.reporterAndID()
		if reporter == nil {
			return
		}
		report := buildLbStatusReport(agentID, in, namespace, externalIP, externalHostname)
		if err := reporter(report); err != nil {
			// Best-effort. We've already returned the CommandResult
			// to the transport at this point so the agent log is the
			// best place to surface the failure.
			log.Printf("[agent:executor] lb_status_report send failed: %v", err)
		} else {
			log.Printf("[agent:redeploy:k8s] lb_status_report sent service=%s ns=%q lb=%s ip=%q host=%q (intent — not a confirmation the manifest applied)",
				in.serviceID, namespace, in.loadBalancer.typ, externalIP, externalHostname)
		}
	}()

	cmd := exec.CommandContext(cctx, "kubectl", "apply", "-n", namespace, "-f", manifestPath)
	combined, err := cmd.CombinedOutput()
	out.Write(combined)
	if err != nil {
		log.Printf("[agent:redeploy:k8s] kubectl apply FAILED service=%s ns=%q resource=%s lb=%s: %v: %s",
			in.serviceID, namespace, resourceName, in.loadBalancer.typ, err, strings.TrimSpace(string(combined)))
		return CommandResult{Success: false, Output: out.String() + fmt.Sprintf("\nkubectl apply: %v\n", err)}
	}
	log.Printf("[agent:redeploy:k8s] kubectl apply OK service=%s ns=%q resource=%s lb=%s: %s",
		in.serviceID, namespace, resourceName, in.loadBalancer.typ, strings.TrimSpace(string(combined)))

	// Reap any labelled resources from a previous namespace — without
	// this, a kaiad.yaml namespace change leaves the old Deployment
	// crashing in the old ns and its pods keep raising incidents.
	reapOrphanedK8sResources(ctx, in.serviceID, namespace, &out)

	externalIP, externalHostname = queryK8sLbAddress(cctx, namespace, in.loadBalancer.typ, resourceName)

	if externalIP != "" || externalHostname != "" {
		log.Printf("[agent:redeploy:k8s] lb endpoint service=%s ns=%q ip=%q host=%q",
			in.serviceID, namespace, externalIP, externalHostname)
		fmt.Fprintf(&out, "\nlb endpoint: %s%s\n", externalIP, externalHostname)
	} else {
		log.Printf("[agent:redeploy:k8s] lb endpoint pending service=%s ns=%q (cluster has not assigned an IP yet)",
			in.serviceID, namespace)
		out.WriteString("\nlb endpoint: (pending; cluster has not assigned an IP yet)\n")
	}
	return CommandResult{Success: true, Output: out.String() + "redeploy ok\n"}
}

// queryK8sLbAddress reads the Service/Ingress that redeployKubernetes
// just applied and pulls out the assigned external IP / hostname from
// status.loadBalancer.ingress. Returns ("", "") for the type=none /
// type=cluster-ip cases or when nothing has been assigned yet.
//
// For nginx, the per-service Service stays ClusterIP; the address we
// want is the Ingress's controller endpoint, so we read the Ingress
// instead.
func queryK8sLbAddress(ctx context.Context, namespace, lbType, name string) (string, string) {
	var resource string
	switch lbType {
	case "k8s", "metallb":
		resource = "svc"
	case "nginx":
		resource = "ingress"
	default:
		return "", ""
	}
	cmd := exec.CommandContext(ctx, "kubectl", "get", resource, name, "-n", namespace, "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		return "", ""
	}
	var parsed struct {
		Status struct {
			LoadBalancer struct {
				Ingress []struct {
					IP       string `json:"ip"`
					Hostname string `json:"hostname"`
				} `json:"ingress"`
			} `json:"loadBalancer"`
		} `json:"status"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return "", ""
	}
	if len(parsed.Status.LoadBalancer.Ingress) == 0 {
		return "", ""
	}
	first := parsed.Status.LoadBalancer.Ingress[0]
	return first.IP, first.Hostname
}

// buildLbStatusReport assembles the JSON payload the platform expects
// to see on the realtime channel as msg.type = "lb_status_report".
// Fields mirror the lbStatusReportSchema in @sm/contracts.
func buildLbStatusReport(agentID string, in redeployInput, namespace, externalIP, externalHostname string) map[string]interface{} {
	domains := make([]map[string]interface{}, 0, len(in.domains))
	for _, d := range in.domains {
		domains = append(domains, map[string]interface{}{
			"host":     d.host,
			"port":     d.port,
			"protocol": d.protocol,
		})
	}
	// Deduplicate ports the same way renderK8sManifests does.
	seen := map[int]bool{}
	ports := make([]map[string]interface{}, 0)
	for _, d := range in.domains {
		if seen[d.port] {
			continue
		}
		seen[d.port] = true
		ports = append(ports, map[string]interface{}{
			"port":       d.port,
			"protocol":   "TCP",
			"targetPort": d.port,
		})
	}

	detail := map[string]interface{}{}
	switch in.loadBalancer.typ {
	case "metallb":
		if in.loadBalancer.addressPool != "" {
			detail["addressPool"] = in.loadBalancer.addressPool
		}
		if in.loadBalancer.loadBalancerIPs != "" {
			detail["loadBalancerIPs"] = in.loadBalancer.loadBalancerIPs
		}
	case "nginx":
		ingressClass := in.loadBalancer.ingressClass
		if ingressClass == "" {
			ingressClass = "nginx"
		}
		detail["ingressClass"] = ingressClass
		if in.loadBalancer.tlsSecret != "" {
			detail["tlsSecret"] = in.loadBalancer.tlsSecret
		}
	case "k8s":
		if len(in.loadBalancer.annotations) > 0 {
			detail["annotations"] = in.loadBalancer.annotations
		}
	}

	var ip interface{} = nil
	var host interface{} = nil
	if externalIP != "" {
		ip = externalIP
	}
	if externalHostname != "" {
		host = externalHostname
	}

	return map[string]interface{}{
		"type":             "lb_status_report",
		"agentId":          agentID,
		"ts":               time.Now().UTC().Format(time.RFC3339Nano),
		"serviceId":        in.serviceID,
		"environment":      in.environment,
		"namespace":        namespace,
		"buildId":          in.buildID,
		"imageRef":         in.imageRef,
		"lbType":           in.loadBalancer.typ,
		"externalIp":       ip,
		"externalHostname": host,
		"ports":            ports,
		"domains":          domains,
		"detail":           detail,
	}
}

// renderK8sManifests builds Deployment + Service + (optional) Ingress
// YAML. Stays a string-builder rather than pulling client-go just for
// serialization — kaiad agent ships with kubectl, and YAML is the
// natural input format.
func renderK8sManifests(in redeployInput, namespace string) string {
	name := k8sResourceName(in.serviceID, in.serviceName)
	labelStr := fmt.Sprintf(
		"%s: %q\n        kaiad.dev/build-id: %q\n        kaiad.dev/environment: %q\n        app.kubernetes.io/name: %q\n        app.kubernetes.io/managed-by: kaiad",
		LabelServiceID, in.serviceID, in.buildID, in.environment, name,
	)

	// Deduplicate ports — multiple domains may share a port.
	portSet := map[int]bool{}
	var ports []int
	for _, d := range in.domains {
		if !portSet[d.port] {
			portSet[d.port] = true
			ports = append(ports, d.port)
		}
	}
	sort.Ints(ports)
	if len(ports) == 0 {
		ports = []int{80}
	}

	var b strings.Builder

	// ─── Deployment ───
	fmt.Fprintf(&b, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: %s\n  namespace: %s\n  labels:\n        %s\nspec:\n  replicas: %d\n",
		name, namespace, labelStr, in.instances)
	fmt.Fprintf(&b, "  selector:\n    matchLabels:\n      %s: %q\n      kaiad.dev/environment: %q\n",
		LabelServiceID, in.serviceID, in.environment)
	fmt.Fprintf(&b, "  template:\n    metadata:\n      labels:\n        %s\n",
		labelStr,
	)
	b.WriteString("    spec:\n")
	// Private service images live in the Kaiad registry (only the
	// kaiad-agent/operator images are forced-public). The operator
	// threads the KaiadAgent CR's pull-secret name through
	// KAIAD_IMAGE_PULL_SECRET so the rendered Deployment can reference
	// it; without this every service pod ErrImagePulls on the private
	// panel.kaiad.dev/<service> image. The secret must exist in the
	// deploy namespace (it does for the agent's own namespace).
	if ps := strings.TrimSpace(os.Getenv("KAIAD_IMAGE_PULL_SECRET")); ps != "" {
		fmt.Fprintf(&b, "      imagePullSecrets:\n        - name: %q\n", ps)
	}
	b.WriteString("      containers:\n        - name: app\n")
	fmt.Fprintf(&b, "          image: %s\n", in.imageRef)
	if len(in.env) > 0 || len(in.secretEnv) > 0 {
		b.WriteString("          env:\n")
		for _, k := range sortedKeys(in.env) {
			fmt.Fprintf(&b, "            - name: %q\n              value: %q\n", k, in.env[k])
		}
		for _, se := range in.secretEnv {
			fmt.Fprintf(&b, "            - name: %q\n              valueFrom:\n                secretKeyRef:\n                  name: %q\n                  key: %q\n",
				se.name, se.secret, se.key)
			if se.optional {
				b.WriteString("                  optional: true\n")
			}
		}
	}
	if len(ports) > 0 {
		b.WriteString("          ports:\n")
		for _, p := range ports {
			fmt.Fprintf(&b, "            - containerPort: %d\n", p)
		}
	}
	if len(in.volumes) > 0 {
		b.WriteString("          volumeMounts:\n")
		for _, v := range in.volumes {
			for _, m := range v.mounts {
				fmt.Fprintf(&b, "            - name: %q\n              mountPath: %q\n", v.name, m.path)
				if m.subPath != "" {
					fmt.Fprintf(&b, "              subPath: %q\n", m.subPath)
				}
				if m.readOnly {
					b.WriteString("              readOnly: true\n")
				}
			}
		}
	}
	if len(in.volumes) > 0 {
		b.WriteString("      volumes:\n")
		for _, v := range in.volumes {
			fmt.Fprintf(&b, "        - name: %q\n", v.name)
			switch {
			case v.nfsServer != "":
				fmt.Fprintf(&b, "          nfs:\n            server: %q\n            path: %q\n", v.nfsServer, v.nfsPath)
				if v.nfsReadOnly {
					b.WriteString("            readOnly: true\n")
				}
			case v.hostPath != "":
				fmt.Fprintf(&b, "          hostPath:\n            path: %q\n", v.hostPath)
				if v.hostPathTyp != "" {
					fmt.Fprintf(&b, "            type: %q\n", v.hostPathTyp)
				}
			case v.pvcClaim != "":
				fmt.Fprintf(&b, "          persistentVolumeClaim:\n            claimName: %q\n", v.pvcClaim)
			default:
				b.WriteString("          emptyDir: {}\n")
			}
		}
	}
	b.WriteString("---\n")

	// ─── Service ───
	svcType := "ClusterIP"
	annotations := map[string]string{}
	switch in.loadBalancer.typ {
	case "k8s":
		svcType = "LoadBalancer"
		for k, v := range in.loadBalancer.annotations {
			annotations[k] = v
		}
	case "metallb":
		svcType = "LoadBalancer"
		if in.loadBalancer.addressPool != "" {
			annotations["metallb.universe.tf/address-pool"] = in.loadBalancer.addressPool
		}
		if in.loadBalancer.loadBalancerIPs != "" {
			annotations["metallb.universe.tf/loadBalancerIPs"] = in.loadBalancer.loadBalancerIPs
		}
	case "nginx", "none":
		// ClusterIP — for nginx, the Ingress fronts it; for none, only
		// in-cluster traffic reaches it.
	}

	fmt.Fprintf(&b, "apiVersion: v1\nkind: Service\nmetadata:\n  name: %s\n  namespace: %s\n", name, namespace)
	if len(annotations) > 0 {
		b.WriteString("  annotations:\n")
		for _, k := range sortedKeys(annotations) {
			fmt.Fprintf(&b, "    %s: %q\n", k, annotations[k])
		}
	}
	fmt.Fprintf(&b, "  labels:\n    %s: %q\n", LabelServiceID, in.serviceID)
	fmt.Fprintf(&b, "spec:\n  type: %s\n  selector:\n    %s: %q\n    kaiad.dev/environment: %q\n",
		svcType, LabelServiceID, in.serviceID, in.environment)
	b.WriteString("  ports:\n")
	for _, p := range ports {
		fmt.Fprintf(&b, "    - name: port-%d\n      port: %d\n      targetPort: %d\n      protocol: TCP\n", p, p, p)
	}
	b.WriteString("---\n")

	// ─── Ingress (nginx only) ───
	if in.loadBalancer.typ == "nginx" && len(in.domains) > 0 {
		ingressClass := in.loadBalancer.ingressClass
		if ingressClass == "" {
			ingressClass = "nginx"
		}
		fmt.Fprintf(&b, "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: %s\n  namespace: %s\n",
			name, namespace)
		fmt.Fprintf(&b, "  labels:\n    %s: %q\nspec:\n  ingressClassName: %s\n",
			LabelServiceID, in.serviceID, ingressClass)
		// Group domains that share TLS.
		if in.loadBalancer.tlsSecret != "" {
			b.WriteString("  tls:\n    - hosts:\n")
			for _, d := range in.domains {
				if d.protocol == "https" {
					fmt.Fprintf(&b, "        - %s\n", d.host)
				}
			}
			fmt.Fprintf(&b, "      secretName: %s\n", in.loadBalancer.tlsSecret)
		}
		b.WriteString("  rules:\n")
		for _, d := range in.domains {
			fmt.Fprintf(&b, "    - host: %s\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\n            backend:\n              service:\n                name: %s\n                port:\n                  number: %d\n",
				d.host, name, d.port)
		}
		b.WriteString("---\n")
	}

	return b.String()
}

func k8sName(serviceID string) string {
	// kaiad-<short-uuid>. Lowercase; no underscores.
	return "kaiad-" + shortServiceName(serviceID)
}

// k8sResourceName picks the metadata.name for Deployment/Service/
// Ingress. When the platform sent a `serviceName`, that wins — the
// Service object gets that as its name, which is what sibling pods
// resolve via in-cluster DNS (`http://<service-name>.<ns>`). Falls
// back to the UUID-derived name for legacy commands.
//
// Sanitizes to RFC 1123 label rules (lowercase alphanumeric +
// hyphens, max 63 chars, must start/end alphanumeric) — that's what
// k8s requires for metadata.name on these object types. If
// sanitization would yield an empty string, we fall back to the
// UUID form rather than letting kubectl reject the manifest.
func k8sResourceName(serviceID, serviceName string) string {
	if serviceName == "" {
		return k8sName(serviceID)
	}
	s := sanitizeK8sName(serviceName)
	if s == "" {
		return k8sName(serviceID)
	}
	return s
}

func sanitizeK8sName(name string) string {
	var b strings.Builder
	prev := byte('-')
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'A' && c <= 'Z':
			c = c + ('a' - 'A')
			b.WriteByte(c)
			prev = c
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'):
			b.WriteByte(c)
			prev = c
		default:
			if prev != '-' && b.Len() > 0 {
				b.WriteByte('-')
				prev = '-'
			}
		}
		if b.Len() >= 63 {
			break
		}
	}
	out := strings.Trim(b.String(), "-")
	// First character must be alphanumeric — Trim handles trailing
	// hyphens but if the input started with digits-only that's fine
	// for RFC 1123, but for k8s `name` the first char must be
	// alphanumeric (a-z or 0-9), so Trim above already covers it.
	return out
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
