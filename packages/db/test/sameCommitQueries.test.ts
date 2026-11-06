import { describe, it, expect, vi } from "vitest";
import {
  BLOCKED_BUILD_REASON_PREFIX,
  enqueueBuildAtShaIfMissing,
  getLatestCommonSuccessfulSha,
  getServiceBuildAtSha,
  listServiceDependencyRefs,
  listServicesWithSuccessfulBuildAtSha,
  type QueryFn
} from "../src/queries.js";
import type { TransactionRunner } from "../src/transaction.js";

const SHA = "a".repeat(40);

const q = (rows: Record<string, unknown>[] = []) =>
  vi.fn().mockResolvedValue({ rows }) as unknown as QueryFn & ReturnType<typeof vi.fn>;

describe("listServiceDependencyRefs", () => {
  it("maps rows, scoped to a tenant", async () => {
    const query = q([
      { id: "s1", tenant_id: "t1", name: "app", git_repo_url: "git@github.com:o/r.git", branch: "main", depends_on: ["base"], locked: true },
      { id: "s2", tenant_id: "t1", name: "x", git_repo_url: null, branch: null, depends_on: null, locked: false }
    ]);
    const refs = await listServiceDependencyRefs(query, "t1");
    expect(refs).toEqual([
      { id: "s1", tenantId: "t1", name: "app", gitRepoUrl: "git@github.com:o/r.git", branch: "main", dependsOn: ["base"], locked: true },
      { id: "s2", tenantId: "t1", name: "x", gitRepoUrl: "", branch: "", dependsOn: [], locked: false }
    ]);
    expect(query.mock.calls[0][0]).toMatch(/WHERE tenant_id = \$1/);
    expect(query.mock.calls[0][1]).toEqual(["t1"]);
  });

  it("lists every tenant (locked services included) without a tenantId", async () => {
    const query = q([]);
    await listServiceDependencyRefs(query);
    expect(query.mock.calls[0][0]).not.toMatch(/WHERE/);
    expect(query.mock.calls[0][0]).not.toMatch(/locked = false/);
  });
});

