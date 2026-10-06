package executor

// Docker-runtime translation of kaiad.yaml runtime config. The k8s
// renderer maps env/secretEnv/volumes onto pod spec fields; on the
// docker runtime there are no k8s Secrets or PVCs, so:
//
//   env        → container Env (`K=V`, sorted for stable diffs)
//   secretEnv  → read from host files <secretsDir>/<secret>/<key>
//                (same layout as a k8s Secret mounted as a volume)
//   hostPath   → bind mount `hostPath[/subPath]:mountPath[:ro]`
//   emptyDir   → tmpfs at the mount path
//   nfs / pvc  → unsupported; surfaced as a warning, deploy continues

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// DefaultDockerSecretsDir is where docker-mode secretEnv files live
// when KAIAD_DOCKER_SECRETS_DIR is unset.
const DefaultDockerSecretsDir = "/etc/kaiad/secrets"

// dockerSecretsDir resolves the host directory holding secretEnv files.
func dockerSecretsDir() string {
	if d := strings.TrimSpace(os.Getenv("KAIAD_DOCKER_SECRETS_DIR")); d != "" {
		return d
	}
	return DefaultDockerSecretsDir
}

// validSecretPathPart rejects anything that could escape secretsDir.
func validSecretPathPart(s string) bool {
	return s != "" && s != "." && !strings.Contains(s, "/") && !strings.Contains(s, "\\") && !strings.Contains(s, "..")
}

// dockerRuntimeConfig turns the resolved runtime config into docker
// create inputs. Pure apart from readFile so it can be unit-tested.
// A required secretEnv that can't be read (or any invalid path) is a
// hard error; everything the docker runtime can't express becomes a
// warning for the redeploy log.
func dockerRuntimeConfig(
	in redeployInput,
	secretsDir string,
	readFile func(string) ([]byte, error),
) (env, binds []string, tmpfs map[string]string, warnings []string, err error) {
	vars := make(map[string]string, len(in.env)+len(in.secretEnv))
	for k, v := range in.env {
		vars[k] = v
	}
	for _, se := range in.secretEnv {
		if !validSecretPathPart(se.secret) || !validSecretPathPart(se.key) {
			return nil, nil, nil, nil, fmt.Errorf(
				"secretEnv %s: invalid secret %q / key %q (must not contain '/' or '..')",
				se.name, se.secret, se.key,
			)
		}
		p := filepath.Join(secretsDir, se.secret, se.key)
		data, rerr := readFile(p)
		if rerr != nil {
			if se.optional {
				warnings = append(warnings, fmt.Sprintf(
					"secretEnv %s: optional secret file %s unreadable, skipping: %v", se.name, p, rerr,
				))
				continue
			}
			if errors.Is(rerr, fs.ErrNotExist) {
				return nil, nil, nil, nil, fmt.Errorf(
					"secretEnv %s: required secret file %s not found (create it on the agent host, or set KAIAD_DOCKER_SECRETS_DIR)",
					se.name, p,
				)
			}
			return nil, nil, nil, nil, fmt.Errorf("secretEnv %s: read %s: %w", se.name, p, rerr)
		}
		if _, dup := vars[se.name]; dup {
			warnings = append(warnings, fmt.Sprintf("secretEnv %s overrides runtime.env value of the same name", se.name))
		}
		vars[se.name] = strings.TrimRight(string(data), "\r\n")
	}
	for _, k := range sortedKeys(vars) {
		env = append(env, k+"="+vars[k])
	}

	for _, v := range in.volumes {
		switch {
		case v.hostPath != "":
			for _, m := range v.mounts {
				src := v.hostPath
				if m.subPath != "" {
					if hasDotDotSegment(m.subPath) {
						return nil, nil, nil, nil, fmt.Errorf(
							"volume %s: subPath %q must not contain '..'", v.name, m.subPath,
						)
					}
					src = path.Join(v.hostPath, m.subPath)
				}
				bind := src + ":" + m.path
				if m.readOnly {
					bind += ":ro"
				}
				binds = append(binds, bind)
			}
		case v.emptyDir:
			if tmpfs == nil {
				tmpfs = map[string]string{}
			}
			for _, m := range v.mounts {
				opts := ""
				if m.readOnly {
					opts = "ro"
				}
				tmpfs[m.path] = opts
			}
		case v.nfsServer != "" || v.nfsPath != "":
			warnings = append(warnings, fmt.Sprintf("volume %s: nfs volumes are unsupported on docker runtime, skipping", v.name))
		case v.pvcClaim != "":
			warnings = append(warnings, fmt.Sprintf("volume %s: persistentVolumeClaim volumes are unsupported on docker runtime, skipping", v.name))
		default:
			warnings = append(warnings, fmt.Sprintf("volume %s: no supported source (hostPath/emptyDir), skipping", v.name))
		}
	}
	return env, binds, tmpfs, warnings, nil
}

func hasDotDotSegment(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}
