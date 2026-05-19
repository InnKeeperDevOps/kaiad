// Package logship buffers log lines per service and emits an
// app_log_error realtime frame for a crash. The frame must carry the
// WHOLE error — for a JVM/Spring failure the actionable part is the
// "Caused by: ... Exception" chain that prints AFTER the first ERROR
// line, so emitting on the first line with only the preceding ring
// buffer (as an earlier version did) shipped a vague "Application run
// failed" with none of the exception → the autonomous fixer had
// nothing to work with. Instead we accumulate the error burst (the
// stack trace) and emit ONE frame whose message is the most specific
// cause and whose context is pre-error lines + the full trace.
package logship

import (
	"regexp"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/docker"
)

// incidentWindow: after a burst is emitted, further errors for that
// service within this long are folded into the same incident (the
// crash-loop replays the same trace every few seconds; the platform
// also dedupes by fingerprint).
const incidentWindow = 2 * time.Minute

// maxHold: emit a burst at the latest this long after it started even
// if no terminating "fresh log line" arrived (quiescent crash, or the
// process exited mid-trace). A full JVM stack prints well within this.
const maxHold = 8 * time.Second

// maxBurstLines bounds a single incident's captured trace.
const maxBurstLines = 400

// preContextLines kept from before the first error line.
const preContextLines = 20

var continuationRe = regexp.MustCompile(
	`^(\s+|at\s+\S|Caused by:|\.\.\.\s+\d+\s+more|Suppressed:|Traceback \(most recent call last\):|\s*File ".*", line \d+|goroutine \d+|\s*$)`,
)

// freshLogRe marks the start of a new log record (timestamp or level
// prefix). A NON-error fresh record ends an error burst.
var freshLogRe = regexp.MustCompile(
	`^(\d{4}-\d{2}-\d{2}[T ]|\d{2}:\d{2}:\d{2}|\[?(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b)`,
)

func isContinuation(line string) bool {
	if line == "" {
		return true
	}
	if line[0] == ' ' || line[0] == '\t' {
		return true
	}
	return continuationRe.MatchString(line)
}

func isFreshLogRecord(line string) bool {
	return freshLogRe.MatchString(line)
}

// pickRepresentative chooses the message that best identifies the bug:
// the deepest "Caused by:", else the last Exception/ERROR line, else
// the first line. Server-side normalization strips volatile bits, so a
// specific cause yields a stable AND meaningful fingerprint/prompt.
func pickRepresentative(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	best := lines[0]
	for _, l := range lines {
		switch {
		case len(l) >= 10 && l[:10] == "Caused by:":
			best = l
		case (containsFold(l, "Exception") || containsFold(l, "Error:")) &&
			!(len(best) >= 10 && best[:10] == "Caused by:"):
			best = l
		}
	}
	return best
}

func containsFold(s, sub string) bool {
	return len(s) >= len(sub) && regexp.MustCompile(`(?i)`+regexp.QuoteMeta(sub)).MatchString(s)
}

// ErrorFrameSender writes an `app_log_error` frame to the realtime channel.
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

func tail(s []string, n int) []string {
	if len(s) <= n {
		return append([]string(nil), s...)
	}
	return append([]string(nil), s[len(s)-n:]...)
}

// burst is an in-progress error accumulation for one service.
type burst struct {
	agentID   string
	preCtx    []string
	lines     []string
	startedAt time.Time
}

type Sender struct {
	inner     docker.LogSender
	errSender ErrorFrameSender
	capacity  int
	mu        sync.Mutex
	buffers   map[string]*ringBuffer
	pending   map[string]*burst
	// lastEmit: most recent emission per service (incidentWindow debounce).
	lastEmit map[string]time.Time
	now      func() time.Time
	done     chan struct{}
	stopOnce sync.Once
}

