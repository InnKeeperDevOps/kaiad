// Pure helpers for the tenant-wide Builds page: hash <-> filter state,
// request-query shaping, and small display formatters. Kept free of Vue
// so they can be unit-tested directly.
import type { BuildStatus, BuildStatusFilter, BuildTrigger, ListBuildsFilters } from "../../lib/api.js";

export const BUILDS_ROUTE = "builds";

export const BUILD_STATUS_FILTERS: readonly BuildStatusFilter[] = ["queued", "running", "success", "failed"];
export const BUILD_TRIGGER_FILTERS: readonly BuildTrigger[] = ["poll", "manual"];

/** UI filter state. Empty string = "any". */
export type BuildsPageFilters = {
  serviceId: string;
  status: BuildStatusFilter | "";
  triggeredBy: BuildTrigger | "";
};

export const EMPTY_BUILD_FILTERS: BuildsPageFilters = { serviceId: "", status: "", triggeredBy: "" };

function isStatusFilter(v: string): v is BuildStatusFilter {
  return (BUILD_STATUS_FILTERS as readonly string[]).includes(v);
}
function isTriggerFilter(v: string): v is BuildTrigger {
  return (BUILD_TRIGGER_FILTERS as readonly string[]).includes(v);
}

/**
 * Read filters from a location hash such as
 * `#builds?serviceId=svc-1&status=failed`. Unknown values are dropped
 * rather than failing so a stale shared link still opens the page.
 */
export function parseBuildFiltersFromHash(hash: string): BuildsPageFilters {
  const raw = hash.replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  if (qIdx < 0) return { ...EMPTY_BUILD_FILTERS };
  const params = new URLSearchParams(raw.slice(qIdx + 1));
  const status = params.get("status") ?? "";
  const triggeredBy = params.get("triggeredBy") ?? "";
  return {
    serviceId: (params.get("serviceId") ?? "").trim(),
    status: isStatusFilter(status) ? status : "",
    triggeredBy: isTriggerFilter(triggeredBy) ? triggeredBy : ""
  };
}

/** Inverse of parseBuildFiltersFromHash; omits the `?` entirely when nothing is set. */
export function buildFiltersToHash(filters: BuildsPageFilters): string {
  const params = new URLSearchParams();
  if (filters.serviceId) params.set("serviceId", filters.serviceId);
  if (filters.status) params.set("status", filters.status);
  if (filters.triggeredBy) params.set("triggeredBy", filters.triggeredBy);
  const qs = params.toString();
  return qs ? `${BUILDS_ROUTE}?${qs}` : BUILDS_ROUTE;
}

/** Shape the UI state into the api.listBuilds() argument (no empty strings). */
export function buildFiltersToQuery(filters: BuildsPageFilters): ListBuildsFilters {
  const q: ListBuildsFilters = {};
  if (filters.serviceId) q.serviceId = filters.serviceId;
  if (filters.status) q.status = filters.status;
  if (filters.triggeredBy) q.triggeredBy = filters.triggeredBy;
  return q;
}

export function sameBuildFilters(a: BuildsPageFilters, b: BuildsPageFilters): boolean {
  return a.serviceId === b.serviceId && a.status === b.status && a.triggeredBy === b.triggeredBy;
}

export function hasActiveBuildFilters(f: BuildsPageFilters): boolean {
  return !sameBuildFilters(f, EMPTY_BUILD_FILTERS);
}

export function badgeVariantForBuildStatus(s: BuildStatus): "success" | "danger" | "info" | "muted" {
  switch (s) {
    case "success":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "queued":
    case "no_pipeline":
      return "muted";
  }
}

export function buildStatusLabel(s: BuildStatus): string {
  return s === "no_pipeline" ? "no pipeline" : s;
}

export function isBuildInFlight(b: { status: BuildStatus }): boolean {
  return b.status === "queued" || b.status === "running";
}

export function formatBuildDuration(
  b: { startedAt: string | null; finishedAt: string | null },
  now: number = Date.now()
): string {
  if (!b.startedAt) return "—";
  const start = new Date(b.startedAt).getTime();
  const end = b.finishedAt ? new Date(b.finishedAt).getTime() : now;
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${(sec % 60).toString().padStart(2, "0")}s`;
}

/** First 12 chars of a SHA; "(pending)" for manual builds the worker hasn't resolved yet. */
export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 12) : "(pending)";
}

/**
 * `registry/svc@sha256:<64 hex>` → `svc@sha256:<12 hex>…`; the full ref
 * belongs in a title tooltip. Tag-style refs (`svc:1.2.3`) keep the tag.
 */
export function shortImageRef(ref: string | null): string {
  if (!ref) return "—";
  const tail = ref.split("/").slice(-1)[0] ?? ref;
  const at = tail.indexOf("@sha256:");
  if (at < 0) return tail;
  const digest = tail.slice(at + "@sha256:".length);
  return digest.length > 12 ? `${tail.slice(0, at)}@sha256:${digest.slice(0, 12)}…` : tail;
}
