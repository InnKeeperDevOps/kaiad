// Package selflog captures the kaiad-agent's OWN process log output and
// ships it to the control plane as agent_log frames, so the panel can
// surface agent behaviour without kubectl. Wrap the stdlib logger with
// io.MultiWriter(os.Stderr, shipper) — logs still reach the pod's
// stdout AND the panel.
package selflog

import (
	"strings"
	"sync"
	"time"

	"github.com/service-monitor/agent/internal/transport"
)

const (
	flushInterval = 2 * time.Second
	// maxBatch bounds one agent_log frame. The wire schema caps lines at
	// 500; stay well under so a frame is never rejected.
	maxBatch = 200
	// maxBuffer caps un-shipped lines while disconnected; oldest dropped.
	maxBuffer = 2000
)

// Shipper is an io.Writer that batches the lines written to it and ships
// them via the supplied send func (transport.Client.SendAgentLog).
type Shipper struct {
	send     func([]transport.AgentLogLine) error
	mu       sync.Mutex
	buf      []transport.AgentLogLine
	partial  string // unterminated tail carried across Write calls
	done     chan struct{}
	stopOnce sync.Once
}

// New starts a Shipper with a background flush loop.
func New(send func([]transport.AgentLogLine) error) *Shipper {
	s := &Shipper{send: send, done: make(chan struct{})}
	go s.run()
	return s
}

// Write implements io.Writer. The stdlib logger writes one record per
// call, but we still split on newlines defensively.
func (s *Shipper) Write(p []byte) (int, error) {
	s.mu.Lock()
	s.partial += string(p)
	for {
		i := strings.IndexByte(s.partial, '\n')
		if i < 0 {
			break
		}
		line := s.partial[:i]
		s.partial = s.partial[i+1:]
		if strings.TrimSpace(line) != "" {
			s.buf = append(s.buf, transport.AgentLogLine{
				Ts:      time.Now().UTC().Format(time.RFC3339Nano),
				Level:   classify(line),
				Message: line,
			})
		}
	}
	if len(s.buf) > maxBuffer {
		s.buf = s.buf[len(s.buf)-maxBuffer:]
	}
	s.mu.Unlock()
	return len(p), nil
}

// Close stops the flush loop after a final flush.
func (s *Shipper) Close() {
	s.stopOnce.Do(func() { close(s.done) })
}

func (s *Shipper) run() {
	t := time.NewTicker(flushInterval)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			s.flush()
			return
		case <-t.C:
			s.flush()
		}
	}
}

func (s *Shipper) flush() {
	s.mu.Lock()
	if len(s.buf) == 0 {
		s.mu.Unlock()
		return
	}
	n := len(s.buf)
	if n > maxBatch {
		n = maxBatch
	}
	// Detach the batch from buf before the (network) send so Write never
	// blocks on I/O. On failure the batch is re-queued at the front.
	batch := append([]transport.AgentLogLine(nil), s.buf[:n]...)
	s.buf = s.buf[n:]
	s.mu.Unlock()

	if err := s.send(batch); err != nil {
		s.mu.Lock()
		s.buf = append(batch, s.buf...)
		if len(s.buf) > maxBuffer {
			s.buf = s.buf[len(s.buf)-maxBuffer:]
		}
		s.mu.Unlock()
		// Deliberately no log here — that would recurse into Write.
	}
}

// classify maps a log line to a coarse level. Agent logs rarely carry an
// explicit level, so this is keyword-based and best-effort.
func classify(line string) string {
	l := strings.ToLower(line)
	switch {
	case strings.Contains(l, "panic") || strings.Contains(l, "fatal"):
		return "fatal"
	case strings.Contains(l, "error") || strings.Contains(l, "failed") || strings.Contains(l, "err="):
		return "error"
	case strings.Contains(l, "warn"):
		return "warn"
	default:
		return "info"
	}
}
