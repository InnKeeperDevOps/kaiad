package logship

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type capturedErr struct {
	agentID, serviceID, message string
	contextLines                []string
}

type fakeInner struct {
	mu   sync.Mutex
	logs int
}

func (f *fakeInner) SendLogEvent(_, _, _, _ string) error {
	f.mu.Lock()
	f.logs++
	f.mu.Unlock()
	return nil
}

type fakeErr struct {
	mu   sync.Mutex
	errs []capturedErr
}

func (f *fakeErr) SendAppLogError(agentID, serviceID, message string, contextLines []string, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs = append(f.errs, capturedErr{agentID, serviceID, message, append([]string(nil), contextLines...)})
	return nil
}

func (f *fakeErr) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.errs)
}

// flush drains the bursts the background flusher would have emitted by
// now — the tests drive the fake clock, so they call this explicitly.
func flush(s *Sender) {
	for _, e := range s.collectAged() {
		_ = s.errSender.SendAppLogError(e.agentID, e.serviceID, e.message, e.context, e.ts)
	}
}

func TestSenderShipsFullStackTraceAsOneIncident(t *testing.T) {
	inner := &fakeInner{}
	errs := &fakeErr{}
	clock := time.Unix(1_700_000_000, 0)
	s := NewSender(inner, errs, 50)
	s.now = func() time.Time { return clock }
	defer s.Close()

	// info startup, the vague first ERROR, then the exception chain —
	// the actionable SQLException is AFTER the first error line.
	feed := []struct{ level, msg string }{
		{"info", "2026-05-19 09:59:58 INFO  Starting AibeApplication"},
		{"info", "2026-05-19 09:59:59 INFO  Bootstrapping Spring"},
		{"error", "2026-05-19 10:00:00 ERROR o.s.boot.SpringApplication - Application run failed"},
		{"error", "org.springframework.beans.factory.BeanCreationException: Error creating bean 'flyway'"},
		{"info", "\tat org.springframework.beans.factory.support.AbstractBeanFactory.doGetBean(AbstractBeanFactory.java:333)"},
		{"error", "Caused by: java.sql.SQLException: path to './data/sitemanager.db': '/app/./data' does not exist"},
		{"info", "\tat org.sqlite.core.CoreConnection.open(CoreConnection.java:74)"},
		{"info", "\t... 24 more"},
	}
	for _, l := range feed {
		_ = s.SendLogEvent("a", "svc", l.level, l.msg)
	}
	if errs.count() != 0 {
		t.Fatalf("burst should not emit before burstWindow elapses; got %d", errs.count())
	}
	// burstWindow elapses → the flusher emits a single incident.
	clock = clock.Add(burstWindow + time.Second)
	flush(s)

	if errs.count() != 1 {
		t.Fatalf("want exactly 1 incident, got %d", errs.count())
	}
	got := errs.errs[0]
	if !strings.Contains(got.message, "SQLException") {
		t.Fatalf("representative should be the deepest cause, got %q", got.message)
	}
	joined := strings.Join(got.contextLines, "\n")
	if !strings.Contains(joined, "path to './data/sitemanager.db'") {
		t.Fatalf("full trace (the SQLException) must be in contextLines:\n%s", joined)
	}
	if !strings.Contains(joined, "Application run failed") {
		t.Fatalf("the first error line should also be in context:\n%s", joined)
	}
}

func TestSenderCrashLoopReplayIsOneIncident(t *testing.T) {
	errs := &fakeErr{}
	clock := time.Unix(1_700_000_000, 0)
	s := NewSender(&fakeInner{}, errs, 50)
	s.now = func() time.Time { return clock }
	defer s.Close()

	burst := func() {
		_ = s.SendLogEvent("a", "svc", "error", "ERROR boom")
		_ = s.SendLogEvent("a", "svc", "error", "Caused by: java.lang.IllegalStateException: bad")
		clock = clock.Add(burstWindow + time.Second) // burstWindow elapses
		flush(s)
	}
	burst()
	if errs.count() != 1 {
		t.Fatalf("first crash → 1 incident, got %d", errs.count())
	}
	burst() // crash-loop replay within incidentWindow
	if errs.count() != 1 {
		t.Fatalf("replay within incidentWindow must not add incidents, got %d", errs.count())
	}
	clock = clock.Add(incidentWindow + time.Second) // genuinely later
	burst()
	if errs.count() != 2 {
		t.Fatalf("error after the window is a new incident, got %d", errs.count())
	}
}

