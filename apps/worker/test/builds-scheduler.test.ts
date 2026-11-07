// Parallel-build scheduler: claims up to the limit, lowering the limit
// drains gracefully, heartbeat timers are cleared, the orphan sweep runs
// every tick, and stop() waits for in-flight builds (bounded).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDrainScheduler, runDrainOnce } from "../src/builds.js";
import type { QueryFn, ServiceBuildRow, TransactionRunner } from "@sm/db";

type Build = { id: string; service_id: string; status: string; heartbeats: number };

function makeDb(opts: { limit?: number; sweepThrows?: boolean; orphans?: string[]; heartbeatThrows?: boolean } = {}) {
  const builds: Build[] = [];
  const sqlLog: string[] = [];
  const state = {
    limit: opts.limit ?? 1,
    sweepThrows: opts.sweepThrows ?? false,
    orphans: opts.orphans ?? [],
    heartbeatThrows: opts.heartbeatThrows ?? false
  };
  let seq = 0;
  const row = (b: Build) => ({
    id: b.id,
    tenant_id: "t1",
    service_id: b.service_id,
    git_sha: "a".repeat(40),
    branch: "main",
    status: b.status,
    triggered_by: "poll",
    log: "",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString()
  });
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    sqlLog.push(s);
    const p = params as string[];
    if (/^SELECT max_concurrent_builds/.test(s)) {
      return { rows: [{ max_concurrent_builds: state.limit, updated_at: "2026-01-01T00:00:00.000Z", updated_by: null }] };
    }
    if (/pg_advisory_xact_lock/.test(s)) return { rows: [] };
    if (/^SELECT count\(\*\)::int AS n FROM service_builds WHERE status = 'running'/.test(s)) {
      return { rows: [{ n: builds.filter((b) => b.status === "running").length }] };
    }
    if (/FOR UPDATE SKIP LOCKED/.test(s)) {
      const next = builds.find(
        (b) => b.status === "queued" && !builds.some((r) => r.service_id === b.service_id && r.status === "running")
      );
      if (!next) return { rows: [] };
      next.status = "running";
      return { rows: [row(next)] };
    }
    if (/SET status = 'failed', finished_at = now\(\), failure_reason = \$2/.test(s)) {
      if (state.sweepThrows) throw new Error("sweep exploded");
      const orphaned = builds.filter((b) => state.orphans.includes(b.id) && b.status === "running");
      for (const o of orphaned) o.status = "failed";
      state.orphans = [];
      return { rows: orphaned.map(row) };
    }
    if (/^INSERT INTO service_builds/.test(s)) {
      const b: Build = { id: p[0], service_id: p[2], status: "queued", heartbeats: 0 };
      builds.push(b);
      return { rows: [row(b)] };
    }
    if (/SET heartbeat_at = now\(\)/.test(s)) {
      if (state.heartbeatThrows) throw new Error("db away");
      const b = builds.find((x) => x.id === p[0]);
      if (b && b.status === "running") b.heartbeats++;
      return { rows: [] };
    }
    if (/^UPDATE service_builds SET status = \$2/.test(s)) {
      const b = builds.find((x) => x.id === p[0]);
      if (b) b.status = String(params[1]);
      return { rows: [] };
    }
    return { rows: [] };
  }) as unknown as QueryFn;
  const tx: TransactionRunner = (fn) => fn(query);
  const add = (id: string, service = id, status = "queued") => {
    const b = { id, service_id: service, status, heartbeats: 0 };
    builds.push(b);
    return b;
  };
  return { builds, query, tx, state, sqlLog, add };
}

/**
 * A build executor whose completion the test controls per build id. Like
 * the real runBuild, finishing marks the row success in the fake DB (a
 * crash leaves that to safelyFailBuild).
 */
