package executor

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/service-monitor/agent/internal/agentdebug"
	"github.com/service-monitor/agent/internal/docker"
	"github.com/service-monitor/agent/internal/managed"
)

type CommandResult struct {
	Success bool
	Output  string
}

// RuntimeBackend is how Kaiad expects this agent to run workloads (service setting agentRuntimeBackend).
type RuntimeBackend string

const (
	RuntimeDocker       RuntimeBackend = "docker"
	RuntimeKubernetes   RuntimeBackend = "kubernetes"
	RuntimeShell        RuntimeBackend = "shell"
)

// ProcessReconciler is the surface the executor needs from a shell-runtime
// process supervisor. Decoupled via interface so the executor doesn't depend
// on the supervisor package directly (and tests can pass a fake).
type ProcessReconciler interface {
	Reconcile(desired []managed.DesiredProcess)
}

// PlatformReporter is a callback that ships a free-form JSON payload to
// the platform over the existing realtime websocket. Used by command
// handlers (notably redeploy_service) to send observation messages
// like lb_status_report alongside the regular command_ack.
type PlatformReporter func(payload map[string]interface{}) error

type Executor struct {
	mu        sync.RWMutex
	docker    *docker.Client
	backend   RuntimeBackend
	inventory *managed.Inventory
	procSup   ProcessReconciler
	reporter  PlatformReporter
	agentID   string
}

func NewExecutor(dc *docker.Client) *Executor {
	return &Executor{docker: dc, backend: RuntimeDocker}
}

// SetInventory wires a managed-workload store that sync_desired_state updates.
// Optional — when nil, sync_desired_state is a no-op beyond validation.
func (e *Executor) SetInventory(inv *managed.Inventory) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.inventory = inv
}

// SetProcessReconciler wires a shell-runtime process supervisor. When set,
// `sync_desired_state` reconciles desired processes against running ones
// after updating the inventory.
func (e *Executor) SetProcessReconciler(sup ProcessReconciler) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.procSup = sup
}

// SetPlatformReporter wires the callback that command handlers use to
// push observation messages (lb_status_report etc.) back to the
// platform. Optional — handlers fall back gracefully when nil.
func (e *Executor) SetPlatformReporter(r PlatformReporter) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.reporter = r
}

// SetAgentID records the identity the agent uses on the wire so command
// handlers can stamp `agentId` into reporter payloads without each
// caller threading it through.
func (e *Executor) SetAgentID(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.agentID = id
}

func (e *Executor) reporterAndID() (PlatformReporter, string) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.reporter, e.agentID
}

// Configure updates Docker handle, runtime mode, and Kaiad tenant policy after the realtime hello.
func (e *Executor) Configure(dc *docker.Client, backend RuntimeBackend) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.docker = dc
	if backend == "" {
		backend = RuntimeDocker
	}
	e.backend = backend
}

func (e *Executor) runtime() (RuntimeBackend, *docker.Client) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	b := e.backend
	if b == "" {
		b = RuntimeDocker
	}
	return b, e.docker
}

// RunShell preserves the original stub API for backward compatibility.
func RunShell(command string) (string, error) {
	out, err := exec.Command("sh", "-c", command).CombinedOutput()
	return string(out), err
}

func (e *Executor) Execute(ctx context.Context, cmdType string, payload map[string]interface{}) CommandResult {
	backend, dc := e.runtime()
	if b, ok := payload["agentRuntimeBackend"].(string); ok && b != "" {
		backend = RuntimeBackend(b)
	}
	switch cmdType {
	case "run_step":
		return e.executeRunStep(ctx, payload)
	case "docker_op":
		return e.executeDockerOp(ctx, backend, dc, payload)
	case "cancel_run":
		return CommandResult{Success: true, Output: "cancelled"}
	case "sync_desired_state":
		return e.executeSyncDesiredState(payload)
	case "run_toolchain":
		return e.executeRunToolchain(ctx, payload)
	case "receive_source_archive":
		return e.executeReceiveSourceArchive(ctx, payload)
	case "redeploy_service":
		return e.executeRedeployService(ctx, backend, dc, payload)
	case "teardown_service":
		return e.executeTeardownService(ctx, backend, dc, payload)
	case "list_metallb_pool_ips":
		return e.executeListMetalLBPoolIPs(ctx, payload)
	default:
		return CommandResult{Success: false, Output: fmt.Sprintf("unknown command type: %s", cmdType)}
	}
}

// HandleCommand satisfies transport.CommandHandler.
func (e *Executor) HandleCommand(ctx context.Context, cmdType string, payload map[string]interface{}) (bool, string) {
	if agentdebug.Enabled() {
		log.Printf("[agent:executor] HandleCommand type=%s", cmdType)
	}
	r := e.Execute(ctx, cmdType, payload)
	return r.Success, r.Output
}

func (e *Executor) executeRunStep(ctx context.Context, payload map[string]interface{}) CommandResult {
	shell, _ := payload["shell"].(string)
	if shell == "" {
		return CommandResult{Success: false, Output: "missing shell command"}
	}
	cmd := exec.CommandContext(ctx, "sh", "-c", shell)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return CommandResult{Success: false, Output: string(out) + "\n" + err.Error()}
	}
	return CommandResult{Success: true, Output: string(out)}
}

