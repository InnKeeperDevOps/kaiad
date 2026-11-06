import { describe, expect, it, vi } from "vitest";
import {
  decodeBuildCursor,
  encodeBuildCursor,
  listBuildsForTenant,
  type QueryFn
} from "../src/queries.js";

// listBuildsForTenant is exercised against a recording query fn: we
// assert on the SQL + bound params (tenant scoping, filters, keyset
// continuation, explicit column list) and on the mapped output.

function buildRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "b1",
    tenant_id: "t1",
    service_id: "s1",
    git_sha: "abcdef1234567890",
    branch: "main",
    status: "success",
    triggered_by: "poll",
    image_ref: "reg/svc@sha256:abc",
    failure_reason: null,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:01.000Z",
    finished_at: "2026-01-01T00:00:05.000Z",
    created_at_cursor: "2026-01-01 00:00:00.123456+00",
    service_name: "web",
    ...overrides
  };
}

function recordingQuery(rows: Record<string, unknown>[]): QueryFn & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const fn = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push([sql, params]);
    return { rows };
  }) as unknown as QueryFn & { calls: Array<[string, unknown[]]> };
  fn.calls = calls;
  return fn;
}

describe("build cursor", () => {
  it("round-trips createdAt|id through base64", () => {
    const c = encodeBuildCursor("2026-01-01 00:00:00.123456+00", "b-9");
    expect(c).not.toContain("|");
    expect(decodeBuildCursor(c)).toEqual({ createdAt: "2026-01-01 00:00:00.123456+00", id: "b-9" });
  });

  it("rejects malformed cursors", () => {
    expect(decodeBuildCursor("")).toBeNull();
    expect(decodeBuildCursor("not-base64-at-all!!")).toBeNull();
    expect(decodeBuildCursor(Buffer.from("no-separator").toString("base64"))).toBeNull();
    expect(decodeBuildCursor(Buffer.from("garbage|id").toString("base64"))).toBeNull();
    expect(decodeBuildCursor(Buffer.from("2026-01-01 00:00:00+00|").toString("base64"))).toBeNull();
  });
});

