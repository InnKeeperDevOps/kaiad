// Build-time dependency resolution + variable interpolation.
//
// Services may declare `dependsOn: [<other-service-name>]` in their
// kaiad.yaml. Before the build runs we:
//   1. Look up the build of each dep to consume:
//        - SAME-REPO dep (same normalised git URL + branch as the
//          dependent, see samerepo.ts): ONLY the dep's successful build
//          at the dependent build's own git SHA. If that build failed,
//          is still queued/running, or doesn't exist, the dependent
//          build is BLOCKED (BuildBlockedError, reason "blocked: …").
//        - other deps: the dep's latest successful build.
//   2. Compute a set of substitution variables:
//        {<dep>_version}     → short git SHA (12 chars)
//        {<dep>_image_ref}   → full image reference incl. tag
//        {<dep>_build_id}    → UUID of the dep build
//        {<dep>_git_sha}     → full git SHA
//      where `<dep>` is the dep service name with hyphens swapped to
//      underscores so the brace template is a valid identifier.
//   3. Walk every string field in the resolved pipeline (build.image,
//      build.steps, runtime.image, runtime.command, runtime.layers,
//      dockerfile.image, dockerfile.args, etc.) and substitute the
//      variables in-place.
//
// Also exposes system-wide variables (no dep prefix) so kaiad.yaml can
// avoid hard-coding the registry hostname:
//   {kaiad_registry_host}     → external registry host (KAIAD_REGISTRY_HOST)
//   {kaiad_registry_internal} → loopback host the worker uses for pushes
//
// Errors are surfaced as a `BuildDepsError` carrying both a
// human-readable reason and the failed dep name, so the caller can
// fail the build with an actionable log line.
import type { PipelineDefinition } from "@sm/contracts";
import {
  BLOCKED_BUILD_REASON_PREFIX,
  getLatestSuccessfulBuildByServiceName,
  getServiceBuildAtSha,
  type QueryFn
} from "@sm/db";
import { isSameRepo, type DependencyGraphNode } from "./samerepo.js";

export class BuildDepsError extends Error {
  constructor(
    message: string,
    /** The dep service name that triggered the failure, or null when generic. */
    public depName: string | null
  ) {
    super(message);
    this.name = "BuildDepsError";
  }
}

/**
 * A same-repo dependency has no successful build at the dependent's
 * commit. The message always starts with BLOCKED_BUILD_REASON_PREFIX; the
 * caller fails the build with it, deploys nothing, and raises no incident.
 */
export class BuildBlockedError extends BuildDepsError {
  constructor(reason: string, depName: string) {
    super(`${BLOCKED_BUILD_REASON_PREFIX}${reason}`, depName);
    this.name = "BuildBlockedError";
  }
}

/** The dependent build being resolved — enables the same-commit rule. */
export type DependentBuildContext = {
  gitRepoUrl: string;
  branch: string;
  /** The dependent build's pinned commit. Must be non-empty. */
  gitSha: string;
  /** Services of the dependent's tenant (for dep name → repo lookup). */
  services: Array<Pick<DependencyGraphNode, "id" | "name" | "gitRepoUrl" | "branch">>;
};

type DepBuild = { buildId: string; gitSha: string; imageRef: string | null };

async function resolveSameCommitDep(
  query: QueryFn,
  depName: string,
  depServiceId: string,
  gitSha: string
): Promise<DepBuild> {
  const short = gitSha.slice(0, 7);
  const b = await getServiceBuildAtSha(query, depServiceId, gitSha);
  if (!b) {
    throw new BuildBlockedError(`dependency ${depName} has no build at ${short}`, depName);
  }
  switch (b.status) {
    case "success":
      return { buildId: b.buildId, gitSha: b.gitSha, imageRef: b.imageRef };
    case "failed":
      throw new BuildBlockedError(`dependency ${depName} at ${short} failed`, depName);
    case "queued":
    case "running":
      throw new BuildBlockedError(
        `dependency ${depName} at ${short} is still ${b.status}`,
        depName
      );
    default:
      throw new BuildBlockedError(
        `dependency ${depName} at ${short} produced no image (status ${b.status})`,
        depName
      );
  }
}

