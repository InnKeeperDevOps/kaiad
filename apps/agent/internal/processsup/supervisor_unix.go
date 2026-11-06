//go:build !windows

package processsup

import (
	"errors"
	"fmt"
	"syscall"
)

// shellArgv wraps a supervised command for the unix shell.
func shellArgv(command string) []string {
	return []string{"bash", "-c", command}
}

// detachedSysProcAttr makes the child the leader of a new session (and
// process group) so it survives the agent and can be signalled as a group.
func detachedSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// terminateProcessTree sends SIGTERM to the process group led by pid (the
// child was started with Setsid, so its pgid == pid). A group that has
// already exited (ESRCH) is not an error.
func terminateProcessTree(pid int) error {
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return fmt.Errorf("SIGTERM process group %d: %w", pid, err)
	}
	return nil
}
