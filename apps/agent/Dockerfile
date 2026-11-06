FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# AGENT_VERSION is the bare release version (e.g. "0.1.32", no leading
# "v") the agent reports to the control plane. Empty keeps the default
# compiled into internal/transport (transport.Version).
ARG AGENT_VERSION=""
RUN ldflags="-s -w" \
    && if [ -n "${AGENT_VERSION}" ]; then \
         ldflags="${ldflags} -X github.com/service-monitor/agent/internal/transport.Version=${AGENT_VERSION}"; \
       fi \
    && CGO_ENABLED=0 go build -trimpath -ldflags="${ldflags}" -o /out/agent ./cmd/agent

# kubectl for the kubernetes runtime (manifest apply, pod logs, top/exec).
# Same pinned version as deploy/docker/Dockerfile.unified's agent stage.
# TARGETARCH (amd64/arm64, set by buildx for multi-arch builds) picks the
# matching binary; legacy `docker build` leaves it empty, so fall back to
# the stage's own Debian arch (same names). The published .sha256 is
# verified before the binary is used. Reuses the build image (has curl).
FROM golang:1.22-bookworm AS kubectl
ARG TARGETARCH
ARG AGENT_KUBECTL_VERSION=v1.30.5
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && base="https://dl.k8s.io/release/${AGENT_KUBECTL_VERSION}/bin/linux/${arch}" \
    && curl -fsSL "${base}/kubectl" -o /tmp/kubectl \
    && curl -fsSL "${base}/kubectl.sha256" -o /tmp/kubectl.sha256 \
    && echo "$(cat /tmp/kubectl.sha256)  /tmp/kubectl" | sha256sum --check \
    && install -m 0755 /tmp/kubectl /out-kubectl

# Node 20 on Debian bookworm (glibc), matching Dockerfile.unified's agent
# image, so run_toolchain steps with language node/typescript (node, npm,
# npx) work. Adds git + openssh-client so command handlers can clone/fetch
# service repos over SSH, plus ca-certificates and ripgrep for source staging.
FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=kubectl /out-kubectl /usr/local/bin/kubectl
WORKDIR /app
COPY --from=build /out/agent /usr/local/bin/agent
ENTRYPOINT ["/usr/local/bin/agent"]