func TestSenderBurstWindowFlush(t *testing.T) {
	errs := &fakeErr{}
	clock := time.Unix(1_700_000_000, 0)
	s := NewSender(&fakeInner{}, errs, 10)
	s.now = func() time.Time { return clock }
	defer s.Close()

	_ = s.SendLogEvent("a", "svc", "error", "ERROR no trailing context ever")
	clock = clock.Add(burstWindow - time.Second)
	flush(s)
	if errs.count() != 0 {
		t.Fatalf("not yet (within burstWindow), got %d", errs.count())
	}
	clock = clock.Add(2 * time.Second) // now past burstWindow
	flush(s)
	if errs.count() != 1 {
		t.Fatalf("burstWindow should flush the quiescent burst, got %d", errs.count())
	}
}

func TestSenderCapsTrailingContext(t *testing.T) {
	errs := &fakeErr{}
	clock := time.Unix(1_700_000_000, 0)
	s := NewSender(&fakeInner{}, errs, 30)
	s.now = func() time.Time { return clock }
	defer s.Close()

	_ = s.SendLogEvent("a", "svc", "error", "ERROR start")
	for i := 0; i < 200; i++ {
		_ = s.SendLogEvent("a", "svc", "info", fmt.Sprintf("trailing line %d", i))
	}
	clock = clock.Add(burstWindow + time.Second)
	flush(s)

	if errs.count() != 1 {
		t.Fatalf("want 1 incident, got %d", errs.count())
	}
	ctx := errs.errs[0].contextLines
	if len(ctx) > preContextLines+1+postContextLines {
		t.Fatalf("context not capped: got %d lines", len(ctx))
	}
	joined := strings.Join(ctx, "\n")
	if !strings.Contains(joined, "trailing line 0") {
		t.Fatalf("trailing context should start right after the error:\n%s", joined)
	}
	if strings.Contains(joined, fmt.Sprintf("trailing line %d", postContextLines)) {
		t.Fatalf("trailing context should be capped at %d lines:\n%s", postContextLines, joined)
	}
}

func TestSenderPerServiceIsolation(t *testing.T) {
	errs := &fakeErr{}
	clock := time.Unix(1_700_000_000, 0)
	s := NewSender(&fakeInner{}, errs, 20)
	s.now = func() time.Time { return clock }
	defer s.Close()

	_ = s.SendLogEvent("a", "svcA", "info", "A boot")
	_ = s.SendLogEvent("a", "svcB", "info", "B boot")
	_ = s.SendLogEvent("a", "svcA", "error", "ERROR A failed")
	clock = clock.Add(burstWindow + time.Second)
	flush(s)

	if errs.count() != 1 {
		t.Fatalf("only svcA should have emitted, got %d", errs.count())
	}
	if errs.errs[0].serviceID != "svcA" {
		t.Fatalf("wrong service: %s", errs.errs[0].serviceID)
	}
	for _, l := range errs.errs[0].contextLines {
		if strings.Contains(l, "B boot") {
			t.Fatalf("svcA context leaked svcB line: %v", errs.errs[0].contextLines)
		}
	}
}

func TestSenderTolerantOfNilErrSender(t *testing.T) {
	inner := &fakeInner{}
	s := NewSender(inner, nil, 5)
	defer s.Close()
	if err := s.SendLogEvent("a", "svc", "error", "x"); err != nil {
		t.Fatal(err)
	}
	if inner.logs != 1 {
		t.Fatal("inner should still receive the log_event")
	}
}
