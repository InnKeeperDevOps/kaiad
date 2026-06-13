---
title: Per-environment overrides
parent: kaiad.yaml reference
grand_parent: Reference
nav_order: 4
---

# Per-environment overrides

`environments` is a map keyed by environment name (`development`,
`staging`, `production`, …) where each value overrides a subset of the
top-level deployment fields. Top-level values are the **defaults**; any
field omitted inside an environment falls back to that default at deploy
time. The environment is chosen from the agent's configured environment
label at deploy time.

Environment names must match the k8s-style label shape
(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`) so the operator can use them
verbatim as namespace suffixes / label values.

## Overridable fields

| Field | Type | Override behaviour |
|-------|------|--------------------|
| `instances` | int ≥ 0 | Replaces the top-level `instances`. |
| `domains` | object[] | **Replaces** the top-level `domains` when the per-env list is non-empty. |
| `loadBalancer` | tagged union | Replaces the top-level `loadBalancer`. |
| `namespace` | string | Replaces the top-level `namespace`. |
| `env` | map<string,string> | **Merges over** `runtime.env` (per-key win). |
| `secretEnv` | object[] | **Replaces** `runtime.secretEnv` when present. |
| `volumes` | object[] | **Replaces** `runtime.volumes` when present. |

> **Merge vs. replace matters.** Only `env` merges key-by-key with
> `runtime.env`. `domains`, `secretEnv`, and `volumes` are *list*
> replacements: when the per-environment list is present (and non-empty),
> the top-level list is dropped entirely for that environment — not
> concatenated. Field shapes are identical to their top-level
> counterparts on [Ports, domains & load balancing]({% link reference/pipeline-networking.md %})
> and [Env, secrets & volumes]({% link reference/pipeline-runtime-config.md %}).

## Resolution rules (per field)

For a given environment name, the effective value is:

| Field | Resolved value |
|-------|----------------|
| `instances` | per-env `instances` ?? top-level `instances` |
| `domains` | per-env `domains` if non-empty, else top-level `domains` |
| `loadBalancer` | per-env `loadBalancer` ?? top-level `loadBalancer` |
| `namespace` | per-env `namespace` ?? top-level `namespace` ?? agent default |
| `env` | `{ ...runtime.env, ...per-env env }` (per-env wins per key) |
| `secretEnv` | per-env `secretEnv` if non-empty, else `runtime.secretEnv` |
| `volumes` | per-env `volumes` if non-empty, else `runtime.volumes` |
| `ports` | always top-level `ports` (ports are **not** per-environment) |

`ports` cannot be overridden per environment — one image has one
binding-arity. Per-env `domains[].port` is still validated against the
top-level `ports[]`.

## Example

```yaml
version: 1

# top-level defaults
instances: 1
namespace: app-dev
runtime:
  env:
    LOG_LEVEL: debug
  volumes:
    - name: uploads
      nfs: { server: nfs-dev.local, path: /exports/dev }
      mounts: [{ path: /var/www/uploads }]
domains:
  - host: dev.app.example.com
    port: 8080
    protocol: https
loadBalancer: { type: nginx }
ports:
  - { port: 8080, name: http }

environments:
  staging:
    instances: 2
    namespace: app-staging
    env:
      LOG_LEVEL: info            # merges over top-level env
    domains:
      - host: staging.app.example.com
        port: 8080
        protocol: https
  production:
    instances: 5
    namespace: app-prod
    env:
      LOG_LEVEL: warn
    volumes:                     # REPLACES the dev NFS volume entirely
      - name: uploads
        nfs: { server: nfs-prod.local, path: /exports/prod }
        mounts: [{ path: /var/www/uploads }]
    secretEnv:
      - name: DB_PASSWORD
        secret: app-db
        key: password
    domains:
      - host: app.example.com
        port: 8080
        protocol: https
    loadBalancer:
      type: nginx
      tlsSecret: prod-app-tls
```

In `production` above: `instances=5`, `namespace=app-prod`,
`env={LOG_LEVEL: warn}` (merged), the NFS server is `nfs-prod.local`
(volumes replaced), the prod Secret is wired, and TLS uses
`prod-app-tls`. In `development` (not listed), every value falls back to
the top-level defaults.
