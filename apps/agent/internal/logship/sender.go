// Package logship buffers recent log lines per service and emits an
// app_log_error realtime frame whenever an error-level line is observed.
// The frame includes the last N lines of context so the platform can
// fingerprint and act on the error without a separate log lookup.
package logship

import (
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

// incidentWindow is how long, after emitting an app_log_error for a
// service, further error lines for that same service are folded into
// that one incident instead of each spawning its own.
//
// A crash is not one tidy contiguous block: a JVM/Spring failure
// interleaves the top ERROR, several "Caused by:" exceptions, frames,
// and the wrapped failing SQL; the same service often has several
// replicas streaming concurrently into one logical service; and a
// CrashLoopBackOff replays the whole trace every few seconds. Trying to
// detect trace boundaries line-by-line is unreliable against all three.
// A per-service time debounce collapses the entire crash (and the
// crash-loop's repeats) into a single incident regardless of ordering —
// the platform additionally dedupes by error fingerprint, so a still-
// failing service refreshes the same incident rather than piling up.
const incidentWindow = 2 * time.Minute

// ErrorFrameSender writes an `app_log_error` frame to the realtime channel.
// The transport.Client implements this in addition to docker.LogSender.
type ErrorFrameSender interface {
	SendAppLogError(agentID, serviceID, message string, contextLines []string, ts string) error
}

type ringBuffer struct {
	lines []string
	head  int
	full  bool
}

func newRing(capacity int) *ringBuffer {
	if capacity <= 0 {
		capacity = 1
	}
	return &ringBuffer{lines: make([]string, capacity)}
}

func (r *ringBuffer) push(line string) {
	r.lines[r.head] = line
	r.head++
	if r.head >= len(r.lines) {
		r.head = 0
		r.full = true
	}
}

func (r *ringBuffer) snapshot() []string {
	if !r.full {
		out := make([]string, r.head)
		copy(out, r.lines[:r.head])
		return out
	}
	out := make([]string, len(r.lines))
	n := copy(out, r.lines[r.head:])
	copy(out[n:], r.lines[:r.head])
	return out
}

// Sender wraps a docker.LogSender. It records every line in a per-service
// ring buffer and, on error/fatal, emits an `app_log_error` frame carrying
// the last `capacity` lines of context — at most one per service per
// incidentWindow so a whole stack trace is a single incident.
type Sender struct {
	inner     docker.LogSender
	errSender ErrorFrameSender
	capacity  int
	mu        sync.Mutex
	buffers   map[string]*ringBuffer
	// lastEmit is the time of the most recent app_log_error emitted for
	// a service. Error lines arriving within incidentWindow of it are
	// suppressed (folded into that incident).
	lastEmit map[string]time.Time
	// now is overridable in tests for deterministic window assertions.
	now func() time.Time
}

// NewSender constructs a buffering log sender. Capacity is the number of
// context lines kept per service (50 in production). When errSender is nil,
// only the wrapped log_event flow runs (back-compat with hosts that have not
// yet upgraded the platform).
func NewSender(inner docker.LogSender, errSender ErrorFrameSender, capacity int) *Sender {
	return &Sender{
		inner:     inner,
		errSender: errSender,
		capacity:  capacity,
		buffers:   make(map[string]*ringBuffer),
		lastEmit:  make(map[string]time.Time),
		now:       time.Now,
	}
}

func (s *Sender) bufferFor(serviceID string) *ringBuffer {
	rb, ok := s.buffers[serviceID]
	if !ok {
		rb = newRing(s.capacity)
		s.buffers[serviceID] = rb
	}
	return rb
}

// SendLogEvent satisfies docker.LogSender. It records the line in the
// buffer for `serviceID`, emits at most one `app_log_error` frame per
// service per incidentWindow (so an entire stack trace — and the
// crash-loop's repeats — is a single incident), and forwards the line
// to the wrapped sender so the existing log_event pipeline is unchanged.
func (s *Sender) SendLogEvent(agentID, serviceID, level, message string) error {
	isErr := level == "error" || level == "fatal"
	now := s.now()

	s.mu.Lock()
	s.bufferFor(serviceID).push(message)
	var ctx []string
	if isErr {
		last, seen := s.lastEmit[serviceID]
		if !seen || now.Sub(last) > incidentWindow {
			// First error of a new incident window — THE incident.
			// Every error line that follows within the window (the
			// rest of the trace, "Caused by:", replicas, crash-loop
			// replays) is folded into it.
			s.lastEmit[serviceID] = now
			ctx = s.bufferFor(serviceID).snapshot()
		}
		// else: within the window — suppress (one incident).
	}
	s.mu.Unlock()

	if ctx != nil && s.errSender != nil {
		_ = s.errSender.SendAppLogError(agentID, serviceID, message, ctx, now.UTC().Format(time.RFC3339Nano))
	}
	if s.inner == nil {
		return nil
	}
	return s.inner.SendLogEvent(agentID, serviceID, level, message)
}
