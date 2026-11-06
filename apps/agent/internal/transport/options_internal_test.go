package transport

import (
	"context"
	"math/rand"
	"testing"
	"time"
)

type fakeHandler struct{}

func (fakeHandler) HandleCommand(_ context.Context, _ string, _ map[string]interface{}) (bool, string) {
	return true, "ok"
}

func TestNewClientWithAllOptions(t *testing.T) {
	c := NewClient(
		"wss://example/realtime", "agent-1",
		WithHeartbeatInterval(3*time.Second),
		WithReconnectBackoff(time.Second, 30*time.Second),
		WithRand(rand.New(rand.NewSource(1))),
		WithCommandHandler(fakeHandler{}),
		WithTenantID("t-1"),
		WithVersion("9.9.9"),
		WithToken("tok"),
		OnFirstAck(func() {}),
		OnHello(func(AgentHello) {}),
		WithProtocolDebugLog(func(string, ...interface{}) {}),
		WithHostStatsCollector(func(string) ([]byte, error) { return []byte("{}"), nil }),
		WithAppStatsCollector(func(string) ([][]byte, error) { return nil, nil }),
	)
	if c == nil {
		t.Fatal("NewClient returned nil")
	}
}

// TestNewClientDefaultsToVersion covers the release-stamped Version var
// (set via -ldflags -X ...transport.Version=...) and its precedence
// against $SM_AGENT_VERSION and WithVersion.
func TestNewClientDefaultsToVersion(t *testing.T) {
	t.Setenv("SM_AGENT_VERSION", "")
	if Version == "" {
		t.Fatal("transport.Version must not be empty")
	}
	t.Logf("transport.Version = %q", Version)
	if got := NewClient("wss://example/realtime", "a").version; got != Version {
		t.Fatalf("default version = %q, want %q", got, Version)
	}

	t.Setenv("SM_AGENT_VERSION", "1.2.3")
	if got := NewClient("wss://example/realtime", "a").version; got != "1.2.3" {
		t.Fatalf("env override version = %q, want 1.2.3", got)
	}
	if got := NewClient("wss://example/realtime", "a", WithVersion("9.9.9")).version; got != "9.9.9" {
		t.Fatalf("WithVersion should beat env, got %q", got)
	}
}