func (e *Executor) executeSyncDesiredState(payload map[string]interface{}) CommandResult {
	raw, ok := payload["desiredContainers"]
	if !ok {
		return CommandResult{Success: false, Output: "missing desiredContainers"}
	}
	list, ok := raw.([]interface{})
	if !ok {
		return CommandResult{Success: false, Output: "desiredContainers must be an array"}
	}
	parsed := make([]managed.DesiredContainer, 0, len(list))
	for _, entry := range list {
		m, ok := entry.(map[string]interface{})
		if !ok {
			continue
		}
		sid, _ := m["serviceId"].(string)
		img, _ := m["image"].(string)
		state, _ := m["state"].(string)
		parsed = append(parsed, managed.DesiredContainer{ServiceID: sid, Image: img, State: state})
	}

	var processes []managed.DesiredProcess
	if rawProcs, ok := payload["desiredProcesses"].([]interface{}); ok {
		processes = make([]managed.DesiredProcess, 0, len(rawProcs))
		for _, entry := range rawProcs {
			m, ok := entry.(map[string]interface{})
			if !ok {
				continue
			}
			sid, _ := m["serviceId"].(string)
			pattern, _ := m["commandPattern"].(string)
			state, _ := m["state"].(string)
			command, _ := m["command"].(string)
			logPath, _ := m["logPath"].(string)
			cwd, _ := m["cwd"].(string)
			processes = append(processes, managed.DesiredProcess{
				ServiceID:      sid,
				CommandPattern: pattern,
				State:          state,
				Command:        command,
				LogPath:        logPath,
				Cwd:            cwd,
			})
		}
	}

	e.mu.RLock()
	inv := e.inventory
	sup := e.procSup
	e.mu.RUnlock()
	if inv != nil {
		inv.ReplaceDesired(parsed)
		inv.ReplaceDesiredProcesses(processes)
	}
	log.Printf("executor.sync_desired_state: parsed %d containers, %d processes; sup=%v", len(parsed), len(processes), sup != nil)
	if sup != nil {
		sup.Reconcile(processes)
	}
	return CommandResult{Success: true, Output: fmt.Sprintf("sync_desired_state: %d containers, %d processes", len(parsed), len(processes))}
}

func (e *Executor) executeDockerOp(ctx context.Context, backend RuntimeBackend, dc *docker.Client, payload map[string]interface{}) CommandResult {
	switch backend {
	case RuntimeShell:
		return CommandResult{
			Success: false,
			Output:  `docker_op is disabled: tenant agent runtime is "shell" (change agent runtime in Kaiad tenant settings)`,
		}
	case RuntimeKubernetes:
		return CommandResult{
			Success: false,
			Output:  `docker_op is not mapped for "kubernetes" runtime yet; use run_step with kubectl`,
		}
	default:
		if dc == nil {
			return CommandResult{Success: false, Output: "docker client not configured"}
		}
	}
	operation, _ := payload["operation"].(string)
	args, _ := payload["args"].(map[string]interface{})
	if args == nil {
		args = make(map[string]interface{})
	}

	switch operation {
	case "start":
		id, _ := args["container"].(string)
		if id == "" {
			return CommandResult{Success: false, Output: "missing container id"}
		}
		if err := dc.StartContainer(ctx, id); err != nil {
			return CommandResult{Success: false, Output: err.Error()}
		}
		return CommandResult{Success: true, Output: "container started"}
	case "stop":
		id, _ := args["container"].(string)
		if id == "" {
			return CommandResult{Success: false, Output: "missing container id"}
		}
		if err := dc.StopContainer(ctx, id); err != nil {
			return CommandResult{Success: false, Output: err.Error()}
		}
		return CommandResult{Success: true, Output: "container stopped"}
	case "build", "run", "compose_up", "compose_down":
		return e.executeDockerCLI(ctx, operation, args)
	default:
		return CommandResult{Success: false, Output: fmt.Sprintf("unknown docker operation: %s", operation)}
	}
}

func (e *Executor) executeDockerCLI(ctx context.Context, operation string, args map[string]interface{}) CommandResult {
	var cmdStr string
	switch operation {
	case "build":
		path, _ := args["path"].(string)
		if path == "" {
			path = "."
		}
		tag, _ := args["tag"].(string)
		if tag != "" {
			cmdStr = fmt.Sprintf("docker build -t %s %s", tag, path)
		} else {
			cmdStr = fmt.Sprintf("docker build %s", path)
		}
	case "run":
		image, _ := args["image"].(string)
		cmdStr = fmt.Sprintf("docker run %s", image)
	case "compose_up":
		file, _ := args["file"].(string)
		if file != "" {
			cmdStr = fmt.Sprintf("docker-compose -f %s up -d", file)
		} else {
			cmdStr = "docker-compose up -d"
		}
	case "compose_down":
		file, _ := args["file"].(string)
		if file != "" {
			cmdStr = fmt.Sprintf("docker-compose -f %s down", file)
		} else {
			cmdStr = "docker-compose down"
		}
	}

	parts := strings.Fields(cmdStr)
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return CommandResult{Success: false, Output: string(out) + "\n" + err.Error()}
	}
	return CommandResult{Success: true, Output: string(out)}
}

func ensureWorkspace(path string) (string, error) {
	if path == "" {
		path = "/tmp/service-monitor-agent/workspace"
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", err
	}
	return abs, nil
}

func stringValue(v interface{}) string {
	s, _ := v.(string)
	return s
}