function controlledRun(db: ReturnType<typeof makeDb>) {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const fail = new Map<string, (e: Error) => void>();
  const run = (b: ServiceBuildRow) =>
    new Promise<void>((resolve, reject) => {
      started.push(b.id);
      finish.set(b.id, () => {
        const row = db.builds.find((x) => x.id === b.id);
        if (row) row.status = "success";
        resolve();
      });
      fail.set(b.id, reject);
    });
  return { run, started, finish: (id: string) => finish.get(id)!(), fail: (id: string, e: Error) => fail.get(id)!(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("createDrainScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims builds in parallel up to the limit and no further", async () => {
    const db = makeDb({ limit: 3 });
    for (const id of ["b1", "b2", "b3", "b4", "b5"]) db.add(id);
    const ctl = controlledRun(db);
    const sched = createDrainScheduler(db.query, db.tx, logger, { run: ctl.run, heartbeatMs: 60_000 });

    await sched.tick();
    expect(ctl.started).toEqual(["b1", "b2", "b3"]);
    expect(sched.inFlightIds()).toEqual(["b1", "b2", "b3"]);
    expect(sched.currentLimit()).toBe(3);
    expect(db.builds.filter((b) => b.status === "running")).toHaveLength(3);

    // A second tick while all slots are busy claims nothing.
    await sched.tick();
    expect(ctl.started).toHaveLength(3);

    // Finishing one frees exactly one slot.
    ctl.finish("b2");
    await flush();
    expect(sched.inFlightIds()).toEqual(["b1", "b3"]);
    await sched.tick();
    expect(ctl.started).toEqual(["b1", "b2", "b3", "b4"]);

    ctl.finish("b1");
    ctl.finish("b3");
    ctl.finish("b4");
    await flush();
    await sched.tick();
    expect(ctl.started.at(-1)).toBe("b5");
    ctl.finish("b5");
    await flush();
    expect(sched.inFlightIds()).toEqual([]);
  });

  it("lowering the limit drains gracefully: running builds continue, no new claims until under the limit", async () => {
    const db = makeDb({ limit: 3 });
    for (const id of ["b1", "b2", "b3", "b4"]) db.add(id);
    const ctl = controlledRun(db);
    let t = 0;
    const sched = createDrainScheduler(db.query, db.tx, logger, { run: ctl.run, heartbeatMs: 60_000, settingsCacheMs: 5000, now: () => t });
    await sched.tick();
    expect(ctl.started).toEqual(["b1", "b2", "b3"]);

    // Operator lowers the limit to 1. Within the cache window the old
    // value is still used; after it expires the change is logged.
    db.state.limit = 1;
    t = 1000;
    await sched.tick();
    expect(sched.currentLimit()).toBe(3);
    t = 6000;
    await sched.tick();
    expect(sched.currentLimit()).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "build concurrency limit changed",
      expect.objectContaining({ maxConcurrentBuilds: 1, previous: 3, inFlight: 3 })
    );
    // Nothing was killed, nothing new started.
    expect(db.builds.filter((b) => b.status === "running").map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(ctl.started).toHaveLength(3);

    // Two finish → still 1 running = at the limit → still no claim.
    ctl.finish("b1");
    ctl.finish("b2");
    await flush();
    await sched.tick();
    expect(ctl.started).toHaveLength(3);

    // Last one finishes → one slot → b4 starts.
    ctl.finish("b3");
    await flush();
    await sched.tick();
    expect(ctl.started).toEqual(["b1", "b2", "b3", "b4"]);
    ctl.finish("b4");
    await flush();
  });

  it("heartbeats while a build runs and clears the timer when it settles (success and crash)", async () => {
    vi.useFakeTimers();
    const db = makeDb({ limit: 2 });
    db.add("ok");
    db.add("boom");
    const ctl = controlledRun(db);
    const sched = createDrainScheduler(db.query, db.tx, logger, { run: ctl.run, heartbeatMs: 1000 });
    await sched.tick();
    expect(ctl.started).toEqual(["ok", "boom"]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(db.builds.find((b) => b.id === "ok")!.heartbeats).toBe(3);
    expect(db.builds.find((b) => b.id === "boom")!.heartbeats).toBe(3);

    ctl.finish("ok");
    ctl.fail("boom", new Error("kaput"));
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith("build crashed", expect.objectContaining({ buildId: "boom", err: "kaput" }));
    expect(db.builds.find((b) => b.id === "boom")!.status).toBe("failed");
    expect(sched.inFlightIds()).toEqual([]);

    // No more heartbeat queries once both builds have settled.
    const before = db.sqlLog.filter((s) => /SET heartbeat_at/.test(s)).length;
    await vi.advanceTimersByTimeAsync(5000);
    const after = db.sqlLog.filter((s) => /SET heartbeat_at/.test(s)).length;
    expect(after).toBe(before);
  });
  it("logs a failed heartbeat and keeps the build running", async () => {
    vi.useFakeTimers();
    const db = makeDb({ limit: 1, heartbeatThrows: true });
    db.add("hb");
    const ctl = controlledRun(db);
    const sched = createDrainScheduler(db.query, db.tx, logger, { run: ctl.run, heartbeatMs: 1000 });
    await sched.tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(logger.warn).toHaveBeenCalledWith("build heartbeat failed", { buildId: "hb", err: "db away" });
    expect(sched.inFlightIds()).toEqual(["hb"]);
    ctl.finish("hb");
    await vi.advanceTimersByTimeAsync(0);
    expect(sched.inFlightIds()).toEqual([]);
  });


  it("runs the orphan sweep on every tick, logs re-queues, and tolerates a failing sweep", async () => {
    const db = makeDb({ limit: 1, orphans: ["dead"] });
    db.add("dead", "svc-dead", "running");
    const ctl = controlledRun(db);
    const sched = createDrainScheduler(db.query, db.tx, logger, { run: ctl.run, heartbeatMs: 60_000, orphanStaleSeconds: 120 });

    await sched.tick();
    expect(db.builds.find((b) => b.id === "dead")!.status).toBe("failed");
    const requeued = db.builds.find((b) => b.id !== "dead" && b.service_id === "svc-dead");
    expect(requeued?.status).toBe("running"); // re-queued, then claimed in the same tick
    expect(ctl.started).toEqual([requeued!.id]);
    expect(logger.warn).toHaveBeenCalledWith(
      "orphaned builds failed and re-queued",
      expect.objectContaining({ orphaned: ["dead"], staleAfterSeconds: 120 })
    );
    const sweeps = db.sqlLog.filter((s) => /SET status = 'failed', finished_at = now\(\), failure_reason = \$2/.test(s));
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toContain("coalesce(heartbeat_at, started_at, created_at)");

    // A sweep failure is logged and does not stop claiming.
    ctl.finish(requeued!.id);
    await flush();
    db.state.sweepThrows = true;
    db.add("next");
    await sched.tick();
    expect(logger.error).toHaveBeenCalledWith("orphan sweep failed", { err: "sweep exploded" });
    expect(ctl.started).toContain("next");
    ctl.finish("next");
    await flush();
  });

  it("stop() stops claiming, waits for in-flight builds, and gives up after the timeout", async () => {
    const db = makeDb({ limit: 2 });
    db.add("slow");
    db.add("stuck");
    db.add("never");
    const ctl = controlledRun(db);
    const sched = createDrainScheduler(db.query, db.tx, logger, { run: ctl.run, heartbeatMs: 60_000 });
    await sched.tick();
    expect(ctl.started).toEqual(["slow", "stuck"]);

    const stopping = sched.stop(50);
    ctl.finish("slow");
    const r = await stopping;
    expect(r.drained).toBe(false);
    expect(r.remaining).toEqual(["stuck"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("stop timed out"),
      expect.objectContaining({ remaining: ["stuck"] })
    );
    // No claims after stop.
    await sched.tick();
    expect(ctl.started).toHaveLength(2);
    ctl.finish("stuck");
    await flush();

    // Fully drained path.
    const db2 = makeDb({ limit: 1 });
    db2.add("quick");
    const ctl2 = controlledRun(db2);
    const sched2 = createDrainScheduler(db2.query, db2.tx, logger, { run: ctl2.run, heartbeatMs: 60_000 });
    await sched2.tick();
    const p = sched2.stop(1000);
    ctl2.finish("quick");
    expect(await p).toEqual({ drained: true, remaining: [] });
    expect(await sched2.stop(10)).toEqual({ drained: true, remaining: [] });
  });

  it("uses initialLimit without logging a change on the first read", async () => {
    const db = makeDb({ limit: 2 });
    const sched = createDrainScheduler(db.query, db.tx, logger, { initialLimit: 2, run: async () => {}, heartbeatMs: 60_000 });
    await sched.tick();
    expect(sched.currentLimit()).toBe(2);
    expect(logger.info).not.toHaveBeenCalledWith("build concurrency limit changed", expect.anything());
  });
});

describe("runDrainOnce (single synchronous pass)", () => {
  it("claims within the persisted limit and returns when at capacity", async () => {
    const db = makeDb({ limit: 1 });
    db.add("busy", "s-busy", "running");
    db.add("waiting");
    await runDrainOnce(db.query, logger, db.tx);
    expect(db.builds.find((b) => b.id === "waiting")!.status).toBe("queued");
  });
});