// NewSender constructs a buffering log sender. Capacity is the ring
// buffer size kept per service for pre-error context. When errSender is
// nil, only the wrapped log_event flow runs.
func NewSender(inner docker.LogSender, errSender ErrorFrameSender, capacity int) *Sender {
	s := &Sender{
		inner:     inner,
		errSender: errSender,
		capacity:  capacity,
		buffers:   make(map[string]*ringBuffer),
		pending:   make(map[string]*burst),
		lastEmit:  make(map[string]time.Time),
		now:       time.Now,
		done:      make(chan struct{}),
	}
	if errSender != nil {
		go s.flushLoop()
	}
	return s
}

// Close stops the background flusher. Optional; the agent process runs
// for its lifetime so main never needs to call this.
func (s *Sender) Close() {
	s.stopOnce.Do(func() { close(s.done) })
}

func (s *Sender) flushLoop() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			for _, e := range s.collectAged() {
				_ = s.errSender.SendAppLogError(e.agentID, e.serviceID, e.message, e.context, e.ts)
			}
		}
	}
}

type emission struct {
	agentID, serviceID, message, ts string
	context                         []string
}

func (s *Sender) bufferFor(serviceID string) *ringBuffer {
	rb, ok := s.buffers[serviceID]
	if !ok {
		rb = newRing(s.capacity)
		s.buffers[serviceID] = rb
	}
	return rb
}

func makeEmission(serviceID string, b *burst, at time.Time) emission {
	ctx := append(tail(b.preCtx, preContextLines), b.lines...)
	return emission{
		agentID:   b.agentID,
		serviceID: serviceID,
		message:   pickRepresentative(b.lines),
		context:   tail(ctx, maxBurstLines),
		ts:        at.UTC().Format(time.RFC3339Nano),
	}
}

// collectAged detaches bursts past maxHold (called by the flusher).
func (s *Sender) collectAged() []emission {
	now := s.now()
	var out []emission
	s.mu.Lock()
	for svc, b := range s.pending {
		if now.Sub(b.startedAt) >= maxHold {
			out = append(out, makeEmission(svc, b, now))
			delete(s.pending, svc)
			s.lastEmit[svc] = now
		}
	}
	s.mu.Unlock()
	return out
}

// SendLogEvent satisfies docker.LogSender. It accumulates an error
// burst and emits a single app_log_error carrying the full trace when
// the burst ends (a fresh non-error log line, a size cap, or maxHold
// via the flusher). At most one incident per service per incidentWindow.
func (s *Sender) SendLogEvent(agentID, serviceID, level, message string) error {
	isErr := level == "error" || level == "fatal"
	now := s.now()

	var emit *emission
	s.mu.Lock()
	rb := s.bufferFor(serviceID)
	if b, ok := s.pending[serviceID]; ok {
		// Inside a burst: keep the trace together.
		ended := !isErr && isFreshLogRecord(message) && !isContinuation(message)
		if !ended {
			if len(b.lines) < maxBurstLines {
				b.lines = append(b.lines, message)
			}
			rb.push(message)
			if len(b.lines) >= maxBurstLines {
				e := makeEmission(serviceID, b, now)
				emit = &e
				delete(s.pending, serviceID)
				s.lastEmit[serviceID] = now
			}
		} else {
			// A normal log record resumed → the trace is complete.
			e := makeEmission(serviceID, b, now)
			emit = &e
			delete(s.pending, serviceID)
			s.lastEmit[serviceID] = now
			rb.push(message)
		}
	} else if isErr {
		last, seen := s.lastEmit[serviceID]
		if !seen || now.Sub(last) > incidentWindow {
			// Start a new burst. preCtx = lines before this one.
			s.pending[serviceID] = &burst{
				agentID:   agentID,
				preCtx:    rb.snapshot(),
				lines:     []string{message},
				startedAt: now,
			}
		}
		rb.push(message)
	} else {
		rb.push(message)
	}
	s.mu.Unlock()

	if emit != nil && s.errSender != nil {
		_ = s.errSender.SendAppLogError(emit.agentID, emit.serviceID, emit.message, emit.context, emit.ts)
	}
	if s.inner == nil {
		return nil
	}
	return s.inner.SendLogEvent(agentID, serviceID, level, message)
}
