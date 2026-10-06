package docker

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"reflect"
	"testing"
)

// fakeEngine serves the docker engine API on a unix socket and records
// the last POST /containers/create body.
func fakeEngine(t *testing.T) (*Client, *map[string]any) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "docker.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var got map[string]any
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"Id":"abc"}`))
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return NewClient(sock), &got
}

func TestCreateContainer_EnvAndTmpfs(t *testing.T) {
	c, got := fakeEngine(t)
	id, err := c.CreateContainer(context.Background(), CreateContainerOpts{
		Name:  "svc-0",
		Image: "img:1",
		Env:   []string{"A=1", "B=2"},
		Binds: []string{"/h:/c:ro"},
		Tmpfs: map[string]string{"/tmp/x": ""},
	})
	if err != nil || id != "abc" {
		t.Fatalf("create: id=%q err=%v", id, err)
	}
	body := *got
	if !reflect.DeepEqual(body["Env"], []any{"A=1", "B=2"}) {
		t.Fatalf("Env = %v", body["Env"])
	}
	hc := body["HostConfig"].(map[string]any)
	if !reflect.DeepEqual(hc["Tmpfs"], map[string]any{"/tmp/x": ""}) {
		t.Fatalf("Tmpfs = %v", hc["Tmpfs"])
	}
	if !reflect.DeepEqual(hc["Binds"], []any{"/h:/c:ro"}) {
		t.Fatalf("Binds = %v", hc["Binds"])
	}
}

func TestCreateContainer_OmitsEmptyEnvAndTmpfs(t *testing.T) {
	c, got := fakeEngine(t)
	if _, err := c.CreateContainer(context.Background(), CreateContainerOpts{Image: "img:1"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	body := *got
	if _, ok := body["Env"]; ok {
		t.Fatalf("Env should be omitted: %v", body)
	}
	if _, ok := body["HostConfig"].(map[string]any)["Tmpfs"]; ok {
		t.Fatalf("Tmpfs should be omitted: %v", body)
	}
}
