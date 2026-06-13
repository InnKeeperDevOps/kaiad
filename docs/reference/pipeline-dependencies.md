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

- The build worker waits for each dep's latest successful build and
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

If a dep has no successful build yet, this build fails fast with
`dependency "<name>" has no successful build yet`.

{::nomarkdown}
{% include mermaid-depends-on.html %}
{:/nomarkdown}

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
