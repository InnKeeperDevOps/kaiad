// Mocked-QueryFn coverage for the parallel-build queries (runs without a
// DB). The real-Postgres behaviour is in buildWorker.pg.test.ts.
import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import {
  BUILD_CLAIM_LOCK_KEY,
  claimNextBuildWithinLimit,
  getBuildQueueStats,
  getBuildWorkerSettings,
  heartbeatBuild,
  ORPHANED_BUILD_REASON,
  sweepOrphanedBuilds,
  updateBuildWorkerSettings,
  type QueryFn,
  type TransactionRunner
} from "../src/queries.js";

vi.stubGlobal("crypto", crypto);

const buildRow = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  tenant_id: "t1",
  service_id: "s1",
  git_sha: "a".repeat(40),
  branch: "main",
  status: "running",
  triggered_by: "poll",
  image_ref: null,
  log: "",
  pipeline_yaml: null,
  failure_reason: null,
  created_at: "2026-01-01T00:00:00.000Z",
  started_at: "2026-01-01T00:00:00.000Z",
  finished_at: null,
  ...over
});

function router(handler: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query: QueryFn = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    return { rows: handler(sql.replace(/\s+/g, " ").trim(), params) };
  }) as unknown as QueryFn;
  const tx: TransactionRunner = (fn) => fn(query);
  return { query, tx, calls };
}

describe("getBuildWorkerSettings", () => {
  it("maps the singleton row", async () => {
    const { query } = router(() => [{ max_concurrent_builds: 4, updated_at: new Date("2026-02-01T00:00:00Z"), updated_by: "u1" }]);
    expect(await getBuildWorkerSettings(query)).toEqual({
      maxConcurrentBuilds: 4,
      updatedAt: "2026-02-01T00:00:00.000Z",
      updatedBy: "u1"
    });
  });

  it("falls back to the default when the row is missing", async () => {
    const { query } = router(() => []);
    const s = await getBuildWorkerSettings(query);
    expect(s.maxConcurrentBuilds).toBe(1);
    expect(s.updatedBy).toBeNull();
  });
});

describe("updateBuildWorkerSettings", () => {
  it("rejects out-of-range and non-integer values without touching the DB", async () => {
    const { query } = router(() => []);
    for (const bad of [0, 9, 1.5, NaN, -1]) {
      await expect(updateBuildWorkerSettings(query, { maxConcurrentBuilds: bad })).rejects.toThrow(/maxConcurrentBuilds/);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("upserts then re-reads", async () => {
    const { query, calls } = router((sql) =>
      /SELECT max_concurrent_builds/.test(sql) ? [{ max_concurrent_builds: 5, updated_at: "2026-01-01T00:00:00.000Z", updated_by: null }] : []
    );
    const s = await updateBuildWorkerSettings(query, { maxConcurrentBuilds: 5 });
    expect(s.maxConcurrentBuilds).toBe(5);
    expect(calls[0].sql).toMatch(/INSERT INTO build_worker_settings .* ON CONFLICT \(id\) DO UPDATE/);
    expect(calls[0].params).toEqual([5, null]);
  });
});

describe("getBuildQueueStats", () => {
  it("maps counts and tolerates an empty result", async () => {
    expect(await getBuildQueueStats(router(() => [{ running: 2, queued: 7 }]).query)).toEqual({ running: 2, queued: 7 });
    expect(await getBuildQueueStats(router(() => []).query)).toEqual({ running: 0, queued: 0 });
  });
});

describe("claimNextBuildWithinLimit", () => {
  it("takes the advisory lock, then returns null when the cap is reached", async () => {
    const { tx, calls } = router((sql) => (/count\(\*\)::int AS n/.test(sql) ? [{ n: 2 }] : [buildRow()]));
    expect(await claimNextBuildWithinLimit(tx, 2)).toBeNull();
    expect(calls[0].sql).toBe("SELECT pg_advisory_xact_lock($1)");
    expect(calls[0].params).toEqual([BUILD_CLAIM_LOCK_KEY]);
    expect(calls).toHaveLength(2); // no UPDATE attempted
  });

  it("claims with the one-per-service guard when below the cap", async () => {
    const { tx, calls } = router((sql) => (/count\(\*\)::int AS n/.test(sql) ? [{ n: 1 }] : [buildRow()]));
    const b = await claimNextBuildWithinLimit(tx, 2);
    expect(b?.id).toBe("b1");
    expect(b?.status).toBe("running");
    expect(calls[2].sql).toMatch(/NOT EXISTS \( SELECT 1 FROM service_builds r WHERE r\.service_id = b\.service_id AND r\.status = 'running' \)/);
    expect(calls[2].sql).toMatch(/heartbeat_at = now\(\)/);
    expect(calls[2].sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it("returns null when nothing is claimable and clamps a bogus limit to 1", async () => {
    const { tx } = router((sql) => (/count\(\*\)::int AS n/.test(sql) ? [{ n: 0 }] : []));
    expect(await claimNextBuildWithinLimit(tx, 0)).toBeNull();
    expect(await claimNextBuildWithinLimit(tx, Number.NaN)).toBeNull();
  });
});

describe("heartbeatBuild", () => {
  it("only touches running rows", async () => {
    const { query, calls } = router(() => []);
    await heartbeatBuild(query, "b9");
    expect(calls[0].sql).toBe("UPDATE service_builds SET heartbeat_at = now() WHERE id = $1 AND status = 'running'");
    expect(calls[0].params).toEqual(["b9"]);
  });
});

describe("sweepOrphanedBuilds", () => {
  it("fails stale builds and re-queues one replacement each", async () => {
    const { tx, calls } = router((sql, params) => {
      if (/SET status = 'failed'/.test(sql)) return [buildRow({ id: "old" }), buildRow({ id: "old2", service_id: "s2", triggered_by: "manual", git_sha: "" })];
      if (/^INSERT INTO service_builds/.test(sql)) {
        // Service s2 already has a newer build → the NOT EXISTS blocks it.
        return params[2] === "s2" ? [] : [buildRow({ id: String(params[0]), status: "queued" })];
      }
      return [];
    });
    const r = await sweepOrphanedBuilds(tx, 120);
    expect(r.orphaned.map((o) => o.id)).toEqual(["old", "old2"]);
    expect(r.requeued).toHaveLength(1);
    expect(r.requeued[0].serviceId).toBe("s1");
    expect(calls[0].params[0]).toBe(120);
    expect(calls[0].params[1]).toBe(ORPHANED_BUILD_REASON);
    expect(calls[0].sql).toMatch(/coalesce\(heartbeat_at, started_at, created_at\) < now\(\) - \(\$1::int \* interval '1 second'\)/);
    // Second INSERT carried the manual trigger + empty sha of its orphan.
    expect(calls[2].params.slice(1, 6)).toEqual(["t1", "s2", "", "main", "manual"]);
  });

  it("returns empty results when nothing is stale and clamps the threshold to >= 1s", async () => {
    const { tx, calls } = router(() => []);
    expect(await sweepOrphanedBuilds(tx, 0)).toEqual({ orphaned: [], requeued: [] });
    expect(calls[0].params[0]).toBe(1);
  });
});