describe("getServiceBuildAtSha", () => {
  it("returns the preferred build at exactly that sha (success first)", async () => {
    const query = q([{ id: "b1", status: "success", git_sha: SHA, image_ref: "reg/app:x", failure_reason: null }]);
    expect(await getServiceBuildAtSha(query, "s1", SHA)).toEqual({
      buildId: "b1", status: "success", gitSha: SHA, imageRef: "reg/app:x", failureReason: null
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/git_sha\s+= \$2/);
    expect(sql).toMatch(/WHEN 'success' THEN 0/);
    expect(params).toEqual(["s1", SHA]);
  });

  it("maps failure reasons and null image refs; null when absent", async () => {
    expect(
      await getServiceBuildAtSha(q([{ id: "b2", status: "failed", git_sha: SHA, image_ref: null, failure_reason: "x" }]), "s1", SHA)
    ).toMatchObject({ status: "failed", imageRef: null, failureReason: "x" });
    expect(await getServiceBuildAtSha(q([]), "s1", SHA)).toBeNull();
  });
});

describe("listServicesWithSuccessfulBuildAtSha", () => {
  it("returns the ids with a success at the sha", async () => {
    const query = q([{ service_id: "s1" }]);
    expect(await listServicesWithSuccessfulBuildAtSha(query, ["s1", "s2"], SHA)).toEqual(["s1"]);
    expect(query.mock.calls[0][1]).toEqual([["s1", "s2"], SHA]);
  });
  it("short-circuits an empty id list", async () => {
    const query = q([]);
    expect(await listServicesWithSuccessfulBuildAtSha(query, [], SHA)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("getLatestCommonSuccessfulSha", () => {
  it("requires every (distinct) service to have succeeded at the sha", async () => {
    const query = q([{ git_sha: SHA }]);
    expect(await getLatestCommonSuccessfulSha(query, ["s1", "s2", "s1"], "main")).toBe(SHA);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/HAVING COUNT\(DISTINCT service_id\) = \$3/);
    expect(params).toEqual([["s1", "s2", "s1"], "main", 2]);
  });
  it("returns null when there is no common sha / no ids", async () => {
    expect(await getLatestCommonSuccessfulSha(q([]), ["s1"], "main")).toBeNull();
    const query = q([]);
    expect(await getLatestCommonSuccessfulSha(query, [], "main")).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});

// ─── enqueueBuildAtShaIfMissing ──────────────────────────────────────────

type Row = { id: string; service_id: string; git_sha: string; status: string; failure_reason: string | null };

/**
 * In-memory stand-in for service_builds that honours the three statements
 * enqueueBuildAtShaIfMissing issues, plus a TransactionRunner that
 * serialises transactions on the advisory-lock key (like Postgres does).
 */
function fakeDb(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  const statements: string[] = [];
  const locks = new Map<string, Promise<void>>();

  const exec: QueryFn = async (sql, params) => {
    statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] };
    if (/^SELECT 1/.test(sql.trim())) {
      const [serviceId, sha, like] = params as string[];
      const prefix = like.replace(/%$/, "");
      const hit = rows.find(
        (r) =>
          r.service_id === serviceId &&
          r.git_sha === sha &&
          !(r.status === "failed" && (r.failure_reason ?? "").startsWith(prefix))
      );
      return { rows: hit ? [{ "?column?": 1 }] : [] };
    }
    if (/^INSERT INTO service_builds/.test(sql.trim())) {
      const [id, tenantId, serviceId, sha, branch, trig] = params as string[];
      // Yield so a racing transaction would interleave here if unlocked.
      await new Promise((r) => setTimeout(r, 1));
      rows.push({ id, service_id: serviceId, git_sha: sha, status: "queued", failure_reason: null });
      return {
        rows: [{ id, tenant_id: tenantId, service_id: serviceId, git_sha: sha, branch, status: "queued", triggered_by: trig, created_at: new Date().toISOString() }]
      };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };

  const tx: TransactionRunner = async (fn) => {
    // The first statement of the callback is the advisory lock; emulate it
    // with one global mutex (every test here uses a single key).
    const prev = locks.get("k") ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    locks.set("k", prev.then(() => mine));
    await prev;
    try {
      return await fn(exec);
    } finally {
      release();
    }
  };
  return { rows, statements, tx };
}

const data = { tenantId: "t1", serviceId: "worker", gitSha: SHA, branch: "main" };

describe("enqueueBuildAtShaIfMissing", () => {
  it("locks, checks, then inserts a queued build pinned to the sha", async () => {
    const db = fakeDb();
    const build = await enqueueBuildAtShaIfMissing(db.tx, data);
    expect(build).toMatchObject({ serviceId: "worker", gitSha: SHA, status: "queued", triggeredBy: "poll" });
    expect(db.statements).toEqual(["SELECT pg_advisory_xact_lock(hashtext($1::text", "SELECT 1", "INSERT INTO"]);
    expect(db.rows).toHaveLength(1);
  });

  it("is idempotent: a second call at the same sha inserts nothing", async () => {
    const db = fakeDb();
    expect(await enqueueBuildAtShaIfMissing(db.tx, data)).not.toBeNull();
    expect(await enqueueBuildAtShaIfMissing(db.tx, data)).toBeNull();
    expect(db.rows).toHaveLength(1);
  });

  it("concurrent callers produce exactly one build", async () => {
    const db = fakeDb();
    const results = await Promise.all([
      enqueueBuildAtShaIfMissing(db.tx, data),
      enqueueBuildAtShaIfMissing(db.tx, data),
      enqueueBuildAtShaIfMissing(db.tx, data)
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
  });

  it("re-queues over a build that was only blocked on a dependency", async () => {
    const db = fakeDb([
      { id: "old", service_id: "worker", git_sha: SHA, status: "failed", failure_reason: `${BLOCKED_BUILD_REASON_PREFIX}dependency app at aaaaaaa is still running` }
    ]);
    expect(await enqueueBuildAtShaIfMissing(db.tx, data)).not.toBeNull();
    expect(db.rows).toHaveLength(2);
  });

  it("never re-queues a build that really failed", async () => {
    const db = fakeDb([
      { id: "old", service_id: "worker", git_sha: SHA, status: "failed", failure_reason: "docker build exited 1" }
    ]);
    expect(await enqueueBuildAtShaIfMissing(db.tx, data)).toBeNull();
  });

  it("treats queued/running/success/no_pipeline builds at the sha as present", async () => {
    for (const status of ["queued", "running", "success", "no_pipeline"]) {
      const db = fakeDb([{ id: "old", service_id: "worker", git_sha: SHA, status, failure_reason: null }]);
      expect(await enqueueBuildAtShaIfMissing(db.tx, data)).toBeNull();
    }
  });

  it("passes the lock key params and honours triggeredBy", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const tx: TransactionRunner = (fn) =>
      fn(async (sql, params) => {
        calls.push([sql, params]);
        if (/INSERT/.test(sql)) {
          return { rows: [{ id: "n", tenant_id: "t1", service_id: "worker", git_sha: SHA, branch: "main", status: "queued", triggered_by: "manual", created_at: new Date().toISOString() }] };
        }
        return { rows: [] };
      });
    const b = await enqueueBuildAtShaIfMissing(tx, { ...data, triggeredBy: "manual" });
    expect(b?.triggeredBy).toBe("manual");
    expect(calls[0][1]).toEqual(["worker", SHA]);
    expect(calls[1][1]).toEqual(["worker", SHA, "blocked: %"]);
    expect(calls[2][1][5]).toBe("manual");
  });

  it("throws (and logs) on an empty sha without opening a transaction", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tx = vi.fn() as unknown as TransactionRunner;
    try {
      await expect(enqueueBuildAtShaIfMissing(tx, { ...data, gitSha: "" })).rejects.toThrow(/empty gitSha/);
      expect(tx).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
