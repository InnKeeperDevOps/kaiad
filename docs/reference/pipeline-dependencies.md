---
title: Service kind & dependencies
parent: kaiad.yaml reference
grand_parent: Reference
nav_order: 5
---

# Service kind & dependencies

These two fields control whether a build is deployed and how it chains
off other services in the same tenant.

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `kind` | `deployable` \| `supporting` | `deployable` | Whether successful builds are dispatched to bound agents. |
| `dependsOn` | string[] | `[]` | Other services that must build first; their outputs become variables. |

---

## `kind`

```yaml
kind: deployable    # default
# or:
kind: supporting
```

- **`deployable`** *(default)* — every successful build dispatches a
  redeploy to bound agents.
- **`supporting`** — the build produces an artifact (typically a base /
  library Docker image other services consume) but is **never deployed to
  agents**, even when bound. It sits *upstream* of `dependsOn`. Use this
  for a hardened base image (e.g. a PHP runtime) referenced by app builds.

---

## `dependsOn`

```yaml
dependsOn:
  - php-image
  - shared-config
```

Names of **other MonitoredServices in the same tenant** (resolution is
tenant-scoped by `MonitoredService.name`) that must have a successful
build before this one runs. Effects:

- The build worker resolves each dep to one of its builds (see
  [same-commit rule](#same-repo-dependencies-same-commit-rule) below) and
  exposes its outputs as
  [variables]({% link reference/pipeline-variables.md %}#dependency-variables) —
  `{<dep_name>_version}` and `{<dep_name>_image_ref}` (hyphens in the dep
  name become underscores). These substitute wherever they appear inside
  `build`, `runtime`, or `dockerfile` strings.
- A successful build of **this** service triggers downstream rebuilds of
  any service that lists **this** name in *its* `dependsOn:` — the
  chain-build propagation path.
- The build worker's JWT scope includes `pull` access on each
  kaiad-hosted dep so crane can fetch dep images during runtime assembly.

If a dep in **another** repo/branch has no successful build yet, this
build fails fast with `dependency "<name>" has no successful build yet`.

{::nomarkdown}
{% include mermaid-depends-on.html %}
{:/nomarkdown}

### Same-repo dependencies (same-commit rule)

A dep is **same-repo** when its git repo URL **and** branch equal this
service's — e.g. `mochimask-app` and `mochimask-worker` built from two
`kaiad.yaml` pipelines in one repository. For those, the image you
consume must come from **the same commit** you are building, never an
older one:

| | Same-repo dep | Dep in another repo / branch |
|---|---|---|
| `{<dep>_*}` resolves to | the dep's **successful build at this build's git SHA** | the dep's **latest** successful build |
| Built by the commit poller? | **No** — only when its deps have built that commit | Yes, every new commit |
| Chain build triggered by the dep | **Pinned to the dep build's SHA** | Branch HEAD, resolved at run time |

- **Blocked builds.** If the dep's build at the same SHA failed, is still
  queued/running, or doesn't exist, this build ends `failed` with a
  `failure_reason` starting with `blocked: ` — e.g.
  `blocked: dependency mochimask-app at abc1234 failed`. A blocked build
  deploys nothing and raises **no** incident. It applies to manual
  "Start build" runs too (HEAD is pinned first, then the rule applies).
- **Several same-repo deps.** The dependent is queued at SHA X only once
  **all** of them have a successful build at X.
- **Catch-up.** Every poll pass, for each dependent the worker finds the
  most recent commit at which all its same-repo deps succeeded and queues
  the dependent there if it has no build at that commit. A `blocked: `
  build does not count as a build — it is retried; a dependent that
  genuinely failed at that commit is **not** re-queued. Only the latest
  such commit is considered, so older commits are never back-filled over
  newer ones.
- Queueing is idempotent: concurrent triggers for the same service and
  SHA produce one build.

**URL matching.** `git@host:org/repo.git`, `ssh://git@host[:port]/org/repo`
and `https://host/org/repo` are the same repo: user info, port, a
trailing `.git` and trailing slashes are ignored and the host is
case-insensitive. The **path** is case-insensitive only on `github.com`,
`gitlab.com` and `bitbucket.org`; on any other (self-hosted) host
`Org/Repo` and `org/repo` count as **different** repos. Branch names must
match exactly.

**Which deps count** for the poller and chain trigger comes from the
`dependsOn` cached on the service by its most recent build. A brand-new
dependent is therefore polled once like any service; that build already
obeys the same-commit rule and records its `dependsOn`, after which the
poller leaves it to the chain trigger and catch-up.

---

## Supporting base image + dependent app

`php-image` is a `kind: supporting` build producing a hardened PHP
runtime. `site-php` depends on it and references the latest build by
variable.

`php-image/kaiad.yaml`:

```yaml
version: 1
kind: supporting
dockerfile:
  path: Dockerfile
```

`site-php/kaiad.yaml`:

```yaml
version: 1
dependsOn: [php-image]

build:
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
  steps:
    - composer install --no-dev --no-interaction
    - tar -cf /artifacts/code.tar -C . .

artifacts:
  - code.tar

runtime:
  image: "{kaiad_registry_host}/php-image:{php_image_version}"
  layers: [code.tar]
  command: ["php-fpm", "--nodaemonize"]

ports:
  - port: 9000
    name: fastcgi
```

`{kaiad_registry_host}` and `{php_image_version}` are interpolated at
build time — see [Pipeline variables]({% link reference/pipeline-variables.md %})
for the full list.
