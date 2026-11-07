// Real-Postgres coverage for the parallel-build queries: the capped claim
// (incl. two concurrent claimers), one-build-per-service, heartbeat, the
// orphan sweep, and the settings singleton. Opt-in via TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { hasTestDb, openTestPool, poolQuery, seedService, seedTenantAndService } from "./_pg.js";
import {
  claimNextBuildWithinLimit,
  createTransactionRunner,
  enqueueBuild,
  finishBuild,
  getBuildQueueStats,
  getBuildWorkerSettings,
  heartbeatBuild,
  ORPHANED_BUILD_REASON,
  sweepOrphanedBuilds,
  updateBuildWorkerSettings,
  type QueryFn,
  type TransactionRunner
} from "../src/index.js";

const d = hasTestDb ? describe : describe.skip;

let pool: Pool;
let q: QueryFn;
let tx: TransactionRunner;
const quiet = { error: () => {} };

const SHA = "a".repeat(40);

async function enqueue(tenantId: string, serviceId: string, sha = SHA) {
  return enqueueBuild(q, { tenantId, serviceId, gitSha: sha, branch: "main" });
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await pool.query(`select status from service_builds where id = $1`, [id]);
  return String(rows[0]?.status);
}

/** Cleanly finish every running build of these services (keeps the shared DB cap free). */
async function finishAll(serviceIds: string[]) {
  await pool.query(
    `update service_builds set status = 'success', finished_at = now()
      where service_id = any($1::text[]) and status in ('running', 'queued')`,
    [serviceIds]
  );
}

