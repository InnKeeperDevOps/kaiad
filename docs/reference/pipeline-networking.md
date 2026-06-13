---
title: Ports, domains & load balancing
parent: kaiad.yaml reference
grand_parent: Reference
nav_order: 3
---

# Ports, domains & load balancing

These fields describe **how the running service is exposed and scaled**.
They apply to both build modes and can be overridden per environment (see
[Per-environment overrides]({% link reference/pipeline-environments.md %})).

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `ports` | object[] | `[]` | Ports the runtime image exposes. Source of truth — Kaiad does not inspect the image. |
| `instances` | int ≥ 0 | `1` | Default replica count. |
| `domains` | object[] | `[]` | External hostnames routed to a port. |
| `loadBalancer` | tagged union | `{type: none}` | How the agent publishes the service. |
| `namespace` | string | — | k8s namespace / docker project name. |

---

## `ports`

```yaml
ports:
  - port: 8080
    name: http        # optional, human-readable
    protocol: TCP     # TCP (default) | UDP
  - port: 9090
    name: metrics
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `port` | int 1–65535 | yes | — | Port number exposed by the runtime image. |
| `name` | string | no | — | Human-readable label (e.g. `http`, `metrics`). |
| `protocol` | `TCP` \| `UDP` | no | `TCP` | Wire protocol. |

`ports` is the **source of truth** — Kaiad does not inspect the runtime
image to discover ports. The agent renders these onto both the
container's `ports[]` and the k8s Service, so a service listening on
`5432` actually gets a Service on `5432`. Any port referenced by
`domains` must appear here.

---

## `instances`

```yaml
instances: 3   # default 1; 0 is allowed (scaled-to-zero)
```

Default replica count when no environment-specific override applies. `0`
is valid (scaled-to-zero / pre-deploy state).

---

## `domains`

```yaml
domains:
  - host: app.example.com
    port: 8080
    protocol: https            # https = TLS terminated at the ingress
  - host: '*.preview.example.com'   # leading wildcard allowed
    port: 8080
    protocol: https
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `host` | string | yes | DNS-style hostname. A single leading wildcard (`*.foo.com`) is allowed; the ingress backend must support it. |
| `port` | int 1–65535 | yes | **Must** appear in `ports[]`. |
| `protocol` | `http` \| `https` | yes | Consumer-facing protocol. |

- `protocol: https` means the **ingress terminates TLS** (cert, ALPN,
  HSTS are the operator's job); the container itself speaks plain HTTP on
  the declared port.
- `protocol: http` disables TLS termination at the ingress — typical for
  cluster-internal hostnames.

If any `domains` entry exists (top-level or per-environment), `ports[]`
must be non-empty, and every `domains[].port` must be declared in
`ports[]`.

---

## `loadBalancer`

How the agent should publish the service. A **tagged union** on `type`;
defaults to `{type: none}` (cluster-internal). Per-environment overrides
can change it. The operator generates the right manifests per `type`
because clusters expose services very differently.

### `none` (default)

Cluster-internal only — no external surface.

```yaml
loadBalancer: { type: none }
```

### `k8s` — provider-managed LoadBalancer

`Service.type=LoadBalancer` with no special handling; the cloud
provider's controller (AWS ELB / GCP NLB / …) provisions the LB. Falls
flat on bare-metal clusters with no provider — use `metallb` there.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `annotations` | map<string,string> | `{}` | Free-form annotations applied to the Service. |

```yaml
loadBalancer:
  type: k8s
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
```

### `metallb` — bare-metal IPAM

`Service.type=LoadBalancer` driven by MetalLB.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `addressPool` | string | — | Sets `metallb.universe.tf/address-pool` (any IP from that pool). |
| `loadBalancerIPs` | string | — | Pins a specific external IP, or a comma-separated list, via `metallb.universe.tf/loadBalancerIPs`. |

Both are optional and may be combined (pin an IP that belongs to a pool);
with neither, MetalLB picks from any pool.

```yaml
# any IP from a named pool
loadBalancer:
  type: metallb
  addressPool: prod-public
```

```yaml
# pinned fixed IP (optionally from a pool)
loadBalancer:
  type: metallb
  addressPool: first-pool          # optional
  loadBalancerIPs: 192.168.1.228
```

### `nginx` — ingress-nginx

`Service.type=ClusterIP` plus an Ingress resource per host.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `ingressClass` | string | `nginx` | Sets `ingressClassName`. |
| `tlsSecret` | string | — | Existing TLS Secret referenced in the Ingress `tls:` block. When omitted, the operator picks (e.g. cert-manager). |

```yaml
loadBalancer:
  type: nginx
  ingressClass: nginx     # default
  tlsSecret: app-tls      # optional pre-existing Secret
```

---

## `namespace`

```yaml
namespace: my-app
```

Kubernetes namespace (or Docker "project name" the agent uses to scope
container names/labels). Lowercase k8s-style label: alphanumeric +
hyphens, max 63 chars (`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`).

When unset, the agent picks a default:

- **k8s runtime** — the agent's own pod namespace.
- **docker runtime** — the literal `kaiad`.

Per-environment `environments.<env>.namespace` overrides this.

---

## Next

- Vary any of these per environment:
  [Per-environment overrides]({% link reference/pipeline-environments.md %}).
- See them combined in full files: [Examples & validation rules]({% link reference/pipeline-examples.md %}).