describe("listBuildsForTenant", () => {
  it("scopes to the tenant, joins the service name and never selects log / pipeline_yaml", async () => {
    const q = recordingQuery([buildRow()]);
    const r = await listBuildsForTenant(q, "t1");
    const [sql, params] = q.calls[0];
    expect(sql).toContain("b.tenant_id = $1");
    expect(params[0]).toBe("t1");
    expect(sql).toContain("JOIN monitored_services s ON s.id = b.service_id");
    expect(sql).toContain("s.name AS service_name");
    expect(sql).not.toMatch(/\bb\.log\b/);
    expect(sql).not.toContain("pipeline_yaml");
    expect(sql).not.toContain("SELECT *");
    expect(sql).toContain("ORDER BY b.created_at DESC, b.id DESC");
    // Default page size 50 → asks for 51 to detect a next page.
    expect(params[params.length - 1]).toBe(51);

    expect(r.nextCursor).toBeNull();
    expect(r.builds).toEqual([
      {
        id: "b1",
        tenantId: "t1",
        serviceId: "s1",
        serviceName: "web",
        gitSha: "abcdef1234567890",
        branch: "main",
        status: "success",
        triggeredBy: "poll",
        imageRef: "reg/svc@sha256:abc",
        failureReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        finishedAt: "2026-01-01T00:00:05.000Z"
      }
    ]);
    expect(r.builds[0]).not.toHaveProperty("log");
    expect(r.builds[0]).not.toHaveProperty("pipelineYaml");
  });

  it("applies serviceId / status / triggeredBy filters as bound params", async () => {
    const q = recordingQuery([]);
    await listBuildsForTenant(q, "t1", { serviceId: "s9", status: "failed", triggeredBy: "manual", limit: 10 });
    const [sql, params] = q.calls[0];
    expect(sql).toContain("b.service_id = $2");
    expect(sql).toContain("b.status = $3");
    expect(sql).toContain("b.triggered_by = $4");
    expect(sql).toContain("LIMIT $5");
    expect(params).toEqual(["t1", "s9", "failed", "manual", 11]);
  });

  it("omits filter clauses that are not set", async () => {
    const q = recordingQuery([]);
    await listBuildsForTenant(q, "t2", { status: "running" });
    const [sql, params] = q.calls[0];
    expect(sql).not.toContain("b.service_id =");
    expect(sql).not.toContain("b.triggered_by =");
    expect(sql).toContain("b.status = $2");
    expect(params).toEqual(["t2", "running", 51]);
  });

  it("clamps limit into [1, 200]", async () => {
    const q = recordingQuery([]);
    await listBuildsForTenant(q, "t1", { limit: 9999 });
    expect(q.calls[0][1][q.calls[0][1].length - 1]).toBe(201);
    await listBuildsForTenant(q, "t1", { limit: 0 });
    expect(q.calls[1][1][q.calls[1][1].length - 1]).toBe(2);
  });

  it("returns a nextCursor built from the last row's full-precision created_at when more rows exist", async () => {
    const rows = [
      buildRow({ id: "b3", created_at_cursor: "2026-01-03 00:00:00.000001+00" }),
      buildRow({ id: "b2", created_at_cursor: "2026-01-02 00:00:00.000001+00" }),
      buildRow({ id: "b1", created_at_cursor: "2026-01-01 00:00:00.000001+00" })
    ];
    const q = recordingQuery(rows);
    const r = await listBuildsForTenant(q, "t1", { limit: 2 });
    expect(r.builds.map((b) => b.id)).toEqual(["b3", "b2"]);
    expect(r.nextCursor).toBe(encodeBuildCursor("2026-01-02 00:00:00.000001+00", "b2"));
  });

  it("continues from a cursor with a (created_at, id) keyset predicate", async () => {
    const cursor = encodeBuildCursor("2026-01-02 00:00:00.000001+00", "b2");
    const q = recordingQuery([buildRow({ id: "b1" })]);
    const r = await listBuildsForTenant(q, "t1", { cursor, limit: 2 });
    const [sql, params] = q.calls[0];
    expect(sql).toContain("(b.created_at, b.id) < ($2::timestamptz, $3)");
    expect(params).toEqual(["t1", "2026-01-02 00:00:00.000001+00", "b2", 3]);
    expect(r.builds.map((b) => b.id)).toEqual(["b1"]);
    expect(r.nextCursor).toBeNull();
  });

  it("throws on an invalid cursor instead of silently ignoring it", async () => {
    const q = recordingQuery([]);
    await expect(listBuildsForTenant(q, "t1", { cursor: "!!!" })).rejects.toThrow(/invalid cursor/);
    expect(q.calls).toHaveLength(0);
  });

  it("tenant isolation: a different tenant id is the only thing that changes the scope", async () => {
    const q = recordingQuery([]);
    await listBuildsForTenant(q, "tenant-a");
    await listBuildsForTenant(q, "tenant-b");
    expect(q.calls[0][1][0]).toBe("tenant-a");
    expect(q.calls[1][1][0]).toBe("tenant-b");
    expect(q.calls[0][0]).toBe(q.calls[1][0]);
    expect(q.calls[0][0]).toMatch(/WHERE b\.tenant_id = \$1/);
  });

  it("falls back to created_at when the raw cursor column is missing", async () => {
    const rows = [
      buildRow({ id: "b2", created_at_cursor: undefined }),
      buildRow({ id: "b1", created_at_cursor: undefined })
    ];
    const q = recordingQuery(rows);
    const r = await listBuildsForTenant(q, "t1", { limit: 1 });
    expect(r.nextCursor).toBe(encodeBuildCursor("2026-01-01T00:00:00.000Z", "b2"));
  });
});