d("build worker queries (Postgres)", () => {
  beforeAll(async () => {
    pool = await openTestPool();
    q = poolQuery(pool);
    tx = createTransactionRunner(pool, quiet);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("claim respects the cap and sets running/started_at/heartbeat_at", async () => {
    // Other suites sharing this DB can also have running rows; isolate by
    // computing the baseline and using a limit relative to it.
    await pool.query(`update service_builds set status = 'failed', finished_at = now() where status = 'running'`);
    const { tenantId, serviceId } = await seedTenantAndService(pool, "cap");
    const s2 = await seedService(pool, tenantId, "cap");
    const s3 = await seedService(pool, tenantId, "cap");
    const b1 = await enqueue(tenantId, serviceId);
    const b2 = await enqueue(tenantId, s2);
    const b3 = await enqueue(tenantId, s3);
    try {
      const c1 = await claimNextBuildWithinLimit(tx, 2);
      expect(c1?.id).toBe(b1.id);
      expect(c1?.status).toBe("running");
      expect(c1?.startedAt).not.toBeNull();
      const { rows } = await pool.query(`select heartbeat_at from service_builds where id = $1`, [b1.id]);
      expect(rows[0].heartbeat_at).not.toBeNull();

      const c2 = await claimNextBuildWithinLimit(tx, 2);
      expect(c2?.id).toBe(b2.id);

      // Cap reached: third claim yields nothing even though b3 is queued.
      expect(await claimNextBuildWithinLimit(tx, 2)).toBeNull();
      expect(await statusOf(b3.id)).toBe("queued");

      // Raising the cap lets it through.
      const c3 = await claimNextBuildWithinLimit(tx, 3);
      expect(c3?.id).toBe(b3.id);

      const stats = await getBuildQueueStats(q);
      expect(stats.running).toBeGreaterThanOrEqual(3);
    } finally {
      await finishAll([serviceId, s2, s3]);
    }
  });

  it("two concurrent claimers never exceed the cap", async () => {
    await pool.query(`update service_builds set status = 'failed', finished_at = now() where status = 'running'`);
    const { tenantId, serviceId } = await seedTenantAndService(pool, "race");
    const ids = [serviceId];
    for (let i = 0; i < 5; i++) ids.push(await seedService(pool, tenantId, "race"));
    for (const s of ids) await enqueue(tenantId, s);
    try {
      // Six claimers racing for a cap of 3 across two independent runners.
      const tx2 = createTransactionRunner(pool, quiet);
      const results = await Promise.all([
        claimNextBuildWithinLimit(tx, 3),
        claimNextBuildWithinLimit(tx2, 3),
        claimNextBuildWithinLimit(tx, 3),
        claimNextBuildWithinLimit(tx2, 3),
        claimNextBuildWithinLimit(tx, 3),
        claimNextBuildWithinLimit(tx2, 3)
      ]);
      const claimed = results.filter((r) => r !== null);
      expect(claimed).toHaveLength(3);
      expect(new Set(claimed.map((c) => c!.id)).size).toBe(3);
      const { rows } = await pool.query(
        `select count(*)::int as n from service_builds where service_id = any($1::text[]) and status = 'running'`,
        [ids]
      );
      expect(rows[0].n).toBe(3);
    } finally {
      await finishAll(ids);
    }
  });

  it("never runs two builds of the same service at once", async () => {
    await pool.query(`update service_builds set status = 'failed', finished_at = now() where status = 'running'`);
    const { tenantId, serviceId } = await seedTenantAndService(pool, "one");
    const other = await seedService(pool, tenantId, "one");
    const first = await enqueue(tenantId, serviceId, "1".repeat(40));
    const second = await enqueue(tenantId, serviceId, "2".repeat(40));
    const otherBuild = await enqueue(tenantId, other);
    try {
      expect((await claimNextBuildWithinLimit(tx, 8))?.id).toBe(first.id);
      // Oldest queued is `second` (same service, running) → skipped; the
      // other service's build is claimed instead.
      expect((await claimNextBuildWithinLimit(tx, 8))?.id).toBe(otherBuild.id);
      expect(await claimNextBuildWithinLimit(tx, 8)).toBeNull();
      expect(await statusOf(second.id)).toBe("queued");

      await finishBuild(q, first.id, { status: "success", imageRef: "r" });
      expect((await claimNextBuildWithinLimit(tx, 8))?.id).toBe(second.id);
    } finally {
      await finishAll([serviceId, other]);
    }
  });

  it("heartbeatBuild touches running builds only", async () => {
    const { tenantId, serviceId } = await seedTenantAndService(pool, "hb");
    const b = await enqueue(tenantId, serviceId);
    try {
      await heartbeatBuild(q, b.id); // queued → no-op
      let r = await pool.query(`select heartbeat_at from service_builds where id = $1`, [b.id]);
      expect(r.rows[0].heartbeat_at).toBeNull();

      await pool.query(`update service_builds set status = 'running', started_at = now() where id = $1`, [b.id]);
      await pool.query(`update service_builds set heartbeat_at = now() - interval '10 minutes' where id = $1`, [b.id]);
      await heartbeatBuild(q, b.id);
      r = await pool.query(`select heartbeat_at > now() - interval '1 minute' as fresh from service_builds where id = $1`, [b.id]);
      expect(r.rows[0].fresh).toBe(true);
    } finally {
      await finishAll([serviceId]);
    }
  });

  it("orphan sweep fails stale running builds and re-queues one replacement", async () => {
    const { tenantId, serviceId } = await seedTenantAndService(pool, "orph");
    const fresh = await seedService(pool, tenantId, "orph");
    const stale = await enqueue(tenantId, serviceId);
    const alive = await enqueue(tenantId, fresh);
    // stale: started long ago, no heartbeat since. alive: heartbeat now.
    await pool.query(
      `update service_builds set status = 'running', started_at = now() - interval '1 hour', heartbeat_at = now() - interval '30 minutes' where id = $1`,
      [stale.id]
    );
    await pool.query(
      `update service_builds set status = 'running', started_at = now() - interval '1 hour', heartbeat_at = now() where id = $1`,
      [alive.id]
    );
    try {
      const r = await sweepOrphanedBuilds(tx, 120);
      const mine = r.orphaned.filter((o) => o.serviceId === serviceId);
      expect(mine.map((o) => o.id)).toEqual([stale.id]);
      expect(r.orphaned.some((o) => o.id === alive.id)).toBe(false);
      expect(await statusOf(stale.id)).toBe("failed");
      const row = await pool.query(`select failure_reason, finished_at, log from service_builds where id = $1`, [stale.id]);
      expect(row.rows[0].failure_reason).toBe(ORPHANED_BUILD_REASON);
      expect(row.rows[0].finished_at).not.toBeNull();
      expect(String(row.rows[0].log)).toContain("orphaned");

      const re = r.requeued.filter((b) => b.serviceId === serviceId);
      expect(re).toHaveLength(1);
      expect(re[0]).toMatchObject({ gitSha: SHA, branch: "main", status: "queued", triggeredBy: "poll" });
      expect(await statusOf(alive.id)).toBe("running");

      // Idempotent: a second sweep finds nothing new for this service.
      const again = await sweepOrphanedBuilds(tx, 120);
      expect(again.orphaned.some((o) => o.serviceId === serviceId)).toBe(false);
    } finally {
      await finishAll([serviceId, fresh]);
    }
  });

  it("orphan sweep does not re-queue when a newer build already exists", async () => {
    const { tenantId, serviceId } = await seedTenantAndService(pool, "newer");
    const stale = await enqueue(tenantId, serviceId, "1".repeat(40));
    await pool.query(
      `update service_builds set status = 'running', started_at = now() - interval '1 hour', heartbeat_at = now() - interval '1 hour', created_at = now() - interval '2 hours' where id = $1`,
      [stale.id]
    );
    const newer = await enqueue(tenantId, serviceId, "2".repeat(40));
    try {
      const r = await sweepOrphanedBuilds(tx, 120);
      expect(r.orphaned.map((o) => o.id)).toContain(stale.id);
      expect(r.requeued.some((b) => b.serviceId === serviceId)).toBe(false);
      const { rows } = await pool.query(`select id from service_builds where service_id = $1`, [serviceId]);
      expect(rows.map((x) => x.id).sort()).toEqual([stale.id, newer.id].sort());
    } finally {
      await finishAll([serviceId]);
    }
  });

  it("orphan sweep retries once: a re-queued build that also dies is not re-queued again", async () => {
    const { tenantId, serviceId } = await seedTenantAndService(pool, "retry");
    const first = await enqueue(tenantId, serviceId);
    const kill = (id: string) =>
      pool.query(
        `update service_builds set status = 'running', started_at = now() - interval '1 hour', heartbeat_at = now() - interval '1 hour' where id = $1`,
        [id]
      );
    try {
      await kill(first.id);
      const r1 = await sweepOrphanedBuilds(tx, 120);
      const retry = r1.requeued.find((b) => b.serviceId === serviceId);
      expect(retry).toBeDefined();

      await kill(retry!.id);
      const r2 = await sweepOrphanedBuilds(tx, 120);
      expect(r2.orphaned.map((o) => o.id)).toContain(retry!.id);
      expect(r2.requeued.some((b) => b.serviceId === serviceId)).toBe(false);
      const { rows } = await pool.query(
        `select status from service_builds where service_id = $1`,
        [serviceId]
      );
      expect(rows.map((x) => x.status)).toEqual(["failed", "failed"]);
    } finally {
      await finishAll([serviceId]);
    }
  });

  it("settings: default row, update, validation, upsert after truncate", async () => {
    const before = await getBuildWorkerSettings(q);
    expect(before.maxConcurrentBuilds).toBeGreaterThanOrEqual(1);
    expect(before.maxConcurrentBuilds).toBeLessThanOrEqual(8);
    try {
      const updated = await updateBuildWorkerSettings(q, { maxConcurrentBuilds: 3, updatedBy: "u-test" });
      expect(updated.maxConcurrentBuilds).toBe(3);
      expect(updated.updatedBy).toBe("u-test");
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(0);
      expect((await getBuildWorkerSettings(q)).maxConcurrentBuilds).toBe(3);

      await expect(updateBuildWorkerSettings(q, { maxConcurrentBuilds: 0 })).rejects.toThrow(/between 1 and 8/);
      await expect(updateBuildWorkerSettings(q, { maxConcurrentBuilds: 9 })).rejects.toThrow(/between 1 and 8/);
      await expect(updateBuildWorkerSettings(q, { maxConcurrentBuilds: 2.5 })).rejects.toThrow(/integer/);
      expect((await getBuildWorkerSettings(q)).maxConcurrentBuilds).toBe(3);

      // A truncated settings table (resetDb in other suites) heals on update.
      await pool.query(`delete from build_worker_settings`);
      expect((await getBuildWorkerSettings(q)).maxConcurrentBuilds).toBe(1);
      expect((await updateBuildWorkerSettings(q, { maxConcurrentBuilds: 2 })).maxConcurrentBuilds).toBe(2);
    } finally {
      await updateBuildWorkerSettings(q, { maxConcurrentBuilds: before.maxConcurrentBuilds, updatedBy: before.updatedBy });
    }
  });
});
