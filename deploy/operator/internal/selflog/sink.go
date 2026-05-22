// Package selflog captures the kaiad-operator's OWN log output and ships
// it to the Kaiad API as operator log lines, so the panel can surface
// operator behaviour without kubectl. Wrap the controller-runtime zap
// logger with zap.WriteTo(io.MultiWriter(os.Stderr, sink)) — logs still
// reach the pod's stderr AND the panel.
package selflog

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/innkeeperdevops/kaiad/operator/internal/kaiad"
)

const (
	flushInterval = 3 * time.Second
	// maxBatch bounds one POST body.
	maxBatch = 200
	// maxBuffer caps un-shipped lines while the API is unreachable.
	maxBuffer   = 2000
	postTimeout = 15 * time.Second
)

// Sink is an io.Writer that batches the operator's log lines and POSTs
// them to the Kaiad API.
type Sink struct {
	client   *kaiad.Client
	mu       sync.Mutex
	buf      []kaiad.OperatorLogLine
	partial  string // unterminated tail carried across Write calls
	done     chan struct{}
	stopOnce sync.Once
}

// New starts a Sink with a background flush loop.
func New(client *kaiad.Client) *Sink {
	s := &Sink{client: client, done: make(chan struct{})}
	go s.run()
	return s
}

// Write implements io.Writer; zap calls it once per record.
func (s *Sink) Write(p []byte) (int, error) {
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
			s.buf = append(s.buf, parseLine(line))
		}
	}
	if len(s.buf) > maxBuffer {
		s.buf = s.buf[len(s.buf)-maxBuffer:]
	}
	s.mu.Unlock()
	return len(p), nil
}

// Close stops the flush loop after a final flush.
func (s *Sink) Close() {
	s.stopOnce.Do(func() { close(s.done) })
}

func (s *Sink) run() {
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

func (s *Sink) flush() {
	s.mu.Lock()
	if len(s.buf) == 0 {
		s.mu.Unlock()
		return
	}
	n := len(s.buf)
	if n > maxBatch {
		n = maxBatch
	}
	batch := append([]kaiad.OperatorLogLine(nil), s.buf[:n]...)
	s.buf = s.buf[n:]
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), postTimeout)
	err := s.client.PostOperatorLogs(ctx, batch)
	cancel()
	if err != nil {
		// API unreachable — re-queue at the front for the next tick. No
		// logging here: that would recurse into Write.
		s.mu.Lock()
		s.buf = append(batch, s.buf...)
		if len(s.buf) > maxBuffer {
			s.buf = s.buf[len(s.buf)-maxBuffer:]
		}
		s.mu.Unlock()
	}
}

// zapRecord is the subset of a controller-runtime zap JSON record used.
type zapRecord struct {
	Level string `json:"level"`
	Ts    string `json:"ts"`
	Msg   string `json:"msg"`
}

// parseLine turns a zap JSON log record into an OperatorLogLine,
// falling back to the raw text for non-JSON output (e.g. klog).
func parseLine(line string) kaiad.OperatorLogLine {
	var rec zapRecord
	if err := json.Unmarshal([]byte(line), &rec); err == nil && rec.Msg != "" {
		ts := time.Now().UTC()
		if parsed, perr := time.Parse(time.RFC3339, rec.Ts); perr == nil {
			ts = parsed.UTC()
		}
		level := rec.Level
		if level == "" {
			level = "info"
		}
		return kaiad.OperatorLogLine{
			Ts:      ts.Format(time.RFC3339Nano),
			Level:   level,
			Message: rec.Msg,
		}
	}
	return kaiad.OperatorLogLine{
		Ts:      time.Now().UTC().Format(time.RFC3339Nano),
		Level:   "info",
		Message: line,
	}
}
