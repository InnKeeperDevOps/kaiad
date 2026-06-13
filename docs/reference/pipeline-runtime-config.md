---
title: Env, secrets & volumes
parent: kaiad.yaml reference
grand_parent: Reference
nav_order: 2
---

# Env, secrets & volumes

These `runtime.*` fields are **deploy-time** configuration: they're
rendered onto the Kubernetes Deployment (or `docker run`) for the running
container and apply **regardless of build mode** — they work the same
whether the image came from `build` or from `dockerfile`.

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `runtime.env` | map<string,string> | `{}` | Plain environment variables. |
| `runtime.secretEnv` | object[] | `[]` | Env vars sourced from existing Kubernetes Secrets. |
| `runtime.volumes` | object[] | `[]` | Volumes mounted into the container (NFS, hostPath, emptyDir, PVC). |

All three can be **overridden per environment** — see
[Per-environment overrides]({% link reference/pipeline-environments.md %})
for the exact merge-vs-replace rules (`env` merges; `secretEnv` and
`volumes` replace).

> **Secrets are referenced, never templated.** Kaiad never stores or
> interpolates secret *values* through `kaiad.yaml`. For sensitive data,
> provision a Kubernetes Secret out-of-band and reference it via
> `secretEnv` (below). There is deliberately **no** `secret`/`configMap`
> volume source.

---

## `runtime.env` — plain environment variables

```yaml
runtime:
  env:
    LOG_LEVEL: info
    PORT: "8080"
    FEATURE_FLAGS: "search,billing"
```

A string→string map injected into the container as plain env vars. Both
keys and values are strings — quote numeric-looking values (`"8080"`) so
YAML doesn't coerce them. Per-environment `environments.<env>.env`
entries **merge over** these (per-key win).

---

## `runtime.secretEnv` — env from Kubernetes Secrets

Each entry binds one container env var to a key inside an **existing**
Secret in the deploy namespace (rendered as
`container.env[].valueFrom.secretKeyRef`). Kaiad references the Secret by
name + key; it never reads, stores, or templates the value.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | Env var name set in the container. |
| `secret` | string | yes | The Secret's `metadata.name` (must already exist in the deploy namespace). |
| `key` | string | yes | Key within that Secret. |
| `optional` | boolean | no | When `true`, the pod still starts if the Secret/key is absent. Defaults to required. |

```yaml
runtime:
  secretEnv:
    - name: DATABASE_URL          # env var the container sees
      secret: app-db              # kubectl-created Secret
      key: url                    # data key inside it
    - name: STRIPE_KEY
      secret: payments
      key: stripe_secret
      optional: true              # tolerate it being missing
```

Provision the Secret first, e.g.:

```bash
kubectl -n <namespace> create secret generic app-db \
  --from-literal=url='postgres://user:pass@host:5432/db'
```

Per-environment `environments.<env>.secretEnv` **replaces** the whole
top-level list when present (it does not merge entry-by-entry).

---

## `runtime.volumes` — NFS, hostPath, emptyDir, PVC

Volumes are rendered as `pod.spec.volumes` + `container.volumeMounts`.
Each volume declares **exactly one source** plus **one or more mount
points**.

### Volume shape

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | DNS-1123 label, unique within the runtime (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`). |
| `nfs` / `hostPath` / `emptyDir` / `persistentVolumeClaim` | source | **exactly one** | The volume source — see below. Setting zero or more than one fails the parse. |
| `mounts` | object[] | yes (≥ 1) | Where the volume is mounted in the container. |

### Mount shape (`mounts[]`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | **Absolute** path inside the container (must start with `/`). |
| `subPath` | string | no | Sub-path *within the volume* to mount at `path` (mount one dir/file out of a shared volume). |
| `readOnly` | boolean | no | Mount read-only at this path. |

### Source: `nfs`

Mount a network share. This is the common "shared storage across pods /
nodes" case.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `server` | string | yes | NFS server hostname or IP. |
| `path` | string | yes | **Absolute** export path on the server (must start with `/`). |
| `readOnly` | boolean | no | Mount the whole NFS source read-only. |

```yaml
runtime:
  volumes:
    - name: shared-media
      nfs:
        server: nfs.storage.svc.cluster.local
        path: /exports/media
        readOnly: false
      mounts:
        - path: /var/www/media          # full export here
        - path: /var/www/thumbs
          subPath: thumbnails           # just exports/media/thumbnails
          readOnly: true
```

### Source: `hostPath`

Mount a path from the node's filesystem. Useful for node-local caches,
sockets, or device files.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | **Absolute** path on the node (must start with `/`). |
| `type` | string | no | Kubernetes `HostPathType`, e.g. `Directory`, `DirectoryOrCreate`, `Socket`. |

```yaml
runtime:
  volumes:
    - name: docker-sock
      hostPath:
        path: /var/run/docker.sock
        type: Socket
      mounts:
        - path: /var/run/docker.sock
```

### Source: `emptyDir`

An ephemeral scratch volume created empty with the pod and deleted with
it. Set the boolean `true` to use it.

```yaml
runtime:
  volumes:
    - name: cache
      emptyDir: true
      mounts:
        - path: /tmp/cache
```

### Source: `persistentVolumeClaim`

Mount an existing PVC by name (provision the PVC out-of-band).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `claimName` | string | yes | `metadata.name` of an existing PersistentVolumeClaim. |

```yaml
runtime:
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: app-data
      mounts:
        - path: /data
```

### Combined example

```yaml
runtime:
  image: php:8.3-fpm-alpine
  env:
    APP_ENV: production
  secretEnv:
    - name: DB_PASSWORD
      secret: app-db
      key: password
  volumes:
    - name: uploads                       # shared NFS for user uploads
      nfs:
        server: 10.0.0.20
        path: /exports/uploads
      mounts:
        - path: /var/www/html/uploads
    - name: scratch                       # ephemeral per-pod scratch
      emptyDir: true
      mounts:
        - path: /tmp
```

> Per-environment `environments.<env>.volumes` **replaces** the entire
> top-level `volumes` list when present — handy for a different NFS server
> (or no volumes) per environment.

---

## Next

- Expose the service: [Ports, domains & load balancing]({% link reference/pipeline-networking.md %}).
- Vary env/secrets/volumes per environment:
  [Per-environment overrides]({% link reference/pipeline-environments.md %}).
