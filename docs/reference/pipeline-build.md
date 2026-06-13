---
title: Build & runtime image
parent: kaiad.yaml reference
grand_parent: Reference
nav_order: 1
---

# Build & runtime image

These fields control **how the runtime image is produced**. A pipeline
uses exactly one of two mutually-exclusive modes:

- [Mode A — `build` / `artifacts` / `runtime`](#mode-a--build--artifacts--runtime)
- [Mode B — `dockerfile`](#mode-b--dockerfile)

`dockerfile:` may **not** be combined with `build:` — a Dockerfile
already *is* the build step. (`runtime`, `artifacts`, and all the
deployment fields still apply in either mode.)

---

## Mode A — `build` / `artifacts` / `runtime`

The default. Kaiad runs a one-shot **build container**, captures named
files into `/artifacts/...`, then layers them onto a runtime image with
crane and pushes it to the [built-in registry]({% link reference/registry.md %}).

### `build`

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `build.image` | string | yes | — | Docker image used as the build environment. Anything pullable by the host docker daemon (incl. a `dependsOn` dep image via `{<dep>_image_ref}`). |
| `build.steps` | string[] | yes (≥ 1) | — | Shell commands run sequentially. The whole script runs under one `sh -c` with `set -eu` prepended, so the first failing step aborts the build. |
| `build.env` | map<string,string> | no | `{}` | Extra env vars exposed to **all** steps. |

**Inside the build container**, the worker bind-mounts:

- `/workspace` — the repo checked out at the build's SHA, and the working
  directory (`-w /workspace`). Read-write.
- `/artifacts` — an empty scratch dir. Anything written here whose name
  matches an entry in `artifacts:` is preserved; a name listed in
  `artifacts:` but never produced under `/artifacts` fails the build.

Environment variables automatically set on every step (in addition to
`build.env`):

| Variable | Value |
|----------|-------|
| `GIT_SHA` | The commit SHA being built. |
| `GIT_BRANCH` | The branch the build was triggered from. |
| `KAIAD_SERVICE_NAME` | The MonitoredService name. |

### `artifacts`

```yaml
artifacts:
  - server
  - assets.tar
```

A list of filenames (relative to `/artifacts`) to capture out of the
build container. Each path must be **relative** and contain **no `..`
segments** (a malicious kaiad.yaml can't reach outside the build
context). Every name referenced by `runtime.copy.from` or
`runtime.layers` **must** appear here, or the parse fails.

### `runtime` (image assembly)

The image fields of `runtime`. Its deploy-time fields (`env`,
`secretEnv`, `volumes`) are on
[Env, secrets & volumes]({% link reference/pipeline-runtime-config.md %})
and also apply in `dockerfile` mode.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `runtime.image` | string | no | `scratch` | Base image for the pushed runtime. `scratch` lets a single static binary ship with no base. |
| `runtime.copy` | object[] | no | `[]` | Each entry `{ from, to }` copies one captured artifact into the image. |
| `runtime.copy[].from` | string | yes | — | Artifact name — must match an `artifacts:` entry. Relative, no `..`. |
| `runtime.copy[].to` | string | yes | — | **Absolute** path inside the runtime image (must start with `/`). |
| `runtime.layers` | string[] | no | `[]` | Names of **tar** artifacts appended verbatim as filesystem layers, unpacked at the paths the tar declares. Each must appear in `artifacts:`. Use instead of `copy` when shipping many files (e.g. a whole project tree). |
| `runtime.entrypoint` | string[] | no | — | Container ENTRYPOINT (exec-form argv). See [entrypoint vs command](#entrypoint-vs-command). |
| `runtime.command` | string[] | no | — | Container CMD or ENTRYPOINT depending on whether `entrypoint` is set. See below. |

### `entrypoint` vs `command`

These two fields express the classic Docker ENTRYPOINT + CMD pair. Both
are exec-form argv arrays, and an **empty array (`[]`) is treated as
omitted** (use the base image's default) — so the form editor can clear
every row without breaking the parse.

| `entrypoint` | `command` | Resulting image |
|--------------|-----------|-----------------|
| set | set | ENTRYPOINT = `entrypoint`, CMD = `command`. |
| set | absent | ENTRYPOINT = `entrypoint`, no CMD. |
| absent | set | ENTRYPOINT = `command` (back-compat shorthand). |
| absent | absent | Inherit whatever the `runtime.image` base (or, in `dockerfile` mode, the Dockerfile) declares — e.g. `nginx:alpine`'s default CMD. |

Example — override only the binary, keep declared args:

```yaml
runtime:
  image: python:3.12-slim
  entrypoint: ["/usr/bin/python3"]
  command:    ["app.py", "--port", "8080"]
```

### Mode A full example

```yaml
build:
  image: golang:1.22
  env:
    CGO_ENABLED: "0"
  steps:
    - go build -o /artifacts/server ./cmd/server
    - go test ./...
artifacts:
  - server
runtime:
  image: gcr.io/distroless/static
  copy:
    - from: server
      to: /server
  command: ["/server"]
```

---

## Mode B — `dockerfile`

Falls back to a host `docker build` and pushes the result. Useful when
upstream tooling already ships a Dockerfile that's hard to reproduce as
build steps. Image config (entrypoint, exposed ports, base) comes from
the Dockerfile itself.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `dockerfile.path` | string | no | `Dockerfile` | Path to the Dockerfile, relative to the repo root. |
| `dockerfile.context` | string | no | `.` | Build context, relative to the repo root. |
| `dockerfile.args` | map<string,string> | no | `{}` | `--build-arg` map. |
| `dockerfile.target` | string | no | — | `--target` stage for multi-stage builds. |

```yaml
dockerfile:
  path: docker/Dockerfile
  context: .
  args:
    NODE_ENV: production
  target: runtime
```

**Cannot coexist with `build:`.** The schema rejects a pipeline that sets
both with `dockerfile: is exclusive with build:`. You *may* still set
`runtime.env` / `runtime.secretEnv` / `runtime.volumes` / `runtime.command`
alongside `dockerfile:` — those are deploy-time config, applied to the
Dockerfile-built image just like any other.

---

## Next

- Configure the deployed container's environment and storage:
  [Env, secrets & volumes]({% link reference/pipeline-runtime-config.md %}).
- Expose it: [Ports, domains & load balancing]({% link reference/pipeline-networking.md %}).
- Reference an upstream image: [Service kind & dependencies]({% link reference/pipeline-dependencies.md %}).
