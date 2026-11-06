//go:build windows

package processsup

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// Windows process-creation flags (see CreateProcess docs). Declared here
// rather than pulling in golang.org/x/sys/windows for two constants.
const (
	createNewProcessGroup = 0x00000200 // CREATE_NEW_PROCESS_GROUP
	detachedProcess       = 0x00000008 // DETACHED_PROCESS
)

// shellArgv wraps a supervised command for Windows. Desired-process
// commands are authored for bash, so prefer bash (Git Bash / MSYS) when
// it's on PATH and fall back to cmd.exe otherwise.
func shellArgv(command string) []string {
	if _, err := exec.LookPath("bash"); err == nil {
		return []string{"bash", "-c", command}
	}
	return []string{"cmd", "/C", command}
}

// detachedSysProcAttr starts the child in its own process group, detached
// from the agent's console, so it survives an agent restart and doesn't
// receive the agent's Ctrl+C/Ctrl+Break.
func detachedSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNewProcessGroup | detachedProcess}
}

// terminateProcessTree force-kills pid and all of its descendants
// (`taskkill /T /F`), the Windows analogue of signalling the unix process
// group. If taskkill fails it falls back to killing just the wrapper via
// Process.Kill, reporting both errors if that fails too. A process that
// no longer exists (taskkill exit 128) is not an error.
func terminateProcessTree(pid int) error {
	out, tkErr := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).CombinedOutput()
	if tkErr == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(tkErr, &exitErr) && exitErr.ExitCode() == 128 {
		return nil
	}
	tkMsg := fmt.Sprintf("taskkill /T /F /PID %d: %v (%s)", pid, tkErr, strings.TrimSpace(string(out)))
	proc, err := os.FindProcess(pid)
	if err != nil {
		return fmt.Errorf("%s; find process: %w", tkMsg, err)
	}
	if err := proc.Kill(); err != nil {
		return fmt.Errorf("%s; kill: %w", tkMsg, err)
	}
	return nil
}
