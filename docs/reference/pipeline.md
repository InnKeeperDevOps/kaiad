---
title: kaiad.yaml reference
parent: Reference
nav_order: 2
has_children: true
---

# `kaiad.yaml` reference

`kaiad.yaml` lives at the **root of a monitored service's Git
repository** (or a custom path — see [File location](#file-location)). It
describes how Kaiad builds, packages, and deploys the service. The full
schema is enforced by Zod in
**`packages/contracts/src/pipeline.ts`**; these pages are the
human-readable version and aim to document **every field the schema
accepts**.

For onboarding narrative (panel UI, SSH keys, first build), see
[Onboarding a service]({% link getting-started/onboarding-services.md %}).
For interpolation syntax see
[Pipeline variables]({% link reference/pipeline-variables.md %}).

The stages a single build runs through:

{::nomarkdown}
{% include mermaid-build-pipeline.html %}
{:/nomarkdown}

## How this reference is organised

The schema is large, so it's split across child pages. Start here for
the top-level shape, then jump to the page covering the fields you need:

| Page | Covers |
|------|--------|
| **[Build & runtime image]({% link reference/pipeline-build.md %})** | `build`, `artifacts`, `runtime` (image/copy/layers/entrypoint/command), `dockerfile` — i.e. *how the image is produced*. |
| **[Env, secrets & volumes]({% link reference/pipeline-runtime-config.md %})** | `runtime.env`, `runtime.secretEnv`, `runtime.volumes` — plain env vars, Kubernetes Secret refs, and **NFS / hostPath / emptyDir / PVC volume mounts**. |
| **[Ports, domains & load balancing]({% link reference/pipeline-networking.md %})** | `ports`, `instances`, `domains`, `loadBalancer`, `namespace` — how the running service is exposed and scaled. |
| **[Per-environment overrides]({% link reference/pipeline-environments.md %})** | `environments.<name>.*` and the exact merge/replace rules per field. |
| **[Service kind & dependencies]({% link reference/pipeline-dependencies.md %})** | `kind`, `dependsOn` — supporting vs deployable services and chain builds. |
| **[Examples & validation rules]({% link reference/pipeline-examples.md %})** | End-to-end real-world `kaiad.yaml` files and the complete list of parse-time validation errors. |

## File location

By default the file is `kaiad.yaml` at the **repo root**. A
MonitoredService can point Kaiad at a different path on creation
(e.g. `deploy/kaiad.yaml`, `infra/kai.yaml`) — stored as the service's
`kaiad_yaml_path`. The path is read verbatim by both `git show
<branch>:<path>` and `path.join(workspace, <path>)`, so the schema keeps
it narrow:

| Rule | Why |
|------|-----|
| Non-empty, ≤ 512 chars | basic sanity. |
| Relative — no leading `/` or `\` | must resolve inside the repo. |
| No `..` segments | can't escape the repo root. |
| Forward slashes only (POSIX) | `\` separators are rejected. |
| No NUL bytes | path-injection guard. |

Leading `./` is stripped and duplicate `//` collapsed before the path is
persisted.

## Two top-level shapes

A `kaiad.yaml` is either a **single-pipeline** file (one image, one
deployable) or a **multi-pipeline** file (`services:` map — many images
in one repo).

### Single-pipeline

```yaml
version: 1
build:    { … }
runtime:  { … }
ports:    [{ port: 8080 }]
domains:  [{ host: app.example.com, port: 8080, protocol: https }]
```

The MonitoredService referencing this repo leaves **Pipeline Name** blank.

### Multi-pipeline

```yaml
version: 1
services:
  api:
    build:    { … }
    runtime:  { … }
    ports:    [{ port: 8080 }]
  worker:
    build:    { … }
    runtime:  { … }
    dependsOn: [api]
```

Each MonitoredService that points at this repo sets **Pipeline Name** to
one of the keys (`api`, `worker`, …). One repo can back several
MonitoredService records — one per pipeline — each with their own
agents and domain wiring. Pipeline names follow the k8s-style label
shape (`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`), and the `services:` map must
contain at least one entry.

{::nomarkdown}
{% include mermaid-multi-pipeline.html %}
{:/nomarkdown}

Field semantics inside an inner pipeline are **identical** to the
single-pipeline shape; the only difference is that the `version: 1`
declaration is shared and lives at the file root (inner pipelines must
not repeat it). Everything documented on the child pages applies equally
to a single-pipeline file and to each entry under `services:`.

## `version: 1` — required

```yaml
version: 1
```

The only field that is **always required**. Currently `1` is the only
supported value; older or newer values hard-fail the parse so an old
Kaiad never silently misinterprets a newer schema.

Everything except `version` is optional — the simplest valid pipeline is
an artifact-only build with no runtime, ports, or domains.

## Field index

Every top-level field, with its type, default, and the page that
documents it in depth.

| Field | Type | Default | Documented in |
|-------|------|---------|---------------|
| `version` | `1` | — (required) | this page |
| `build` | object | — | [Build & runtime image]({% link reference/pipeline-build.md %}) |
| `artifacts` | string[] | `[]` | [Build & runtime image]({% link reference/pipeline-build.md %}) |
| `runtime` | object | — | [Build]({% link reference/pipeline-build.md %}) (image/copy/layers/cmd) · [Env, secrets & volumes]({% link reference/pipeline-runtime-config.md %}) (env/secretEnv/volumes) |
| `dockerfile` | object | — | [Build & runtime image]({% link reference/pipeline-build.md %}) |
| `ports` | object[] | `[]` | [Ports, domains & LB]({% link reference/pipeline-networking.md %}) |
| `instances` | int ≥ 0 | `1` | [Ports, domains & LB]({% link reference/pipeline-networking.md %}) |
| `domains` | object[] | `[]` | [Ports, domains & LB]({% link reference/pipeline-networking.md %}) |
| `loadBalancer` | tagged union | `{type: none}` | [Ports, domains & LB]({% link reference/pipeline-networking.md %}) |
| `namespace` | string | — | [Ports, domains & LB]({% link reference/pipeline-networking.md %}) |
| `environments` | map<name, object> | `{}` | [Per-environment overrides]({% link reference/pipeline-environments.md %}) |
| `kind` | `deployable` \| `supporting` | `deployable` | [Service kind & dependencies]({% link reference/pipeline-dependencies.md %}) |
| `dependsOn` | string[] | `[]` | [Service kind & dependencies]({% link reference/pipeline-dependencies.md %}) |

## Build modes (mutually exclusive)

A pipeline produces a runtime image in **one of two ways**, and they
cannot be combined:

- **Mode A — `build` + `artifacts` + `runtime`**: Kaiad runs a one-shot
  build container, captures named files into `/artifacts`, then layers
  them onto a runtime image.
- **Mode B — `dockerfile`**: Kaiad runs a host `docker build` and pushes
  the result.

`dockerfile:` is **exclusive with `build:`** — a Dockerfile already *is*
the build step. The deployment fields (`ports`, `instances`, `domains`,
`loadBalancer`, `namespace`, `environments`) and the deploy-time parts of
`runtime` (`env`, `secretEnv`, `volumes`, `command`, `entrypoint`) apply
to **both** modes. See [Build & runtime image]({% link reference/pipeline-build.md %})
for the full split.

## See also

- [Pipeline variables]({% link reference/pipeline-variables.md %}) —
  interpolation syntax and the available variables.
- [Built-in registry]({% link reference/registry.md %}) — what happens
  to the image after a build succeeds.
- [Onboarding a service]({% link getting-started/onboarding-services.md %}) —
  end-to-end walkthrough.
