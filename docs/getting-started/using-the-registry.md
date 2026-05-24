---
title: Using the registry
parent: Getting started
nav_order: 4
---

# Using the registry

Kaiad embeds an **OCI Distribution v2 registry** in the same process
that serves the panel. Every image the build worker pushes lands here,
and every kubelet / docker daemon you point at the panel hostname can
`docker pull` from here. There is no separate registry container to
operate.

This page is the practical "how do I push and pull?" guide. For the
implementation, endpoint reference, GC, and design notes, see
[Built-in OCI registry]({% link reference/registry.md %}).

## Where it lives

The registry lives at your panel hostname under `/v2/...`:

```
https://<panel-host>/v2/<repo>/manifests/<tag>
```

Image references take the bare-hostname shape Docker expects:

```
<panel-host>/<repo>:<tag>
```

On the prod cluster used in these examples that's
`panel.kaiad.dev/<repo>:<tag>`. Swap the hostname for your own.

The hostname comes from `KAIAD_REGISTRY_HOST` in the compose env (see
the [registry reference]({% link reference/registry.md %}#compose-env-vars)).

## Pulling

There are three paths to a pull token. Pick the one that matches the
client.

### Anonymous — for the kaiad-agent image only

`<panel-host>/kaiad-agent:<tag>` is **public by default**. No `docker
login` needed:

```sh
docker pull panel.kaiad.dev/kaiad-agent:latest
```

That's the path the agent install YAML relies on so a brand-new
cluster can pull the agent before anyone has minted a token.

Anything else (your service images, your registry mirrors, etc.) needs
credentials.

### From inside a Kubernetes-mode KaiadAgent

You don't manage this — the [agent operator]({% link agent/kubernetes.md %})
self-provisions an `imagePullSecrets` Secret per managed namespace
using the agent's enrollment token as the password. Pods come up with
pull access automatically. Nothing for you to do.

### From a docker daemon you control — API credential

This is the path for CI, mirroring tools, ad-hoc `docker pull` on a
developer laptop, anything outside the agent's own cluster.

1. **Mint an API credential** with the `registry.pull` scope.
   Settings → API Credentials in the panel — or via the API (see
   [API credentials]({% link admin/api-credentials.md %}#mint-a-credential)).
   Copy the `kop_…` token when it's shown — the server stores only a
   hash.

2. **`docker login` with any username, the token as the password.**
   Kaiad ignores the username when the password resolves to an API
   credential, so pick anything readable; the codebase's tests use
   `kaiad`:

   ```sh
   echo 'kop_<your-token>' | docker login panel.kaiad.dev -u kaiad --password-stdin
   ```

   `--password-stdin` keeps the token out of `~/.bash_history`.

3. **Pull.**

   ```sh
   docker pull panel.kaiad.dev/my-service:abc1234
   ```

`crane` and `podman` work the same way — both use the standard
`~/.docker/config.json` Basic-auth flow.

### From a docker daemon you control — enrollment token

If you already have an enrollment token (e.g. from setting up an
agent), you can use it too. The username **must** be `kaiad-agent`
here — that's the convention the docs and the agent's pull-secret
writer both follow:

```sh
echo "$ENROLLMENT_TOKEN" | docker login panel.kaiad.dev -u kaiad-agent --password-stdin
docker pull panel.kaiad.dev/my-service:abc1234
```

Enrollment tokens are **pull-only**, regardless of how you pass them.
Use them when an API credential is overkill.

## Pushing

Push requires an API credential with the **`registry.push`** scope, or
an owner/admin user session token. `registry.push` implies pull, so
you don't need to grant both.

1. Mint a credential with `registry.push` (same flow as above).
2. Log in with any username + the `kop_…` token as the password:

   ```sh
   echo 'kop_<your-push-token>' | docker login panel.kaiad.dev -u kaiad --password-stdin
   ```

3. Tag and push:

   ```sh
   docker tag local-image:latest panel.kaiad.dev/my-service:v1.2.3
   docker push panel.kaiad.dev/my-service:v1.2.3
   ```

The first push of an image creates its repository row in Postgres;
subsequent tags reuse it. Cross-repo blob mounts kick in automatically
so a shared base image's layers don't get re-uploaded for every
dependent push.

Enrollment tokens cannot push. The kaiad-agent username has no
push grant.

## Listing what's there

The **Registry** page in the panel lists every repository with its
tags, sizes, and creation times. Admin users see a delete action per
tag.

Or via API (any user/api-credential session):

```sh
curl -fsS https://panel.kaiad.dev/api/v1/registry/repositories \
  -H "Authorization: Bearer $YOUR_TOKEN"

curl -fsS https://panel.kaiad.dev/api/v1/registry/repositories/my-service/tags \
  -H "Authorization: Bearer $YOUR_TOKEN"
```

## Credential summary

| Credential | Pull | Push | Username for `docker login` | How to get one |
|------------|------|------|-----------------------------|----------------|
| **None (anonymous)** | `kaiad-agent` only | – | – (skip login) | – |
| **Enrollment token** | any repo | – | `kaiad-agent` | [Settings → Enrollment tokens]({% link admin/api-credentials.md %}) |
| **API credential — `registry.pull`** | any repo | – | anything (e.g. `kaiad`) | Settings → API Credentials, tick **Registry pull** |
| **API credential — `registry.push`** | any repo | any repo | anything (e.g. `kaiad`) | Settings → API Credentials, tick **Registry push** |
| **Owner / admin user session** | any repo | any repo | anything | Browser session token (rotates) |

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `401 Unauthorized` on pull | API credential missing both `registry.pull` and `registry.push`, OR the repo isn't `kaiad-agent` and you didn't `docker login`. |
| `denied: requested access to the resource is denied` on push | API credential has `registry.pull` only — push needs `registry.push`. Mint a new credential (you can't widen scopes on an existing one). |
| `manifest unknown` after a fresh build | The build worker push raced your pull — wait a few seconds and retry, or check the build status in the panel. |
| `unauthorized: Invalid credentials` immediately after `docker login` | Token was revoked, or you copied the wrong token. The `kop_…` prefix should be at the start. Re-mint a credential and try again. |
| `unauthorized: Basic auth required` on `/v2/_catalog` | The catalog endpoint isn't granted to any of these credential classes by design. Use the panel's Registry page or the `/api/v1/registry/repositories` endpoint instead. |

## Rotation

API credentials never expire on their own. Treat the registry
credentials the same way as any other long-lived secret:

- Store the token in a secret manager (vault, k8s Secret, CI secret).
- Rotate on a schedule (90 days is a reasonable default).
- Mint the new credential, switch the consumer over, confirm
  `lastUsedAt` advances on the new one and stops advancing on the old
  one, then revoke the old one.

See [API credentials → Rotation]({% link admin/api-credentials.md %}#rotation)
for the full procedure.

## See also

- [Built-in OCI registry]({% link reference/registry.md %}) — endpoint
  reference, storage internals, GC, env vars.
- [API credentials]({% link admin/api-credentials.md %}) — managing
  the `kop_…` tokens, including the new `registry.pull` /
  `registry.push` scopes.
- [Kubernetes install]({% link agent/kubernetes.md %}) — the operator
  flow that auto-provisions per-agent pull secrets.
