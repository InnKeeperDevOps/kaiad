import { describe, expect, it } from "vitest";
import {
  EMPTY_BUILD_FILTERS,
  badgeVariantForBuildStatus,
  buildFiltersToHash,
  buildFiltersToQuery,
  buildStatusLabel,
  formatBuildDuration,
  hasActiveBuildFilters,
  isBuildInFlight,
  parseBuildFiltersFromHash,
  sameBuildFilters,
  shortImageRef,
  shortSha
} from "../src/features/builds/buildFilters.js";

describe("builds page filters <-> hash", () => {
  it("parses filters out of #builds?… and drops unknown values", () => {
    expect(parseBuildFiltersFromHash("#builds")).toEqual(EMPTY_BUILD_FILTERS);
    expect(parseBuildFiltersFromHash("#builds?serviceId=svc-1&status=failed&triggeredBy=manual")).toEqual({
      serviceId: "svc-1",
      status: "failed",
      triggeredBy: "manual"
    });
    expect(parseBuildFiltersFromHash("#builds?status=no_pipeline&triggeredBy=cron")).toEqual(EMPTY_BUILD_FILTERS);
    expect(parseBuildFiltersFromHash("builds?serviceId=%20svc%202%20")).toEqual({ ...EMPTY_BUILD_FILTERS, serviceId: "svc 2" });
  });

  it("serialises back to a shareable hash and round-trips", () => {
    expect(buildFiltersToHash(EMPTY_BUILD_FILTERS)).toBe("builds");
    const f = { serviceId: "svc/1", status: "running" as const, triggeredBy: "poll" as const };
    const hash = buildFiltersToHash(f);
    expect(hash).toBe("builds?serviceId=svc%2F1&status=running&triggeredBy=poll");
    expect(parseBuildFiltersFromHash(`#${hash}`)).toEqual(f);
  });

  it("shapes the API query without empty strings", () => {
    expect(buildFiltersToQuery(EMPTY_BUILD_FILTERS)).toEqual({});
    expect(buildFiltersToQuery({ serviceId: "s", status: "queued", triggeredBy: "" })).toEqual({
      serviceId: "s",
      status: "queued"
    });
  });

  it("compares filter sets", () => {
    expect(sameBuildFilters(EMPTY_BUILD_FILTERS, { ...EMPTY_BUILD_FILTERS })).toBe(true);
    expect(hasActiveBuildFilters(EMPTY_BUILD_FILTERS)).toBe(false);
    expect(hasActiveBuildFilters({ ...EMPTY_BUILD_FILTERS, status: "failed" })).toBe(true);
  });
});

describe("builds page formatters", () => {
  it("maps statuses to badge variants + labels", () => {
    expect(badgeVariantForBuildStatus("success")).toBe("success");
    expect(badgeVariantForBuildStatus("failed")).toBe("danger");
    expect(badgeVariantForBuildStatus("running")).toBe("info");
    expect(badgeVariantForBuildStatus("queued")).toBe("muted");
    expect(badgeVariantForBuildStatus("no_pipeline")).toBe("muted");
    expect(buildStatusLabel("no_pipeline")).toBe("no pipeline");
    expect(buildStatusLabel("failed")).toBe("failed");
  });

  it("detects in-flight builds", () => {
    expect(isBuildInFlight({ status: "queued" })).toBe(true);
    expect(isBuildInFlight({ status: "running" })).toBe(true);
    expect(isBuildInFlight({ status: "success" })).toBe(false);
  });

  it("formats durations, using `now` for running builds", () => {
    expect(formatBuildDuration({ startedAt: null, finishedAt: null })).toBe("—");
    expect(formatBuildDuration({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:42Z" })).toBe("42s");
    expect(formatBuildDuration({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:02:05Z" })).toBe("2m05s");
    const now = Date.parse("2026-01-01T00:01:30Z");
    expect(formatBuildDuration({ startedAt: "2026-01-01T00:00:00Z", finishedAt: null }, now)).toBe("1m30s");
  });

  it("shortens shas and image refs", () => {
    expect(shortImageRef(null)).toBe("—");
    expect(shortImageRef("registry.local/web@sha256:abc")).toBe("web@sha256:abc");
    expect(shortImageRef(`registry.local/web@sha256:${"0123456789abcdef".repeat(4)}`)).toBe("web@sha256:0123456789ab…");
    expect(shortImageRef("web:latest")).toBe("web:latest");
    expect(shortImageRef("registry.local/web@sha256:abc")).toBe("web@sha256:abc");
    expect(shortImageRef("web:latest")).toBe("web:latest");
  });
});
