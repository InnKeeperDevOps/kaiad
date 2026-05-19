// Package logship buffers recent log lines per service and emits an
// app_log_error realtime frame whenever an error-level line is observed.
// The frame includes the last N lines of context so the platform can
// fingerprint and act on the error without a separate log lookup.
package logship

import (
	"regexp"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

// burstWindow bounds how long a single error "burst" (one stack trace /
// incident) can absorb following error lines. A genuinely new error
// arriving after this many seconds starts a fresh incident even if the
// log never produced a clean line in between (defensive — normally a
// non-continuation line closes the burst far sooner).
const burstWindow = 20 * time.Second

// continuationRe matches lines that are part of an in-progress stack
// trace rather than a new log record: JVM frames ("\tat ..."),
// "Caused by:", "... 12 more", "Suppressed:", Python "Traceback"/
// "  File ..." and Go "goroutine"/tab frames. Such lines must NOT end
// an error burst (they belong to the same incident) and must not spawn
// their own incident.
var continuationRe = regexp.MustCompile(
	`^(\s+at\s|at\s+[\w$.]+\(|Caused by:|\.\.\.\s+\d+\s+more|Suppressed:|Traceback \(most recent call last\):|\s*File ".*", line \d+|goroutine \d+|\s+\w+\.\w+|\s*$)`,
)

// isContinuation reports whether a line continues the current stack
// trace rather than starting a new log record. Leading whitespace is a
// strong signal (almost every multi-line trace indents continuations).
func isContinuation(line string) bool {
	if line == "" {
		return true
	}
	if line[0] == ' ' || line[0] == '\t' {
		return true
	}
	return continuationRe.MatchString(line)
}

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
// the last `capacity` lines of context.
// burst tracks an in-progress error burst for one service. While
// active, additional error/continuation lines are folded into the
// already-emitted incident instead of each becoming its own.
type burst struct {
	active    bool
	startedAt time.Time
}

type Sender struct {
	inner     docker.LogSender
	errSender ErrorFrameSender
	capacity  int
	mu        sync.Mutex
	buffers   map[string]*ringBuffer
	bursts    map[string]*burst
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
		bursts:    make(map[string]*burst),
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

func (s *Sender) burstFor(serviceID string) *burst {
	b, ok := s.bursts[serviceID]
	if !ok {
		b = &burst{}
		s.bursts[serviceID] = b
	}
	return b
}

// SendLogEvent satisfies docker.LogSender. It records the line in the buffer
// for `serviceID`, emits an `app_log_error` frame on error-level lines, and
// then forwards the line to the wrapped sender so the existing log_event
// pipeline is unchanged.
func (s *Sender) SendLogEvent(agentID, serviceID, level, message string) error {
	isErr := level == "error" || level == "fatal"
	now := time.Now()

	s.mu.Lock()
	s.bufferFor(serviceID).push(message)
	b := s.burstFor(serviceID)

	// A burst that has run past its window is considered closed, so a
	// later error opens a fresh incident even without an intervening
	// clean line.
	if b.active && now.Sub(b.startedAt) > burstWindow {
		b.active = false
	}

	var ctx []string
	if isErr {
		if !b.active {
			// First error line of this burst — THE incident. One
			// stack trace ⇒ one app_log_error: the representative is
			// this line, every following error / "Caused by:" / frame
			// is folded into the same incident (suppressed below).
			b.active = true
			b.startedAt = now
			ctx = s.bufferFor(serviceID).snapshot()
		}
		// else: still inside the burst — suppress (no new frame).
	} else if b.active && !isContinuation(message) {
		// A normal log record after the trace ⇒ the burst is over.
		// The next error starts a new incident.
		b.active = false
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
