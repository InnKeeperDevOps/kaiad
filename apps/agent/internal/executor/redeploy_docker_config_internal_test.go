package executor

import (
	"errors"
	"io/fs"
	"reflect"
	"strings"
	"testing"
)

func fakeReadFile(files map[string]string) func(string) ([]byte, error) {
	return func(p string) ([]byte, error) {
		if s, ok := files[p]; ok {
			return []byte(s), nil
		}
		return nil, fs.ErrNotExist
	}
}

func TestDockerRuntimeConfig_EnvSortedAndSecrets(t *testing.T) {
	in := redeployInput{
		env: map[string]string{"B": "2", "A": "1", "DUP": "plain"},
		secretEnv: []secretEnvSpec{
			{name: "DB_PASS", secret: "db", key: "password"},
			{name: "DUP", secret: "db", key: "dup"},
			{name: "OPT", secret: "missing", key: "x", optional: true},
		},
	}
	read := fakeReadFile(map[string]string{
		"/s/db/password": "hunter2\n",
		"/s/db/dup":      "fromsecret\r\n",
	})
	env, binds, tmpfs, warnings, err := dockerRuntimeConfig(in, "/s", read)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []string{"A=1", "B=2", "DB_PASS=hunter2", "DUP=fromsecret"}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("env = %v, want %v", env, want)
	}
	if binds != nil || tmpfs != nil {
		t.Fatalf("unexpected binds/tmpfs: %v %v", binds, tmpfs)
	}
	if len(warnings) != 2 {
		t.Fatalf("warnings = %v", warnings)
	}
	if !strings.Contains(warnings[0], "DUP overrides") || !strings.Contains(warnings[1], "OPT") {
		t.Fatalf("warnings = %v", warnings)
	}
}

func TestDockerRuntimeConfig_RequiredSecretMissing(t *testing.T) {
	in := redeployInput{secretEnv: []secretEnvSpec{{name: "TOKEN", secret: "api", key: "token"}}}
	_, _, _, _, err := dockerRuntimeConfig(in, "/s", fakeReadFile(nil))
	if err == nil || !strings.Contains(err.Error(), "/s/api/token not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestDockerRuntimeConfig_RequiredSecretReadError(t *testing.T) {
	in := redeployInput{secretEnv: []secretEnvSpec{{name: "TOKEN", secret: "api", key: "token"}}}
	boom := errors.New("permission denied")
	_, _, _, _, err := dockerRuntimeConfig(in, "/s", func(string) ([]byte, error) { return nil, boom })
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want wrapped %v", err, boom)
	}
}

func TestDockerRuntimeConfig_RejectsSecretTraversal(t *testing.T) {
	for _, se := range []secretEnvSpec{
		{name: "X", secret: "../etc", key: "passwd"},
		{name: "X", secret: "a/b", key: "k"},
		{name: "X", secret: "ok", key: "../k"},
		{name: "X", secret: "ok", key: ".."},
		{name: "X", secret: ".", key: "k"},
	} {
		in := redeployInput{secretEnv: []secretEnvSpec{se}}
		called := false
		_, _, _, _, err := dockerRuntimeConfig(in, "/s", func(string) ([]byte, error) {
			called = true
			return nil, nil
		})
		if err == nil || called {
			t.Fatalf("secret=%q key=%q: err=%v called=%v", se.secret, se.key, err, called)
		}
	}
}

func TestDockerRuntimeConfig_Volumes(t *testing.T) {
	in := redeployInput{volumes: []volumeSpec{
		{name: "data", hostPath: "/srv/data", mounts: []volumeMountSpec{
			{path: "/var/lib/app"},
			{path: "/etc/app/conf", subPath: "conf", readOnly: true},
		}},
		{name: "scratch", emptyDir: true, mounts: []volumeMountSpec{{path: "/tmp/a"}, {path: "/tmp/b", readOnly: true}}},
		{name: "share", nfsServer: "nas", nfsPath: "/x", mounts: []volumeMountSpec{{path: "/mnt"}}},
		{name: "claim", pvcClaim: "pvc-1", mounts: []volumeMountSpec{{path: "/p"}}},
		{name: "empty", mounts: []volumeMountSpec{{path: "/e"}}},
	}}
	env, binds, tmpfs, warnings, err := dockerRuntimeConfig(in, "/s", fakeReadFile(nil))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if env != nil {
		t.Fatalf("env = %v", env)
	}
	wantBinds := []string{"/srv/data:/var/lib/app", "/srv/data/conf:/etc/app/conf:ro"}
	if !reflect.DeepEqual(binds, wantBinds) {
		t.Fatalf("binds = %v, want %v", binds, wantBinds)
	}
	wantTmpfs := map[string]string{"/tmp/a": "", "/tmp/b": "ro"}
	if !reflect.DeepEqual(tmpfs, wantTmpfs) {
		t.Fatalf("tmpfs = %v, want %v", tmpfs, wantTmpfs)
	}
	if len(warnings) != 3 ||
		!strings.Contains(warnings[0], "share: nfs volumes are unsupported on docker runtime") ||
		!strings.Contains(warnings[1], "claim: persistentVolumeClaim volumes are unsupported on docker runtime") ||
		!strings.Contains(warnings[2], "empty: no supported source") {
		t.Fatalf("warnings = %v", warnings)
	}
}

func TestDockerRuntimeConfig_RejectsSubPathTraversal(t *testing.T) {
	in := redeployInput{volumes: []volumeSpec{
		{name: "data", hostPath: "/srv/data", mounts: []volumeMountSpec{{path: "/x", subPath: "a/../../etc"}}},
	}}
	_, _, _, _, err := dockerRuntimeConfig(in, "/s", fakeReadFile(nil))
	if err == nil || !strings.Contains(err.Error(), "must not contain '..'") {
		t.Fatalf("err = %v", err)
	}
}

func TestDockerRuntimeConfig_FromParsedPayload(t *testing.T) {
	p := richPayload("none")
	p["env"] = map[string]interface{}{"PORT": "8080"}
	p["secretEnv"] = []interface{}{
		map[string]interface{}{"name": "KEY", "secret": "app", "key": "k"},
	}
	p["volumes"] = []interface{}{
		map[string]interface{}{
			"name":     "logs",
			"hostPath": map[string]interface{}{"path": "/var/log/app"},
			"mounts":   []interface{}{map[string]interface{}{"path": "/logs"}},
		},
	}
	in, err := parseRedeployPayload(p)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	env, binds, _, _, err := dockerRuntimeConfig(in, "/s", fakeReadFile(map[string]string{"/s/app/k": "v"}))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !reflect.DeepEqual(env, []string{"KEY=v", "PORT=8080"}) || !reflect.DeepEqual(binds, []string{"/var/log/app:/logs"}) {
		t.Fatalf("env=%v binds=%v", env, binds)
	}
}

func TestDockerSecretsDir(t *testing.T) {
	t.Setenv("KAIAD_DOCKER_SECRETS_DIR", "")
	if got := dockerSecretsDir(); got != DefaultDockerSecretsDir {
		t.Fatalf("default = %q", got)
	}
	t.Setenv("KAIAD_DOCKER_SECRETS_DIR", " /opt/secrets ")
	if got := dockerSecretsDir(); got != "/opt/secrets" {
		t.Fatalf("override = %q", got)
	}
}
