package kaiad

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// GetAgent is the only call the operator makes; these exercise the shared
// do() retry policy through it.

func TestGetAgent_RetriesOn5xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n < 3 {
			http.Error(w, "boom", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "agt-1", "status": "online"})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred", WithMaxRetries(5))
	c.httpClient.Timeout = 2 * time.Second
	if _, err := c.GetAgent(context.Background(), "agt-1"); err != nil {
		t.Fatalf("expected eventual success, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Errorf("expected 3 calls, got %d", got)
	}
}

func TestGetAgent_DoesNotRetry4xx(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, `{"code":"FORBIDDEN","message":"missing scope"}`, http.StatusForbidden)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred", WithMaxRetries(5))
	_, err := c.GetAgent(context.Background(), "agt-1")
	if err == nil {
		t.Fatal("expected error")
	}
	if status, ok := IsHTTPError(err); !ok || status != http.StatusForbidden {
		t.Errorf("expected HTTP 403, got status=%d ok=%v err=%v", status, ok, err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected exactly 1 call (no retry on 4xx), got %d", got)
	}
}

func TestGetAgent_404IsExposedAsHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/v1/agents/") {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		http.Error(w, `{"code":"NOT_FOUND"}`, http.StatusNotFound)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred")
	_, err := c.GetAgent(context.Background(), "agt-missing")
	if err == nil {
		t.Fatal("expected 404 error")
	}
	if status, ok := IsHTTPError(err); !ok || status != http.StatusNotFound {
		t.Errorf("expected HTTP 404, got %d ok=%v", status, ok)
	}
}

func TestGetAgent_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agents/agt-1" {
			t.Errorf("path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":                 "agt-1",
			"status":             "online",
			"websocketConnected": true,
			"lastSeenAt":         "2026-05-08T20:00:00Z",
			"latestAgentVersion": "0.1.21",
		})
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "cred")
	info, err := c.GetAgent(context.Background(), "agt-1")
	if err != nil {
		t.Fatalf("getAgent: %v", err)
	}
	if info.Status != "online" || !info.WebsocketConnected {
		t.Errorf("agent decoded wrong: %+v", info)
	}
	if info.LatestAgentVersion != "0.1.21" {
		t.Errorf("LatestAgentVersion = %q, want 0.1.21", info.LatestAgentVersion)
	}
}
