---
title: Examples & validation rules
parent: kaiad.yaml reference
grand_parent: Reference
nav_order: 6
---

# Examples & validation rules

End-to-end `kaiad.yaml` files, plus the complete list of errors the
parser raises at parse time.

## Validation rules enforced at parse time

The Zod schema (`packages/contracts/src/pipeline.ts`) rejects YAML that
violates any of the following. The build worker fails fast with a
human-readable error.

**Top-level / structure**

- `version` is not `1`.
- Root is not a mapping.
- `services:` map is present but empty (multi-pipeline needs ≥ 1 entry).
- A pipeline name (multi-pipeline key) isn't a k8s-style label.

**Build modes**

- `dockerfile:` set together with `build:` (mutually exclusive).
- A `build.steps` array that is empty (≥ 1 step required when `build` is set).

**Artifacts / runtime**

- A `runtime.copy.from` that isn't listed in `artifacts[]`.
- A `runtime.layers` entry that isn't listed in `artifacts[]`.
- An `artifacts[]` / `runtime.copy.from` path containing `..` or starting with `/`.
- A `runtime.copy.to` that isn't absolute (must start with `/`).
- A volume that doesn't set **exactly one** source
  (`nfs` | `hostPath` | `emptyDir` | `persistentVolumeClaim`).
- A `volume.name` / `nfs.path` / `hostPath.path` / volume `mounts[].path`
  that violates its shape (DNS-1123 label / absolute path).

**Ports / domains**

- A `domains` entry exists but `ports[]` is empty.
- A `domains[].port` (top-level *or* per-environment) not declared in `ports[]`.

**Environments**

- An environment name that isn't a k8s-style label
  (`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`).

**File location** (set when the service is created, validated separately)

- A `kaiad.yaml` path that is absolute, contains `..`, uses `\`, or
  contains a NUL byte — see [File location]({% link reference/pipeline.md %}#file-location).

---

## Node.js single-pipeline

```yaml
version: 1

build:
  image: node:22
  steps:
    - npm ci --no-audit --no-fund
    - npm run build
    - cp -r dist /artifacts/dist

artifacts:
  - dist

runtime:
  image: gcr.io/distroless/nodejs22-debian12
  copy:
    - from: dist
      to: /app/dist
  command: ["node", "/app/dist/server.js"]
  env:
    NODE_ENV: production

ports:
  - port: 3000
    name: http

domains:
  - host: api.example.com
    port: 3000
    protocol: https
```

## Spring Boot fat JAR

```yaml
version: 1

build:
  image: maven:3.9-eclipse-temurin-17
  steps:
    - mvn -B -DskipTests package
    - cp target/*.jar /artifacts/app.jar

artifacts:
  - app.jar

runtime:
  image: eclipse-temurin:17-jre
  copy:
    - from: app.jar
      to: /app/app.jar
  command:
    - java
    - -XX:MaxRAMPercentage=75
    - -jar
    - /app/app.jar

ports:
  - port: 8080
    name: http
```

## App with NFS storage and a Secret

Shows the deploy-time `runtime` config most often missed — a shared NFS
volume plus a Secret-sourced env var. See
[Env, secrets & volumes]({% link reference/pipeline-runtime-config.md %}).

```yaml
version: 1

dockerfile:
  path: Dockerfile

runtime:
  env:
    APP_ENV: production
  secretEnv:
    - name: DATABASE_URL
      secret: app-db
      key: url
  volumes:
    - name: media
      nfs:
        server: nfs.storage.svc.cluster.local
        path: /exports/media
      mounts:
        - path: /var/www/media
        - path: /var/www/thumbs
          subPath: thumbnails
          readOnly: true

ports:
  - port: 8080
    name: http

domains:
  - host: app.example.com
    port: 8080
    protocol: https

loadBalancer:
  type: metallb
  loadBalancerIPs: 192.168.1.228
```

## Supporting base image + dependent app

See [Service kind & dependencies]({% link reference/pipeline-dependencies.md %})
for the `php-image` + `site-php` pair using `kind: supporting` and
`dependsOn`.

## Multi-pipeline (php + nginx in one repo)

```yaml
version: 1
services:
  php:
    build:
      image: composer:2
      steps:
        - composer install --no-dev
        - cp -r vendor /artifacts/vendor
        - cp -r src /artifacts/src
    artifacts: [vendor, src]
    runtime:
      image: php:8.3-fpm-alpine
      copy:
        - { from: vendor, to: /var/www/vendor }
        - { from: src,    to: /var/www/src }
      command: ["php-fpm", "--nodaemonize"]
    ports: [{ port: 9000, name: fastcgi }]

  nginx:
    dockerfile:
      path: nginx/Dockerfile
    ports: [{ port: 80, name: http }]
    domains:
      - host: app.example.com
        port: 80
        protocol: https
    dependsOn: [php]
```

Two MonitoredService records reference this repo — one with **Pipeline
Name** `php`, the other `nginx`. Each can be bound to different agents.

## See also

- [Pipeline variables]({% link reference/pipeline-variables.md %}) —
  interpolation syntax and the available variables.
- [Built-in registry]({% link reference/registry.md %}) — what happens
  to the image after a build succeeds.
- [Onboarding a service]({% link getting-started/onboarding-services.md %}) —
  end-to-end walkthrough.
