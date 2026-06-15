FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/agent ./cmd/agent

# Debian (glibc) instead of alpine (musl) for broad binary compatibility.
# Adds git + openssh-client so command handlers can clone/fetch service
# repos over SSH, plus ca-certificates and ripgrep for source staging.
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git openssh-client ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/agent /usr/local/bin/agent
ENTRYPOINT ["/usr/local/bin/agent"]