/** Sanitise a service name for use as a template-variable identifier. */
function varKey(serviceName: string): string {
  return serviceName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Resolve every dep listed in `pipeline.dependsOn` to the build whose
 * vars the dependent should interpolate. Returns the variable map plus
 * the list of resolved (dep → build) pairs so the caller can log them.
 *
 * With `options.dependent`, same-repo deps resolve to their successful
 * build at `dependent.gitSha` only (BuildBlockedError otherwise). Without
 * it — or for deps in another repo/branch — the dep's latest successful
 * build is used; BuildDepsError when there is none yet.
 */
export async function resolveDeps(
  query: QueryFn,
  tenantId: string,
  pipeline: PipelineDefinition,
  options: {
    registryHost?: string;
    registryInternal?: string;
    dependent?: DependentBuildContext;
  } = {}
): Promise<{
  vars: Record<string, string>;
  resolved: Array<{
    depName: string;
    buildId: string;
    gitSha: string;
    imageRef: string | null;
  }>;
}> {
  const vars: Record<string, string> = {};
  // System-wide vars first — kaiad.yaml can use these even when there
  // are no dependsOn entries.
  if (options.registryHost) vars.kaiad_registry_host = options.registryHost;
  if (options.registryInternal) vars.kaiad_registry_internal = options.registryInternal;
  const resolved: Array<{
    depName: string;
    buildId: string;
    gitSha: string;
    imageRef: string | null;
  }> = [];

  const dependent = options.dependent;
  if (dependent && !dependent.gitSha) {
    const err = new Error("resolveDeps: dependent build has no git SHA pinned");
    console.error("[builds][ERR] resolveDeps called with an unpinned dependent build", {
      gitRepoUrl: dependent.gitRepoUrl,
      branch: dependent.branch
    });
    throw err;
  }

  for (const depName of pipeline.dependsOn) {
    const depSvc = dependent?.services.find((s) => s.name === depName);
    let dep: DepBuild | null;
    if (dependent && depSvc && isSameRepo(depSvc, dependent)) {
      dep = await resolveSameCommitDep(query, depName, depSvc.id, dependent.gitSha);
    } else {
      dep = await getLatestSuccessfulBuildByServiceName(query, tenantId, depName);
    }
    if (!dep) {
      throw new BuildDepsError(
        `dependency "${depName}" has no successful build yet — trigger or wait for its build first`,
        depName
      );
    }
    const key = varKey(depName);
    // _version is the FULL git SHA — that's what the build pipeline
    // actually pushes as the image tag, so `panel.dev/foo:{foo_version}`
    // resolves to a tag that exists in the registry. _short_version
    // is the 12-char form for display in non-tag contexts.
    vars[`${key}_version`] = dep.gitSha;
    vars[`${key}_short_version`] = dep.gitSha.length > 12 ? dep.gitSha.slice(0, 12) : dep.gitSha;
    vars[`${key}_git_sha`] = dep.gitSha;
    vars[`${key}_build_id`] = dep.buildId;
    if (dep.imageRef) {
      vars[`${key}_image_ref`] = dep.imageRef;
      // The `_image` alias matches the user-facing example
      // `panel.dev.kaiad.dev/foo:{foo_image_version}` where the
      // bare image stem (no tag) is also handy.
      const colonIdx = dep.imageRef.lastIndexOf(":");
      vars[`${key}_image`] = colonIdx >= 0 ? dep.imageRef.slice(0, colonIdx) : dep.imageRef;
    }
    resolved.push({ depName, buildId: dep.buildId, gitSha: dep.gitSha, imageRef: dep.imageRef });
  }

  return { vars, resolved };
}

/**
 * Substitute `{var_name}` occurrences in `s` using `vars`. Unknown
 * variables are left intact (with a sentinel suffix in the returned
 * `missing` set) so the build log can flag templating typos without
 * silently shipping a broken image ref.
 */
export function substituteString(s: string, vars: Record<string, string>): {
  out: string;
  missing: string[];
} {
  const missing = new Set<string>();
  const out = s.replace(/\{([a-z0-9_]+)\}/gi, (full, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      missing.add(name);
      return full;
    }
    return v;
  });
  return { out, missing: [...missing] };
}

/**
 * Walk the pipeline structure and substitute variables in every
 * string. Returns a NEW pipeline (the input is treated as immutable
 * for safety) plus the set of unresolved variables collected across
 * the entire pipeline — the caller fails the build when this is
 * non-empty.
 *
 * We don't try to be selective about which fields can interpolate:
 * any string in the pipeline schema can contain `{var}` and it gets
 * substituted. That's simpler than maintaining an allowlist + matches
 * what users will expect.
 */
export function substitutePipeline(
  pipeline: PipelineDefinition,
  vars: Record<string, string>
): { pipeline: PipelineDefinition; missing: string[] } {
  const missing = new Set<string>();
  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      const r = substituteString(v, vars);
      for (const m of r.missing) missing.add(m);
      return r.out;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }
  // Deep clone via walk + JSON would lose Date/Buffer; pipeline is
  // a pure JSON-ish shape from zod so the walk's reconstruction is
  // sound.
  const out = walk(pipeline) as PipelineDefinition;
  return { pipeline: out, missing: [...missing] };
}
