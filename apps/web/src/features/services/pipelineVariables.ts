// Reference data + helpers for kaiad.yaml variable substitution.
//
// The build worker substitutes `{var}` occurrences in every string
// field of the pipeline before each build (see
// apps/worker/src/builddeps.ts). The editor uses this module to:
//   - render the "Available variables" reference panel,
//   - populate <datalist> options for inputs that can interpolate.
//
// Keep the canonical list of variables here so the panel and the
// autocomplete agree, and so the docs in
// docs/reference/pipeline-variables.md have a single source the UI
// matches.

export type PipelineVariable = {
  /** The variable name without braces, e.g. `kaiad_registry_host`. */
  name: string;
  /** Short description shown in the reference panel. */
  description: string;
  /** A representative sample value (used in the panel only). */
  sample: string;
  /** Grouping for the panel: system, dep (resolved), dep (template). */
  category: "system" | "dep";
};

/** System-wide variables — always available regardless of dependsOn. */
export const SYSTEM_VARIABLES: PipelineVariable[] = [
  {
    name: "kaiad_registry_host",
    description: "External registry hostname — what agents pull from.",
    sample: "panel.kaiad.dev",
    category: "system"
  },
  {
    name: "kaiad_registry_internal",
    description: "Loopback host the worker uses for in-container pushes.",
    sample: "127.0.0.1:8091",
    category: "system"
  }
];

/** Suffix + description for every variable emitted per dependsOn entry. */
export const DEP_VARIABLE_SUFFIXES: Array<{ suffix: string; description: string; sample: (dep: string) => string }> = [
  { suffix: "version", description: "Full git SHA of the dep's latest successful build (used as the image tag).", sample: () => "cd121a7929a4b2219fbc37644a29c14533288c4c" },
  { suffix: "short_version", description: "12-char prefix of the dep's git SHA — for display/labels.", sample: () => "cd121a7929a4" },
  { suffix: "git_sha", description: "Alias for {<dep>_version} — full SHA.", sample: () => "cd121a7929a4b2219fbc37644a29c14533288c4c" },
  { suffix: "build_id", description: "UUID of the build row that produced the dep (audit/debug only).", sample: () => "8f3e…-…-3a91" },
  { suffix: "image_ref", description: "Full image reference incl. tag — drop-in for runtime.image / build.image.", sample: (dep) => `panel.kaiad.dev/${dep}:cd121a7929a4…` },
  { suffix: "image", description: "Image stem (no tag). Pair with {<dep>_version} for a custom tag.", sample: (dep) => `panel.kaiad.dev/${dep}` }
];

/** Common base images suggested in runtime.image / build.image autocomplete. */
export const COMMON_BASE_IMAGES: string[] = [
  "scratch",
  "alpine:latest",
  "debian:bookworm-slim",
  "ubuntu:22.04",
  "nginx:alpine",
  "node:20-alpine",
  "node:22-alpine",
  "python:3.12-slim",
  "python:3.13-slim",
  "golang:1.23-alpine",
  "openjdk:21-slim",
  "eclipse-temurin:21-jre-jammy",
  "maven:3.9-eclipse-temurin-21",
  "php:8.3-fpm-alpine",
  "redis:7-alpine",
  "postgres:16-alpine",
  "busybox:latest"
];

/**
 * Sanitise a service name into a variable identifier — must match
 * `apps/worker/src/builddeps.ts:varKey`, otherwise the autocomplete
 * suggests names the worker won't substitute.
 */
export function varKey(serviceName: string): string {
  return serviceName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Compute the full list of variables available given a pipeline's
 * dependsOn list. Returns variables in panel order: system first,
 * then one block per dep.
 */
export function availableVariablesFor(deps: string[]): PipelineVariable[] {
  const out: PipelineVariable[] = [...SYSTEM_VARIABLES];
  const seenDeps = new Set<string>();
  for (const rawDep of deps) {
    const dep = String(rawDep || "").trim();
    if (!dep) continue;
    const key = varKey(dep);
    if (!key || seenDeps.has(key)) continue;
    seenDeps.add(key);
    for (const spec of DEP_VARIABLE_SUFFIXES) {
      out.push({
        name: `${key}_${spec.suffix}`,
        description: `${spec.description.replace(/\bdep\b/g, dep)} (from dependsOn: ${dep})`,
        sample: spec.sample(dep),
        category: "dep"
      });
    }
  }
  return out;
}

/**
 * Suggested image-field values: common base images, dep image refs
 * (whole + with version tag), and the registry host pattern. Used by
 * the runtime/build image inputs.
 */
export function imageSuggestions(deps: string[]): string[] {
  const out: string[] = [];
  const seenDeps = new Set<string>();
  for (const rawDep of deps) {
    const dep = String(rawDep || "").trim();
    if (!dep) continue;
    const key = varKey(dep);
    if (!key || seenDeps.has(key)) continue;
    seenDeps.add(key);
    out.push(`{${key}_image_ref}`);
    out.push(`{${key}_image}:{${key}_version}`);
    out.push(`{kaiad_registry_host}/${dep}:{${key}_version}`);
  }
  out.push("{kaiad_registry_host}/<service>:{<dep>_version}");
  for (const b of COMMON_BASE_IMAGES) out.push(b);
  return out;
}
