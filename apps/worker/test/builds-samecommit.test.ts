// dependsOn same-commit behaviour of the build loops, against a small
// stateful in-memory service_builds / monitored_services fake.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const HEAD = "a".repeat(40); // what `git ls-remote` reports
const X = "c".repeat(40); // a commit the dependency built (≠ HEAD)
const OLD = "d".repeat(40);

const REPO_SSH = "git@github.com:acme/mochimask.git";
const REPO_HTTPS = "https://github.com/acme/mochimask";
const OTHER_REPO = "https://github.com/acme/elsewhere.git";

const NO_DEPS_YAML = `
version: 1
dockerfile:
  path: Dockerfile
ports:
  - port: 9000
`;
const workerYaml = (deps: string[]) => `
version: 1
dependsOn:
${deps.map((d) => `  - ${d}`).join("\n")}
dockerfile:
  path: Dockerfile
  args:
    APP_IMAGE: "{mochimask_app_image_ref}"
ports:
  - port: 9000
`;

const state = vi.hoisted(() => ({
  yamlFor: (_p: string): string => "",
  spawns: [] as Array<{ cmd: string; args: string[] }>
}));

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[] = []) => {
    state.spawns.push({ cmd, args });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (cmd === "git" && args.includes("ls-remote")) {
        child.stdout.emit("data", Buffer.from(`${"a".repeat(40)}\trefs/heads/main\n`));
      }
      child.emit("close", 0);
    });
    return child;
  }
}));

vi.mock("node:fs", () => {
  const promises = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 1 }),
    readFile: vi.fn(async (p: string) => {
      if (String(p).endsWith("/.docker/config.json")) return "";
      if (String(p).endsWith("kaiad.yaml")) return state.yamlFor(String(p));
      return "";
    })
  };
  const m = { existsSync: () => true, promises };
  return { ...m, default: m };
});

import { runDependentCatchUp, runDrainOnce, runPollOnce } from "../src/builds.js";
import { listServiceDependencyRefs, type QueryFn, type TransactionRunner } from "@sm/db";

type Svc = {
  id: string;
  tenant_id: string;
  name: string;
  git_repo_url: string;
  branch: string;
  depends_on: string[];
  locked: boolean;
  yaml: string;
};
type Build = {
  id: string;
  tenant_id: string;
  service_id: string;
  git_sha: string;
  branch: string;
  status: string;
  triggered_by: string;
  image_ref: string | null;
  failure_reason: string | null;
  log: string;
  created_at: string;
};

function makeDb(services: Svc[]) {
  const builds: Build[] = [];
  const sqlLog: string[] = [];
  let seq = 0;
  const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, seq++)).toISOString();

  const addBuild = (b: Partial<Build> & { service_id: string; git_sha: string; status: string }): Build => {
    const svc = services.find((s) => s.id === b.service_id)!;
    const row: Build = {
      id: `b${builds.length + 1}`,
      tenant_id: svc.tenant_id,
      branch: svc.branch,
      triggered_by: "poll",
      image_ref: b.status === "success" ? `panel.dev.kaiad.dev/${svc.name}:${b.git_sha}` : null,
      failure_reason: null,
      log: "",
      created_at: ts(),
      ...b
    };
    builds.push(row);
    return row;
  };

  const svcRow = (s: Svc) => ({ ...s, ssh_key_id: null, pipeline_name: null, kaiad_yaml_path: "kaiad.yaml", kind: "deployable", pipeline_override: null });

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    sqlLog.push(s);
    const p = params as any[];
    if (/FROM monitored_services WHERE locked = false/.test(s)) {
      return { rows: services.filter((x) => !x.locked).map(svcRow) };
    }
    if (/SELECT id, tenant_id, name, git_repo_url, branch, depends_on, locked FROM monitored_services/.test(s)) {
      return { rows: services.filter((x) => !/WHERE tenant_id/.test(s) || x.tenant_id === p[0]).map(svcRow) };
    }
    if (/^UPDATE monitored_services/.test(s)) return { rows: [] };
    if (/FROM ssh_keys|FROM repo_pipeline_overrides|FROM incidents|FROM agent_services/.test(s)) return { rows: [] };
    if (/^SELECT git_sha FROM service_builds WHERE service_id = \$1 AND triggered_by = 'poll'/.test(s)) {
      const last = builds.filter((b) => b.service_id === p[0] && b.triggered_by === "poll" && b.git_sha).at(-1);
      return { rows: last ? [{ git_sha: last.git_sha }] : [] };
    }
    if (/^INSERT INTO service_builds/.test(s)) {
      const manual = /'', \$4, 'queued', 'manual'/.test(s);
      const svcId = p[2];
      const row = manual
        ? addBuild({ service_id: svcId, git_sha: "", status: "queued", triggered_by: "manual" })
        : addBuild({ service_id: svcId, git_sha: p[3], status: "queued", triggered_by: p[5] ?? "poll" });
      return { rows: [row] };
    }
    if (/FOR UPDATE SKIP LOCKED/.test(s)) {
      const next = builds.find((b) => b.status === "queued");
      if (!next) return { rows: [] };
      next.status = "running";
      return { rows: [{ ...next }] };
    }
    if (/^UPDATE service_builds SET git_sha = \$2/.test(s)) {
      builds.find((b) => b.id === p[0])!.git_sha = p[1];
      return { rows: [] };
    }
    if (/^UPDATE service_builds SET log = log/.test(s)) {
      builds.find((b) => b.id === p[0])!.log += p[1];
      return { rows: [] };
    }
    if (/^UPDATE service_builds SET status = \$2/.test(s)) {
      const b = builds.find((x) => x.id === p[0])!;
      b.status = p[1];
      if (p[2] != null) b.image_ref = p[2];
      if (p[3] != null) b.failure_reason = p[3];
      return { rows: [] };
    }
    if (/WHEN 'success' THEN 0/.test(s)) {
      const rank = (st: string) => ({ success: 0, running: 1, queued: 2 } as Record<string, number>)[st] ?? 3;
      const hits = builds
        .filter((b) => b.service_id === p[0] && b.git_sha === p[1])
        .sort((a, b) => rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at));
      return { rows: hits.slice(0, 1) };
    }
    if (/^SELECT DISTINCT service_id FROM service_builds/.test(s)) {
      const ids = [...new Set(builds.filter((b) => p[0].includes(b.service_id) && b.git_sha === p[1] && b.status === "success").map((b) => b.service_id))];
      return { rows: ids.map((service_id) => ({ service_id })) };
    }
    if (/HAVING COUNT\(DISTINCT service_id\)/.test(s)) {
      const by = new Map<string, { ids: Set<string>; last: string }>();
      for (const b of builds) {
        if (!p[0].includes(b.service_id) || b.branch !== p[1] || b.status !== "success" || !b.git_sha) continue;
        const e = by.get(b.git_sha) ?? { ids: new Set(), last: "" };
        e.ids.add(b.service_id);
        if (b.created_at > e.last) e.last = b.created_at;
        by.set(b.git_sha, e);
      }
      const best = [...by.entries()].filter(([, e]) => e.ids.size === p[2]).sort((a, b) => b[1].last.localeCompare(a[1].last))[0];
      return { rows: best ? [{ git_sha: best[0] }] : [] };
    }
    if (/pg_advisory_xact_lock/.test(s)) return { rows: [{}] };
    if (/^SELECT 1 FROM service_builds/.test(s)) {
      const prefix = String(p[2]).replace(/%$/, "");
      const hit = builds.some(
        (b) => b.service_id === p[0] && b.git_sha === p[1] && !(b.status === "failed" && (b.failure_reason ?? "").startsWith(prefix))
      );
      return { rows: hit ? [{}] : [] };
    }
    if (/JOIN monitored_services s ON s\.id = b\.service_id/.test(s)) {
      const svc = services.find((x) => x.tenant_id === p[0] && x.name === p[1]);
      const hit = builds.filter((b) => svc && b.service_id === svc.id && b.status === "success").at(-1);
      return { rows: hit ? [{ id: hit.id, service_id: hit.service_id, git_sha: hit.git_sha, image_ref: hit.image_ref }] : [] };
    }
    return { rows: [] };
  });

  const txCalls: number[] = [];
  const tx: TransactionRunner = async (fn) => {
    txCalls.push(1);
    return fn(query as unknown as QueryFn);
  };

  state.yamlFor = (path: string) => {
    const m = /builds\/([^/]+)\/workspace/.exec(path);
    const b = builds.find((x) => x.id === m?.[1]);
    return services.find((x) => x.id === b?.service_id)?.yaml ?? "";
  };

  const incidentsRaised = () => sqlLog.filter((x) => /FROM incidents|INSERT INTO incidents/.test(x)).length;
  const buildsOf = (id: string) => builds.filter((b) => b.service_id === id);
  return { builds, addBuild, query: query as unknown as QueryFn, tx, txCalls, sqlLog, incidentsRaised, buildsOf };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const svc = (o: Partial<Svc> & { id: string }): Svc => ({
  tenant_id: "t1",
  name: o.id,
  git_repo_url: REPO_SSH,
  branch: "main",
  depends_on: [],
  locked: false,
  yaml: NO_DEPS_YAML,
  ...o
});

const app = () => svc({ id: "app", name: "mochimask-app", git_repo_url: REPO_HTTPS });
const base = () => svc({ id: "base", name: "mochimask-base" });
const worker = (deps = ["mochimask-app"]) =>
  svc({ id: "worker", name: "mochimask-worker", depends_on: deps, yaml: workerYaml(deps) });
const other = () =>
  svc({ id: "other", name: "elsewhere", git_repo_url: OTHER_REPO, depends_on: ["mochimask-app"], yaml: workerYaml(["mochimask-app"]) });

describe("dependsOn same-commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.spawns = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ delivered: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  describe("poller", () => {
    it("skips services with a same-repo dependency; still polls the rest", async () => {
      const db = makeDb([app(), worker(), other()]);
      await runPollOnce(db.query, logger, db.tx);
      expect(db.buildsOf("app").map((b) => b.git_sha)).toEqual([HEAD]);
      expect(db.buildsOf("other").map((b) => b.git_sha)).toEqual([HEAD]); // cross-repo dep → polled
      expect(db.buildsOf("worker")).toEqual([]);
      // ls-remote ran for app + other only.
      expect(state.spawns.filter((c) => c.args.includes("ls-remote"))).toHaveLength(2);
    });

    it("no-ops on an empty service list", async () => {
      const db = makeDb([]);
      await runPollOnce(db.query, logger, db.tx);
      expect(db.builds).toEqual([]);
    });
  });

  describe("chain trigger", () => {
    it("queues same-repo dependents pinned to the dependency's sha (not HEAD), cross-repo ones as before", async () => {
      const db = makeDb([app(), worker(), other()]);
      db.addBuild({ service_id: "app", git_sha: X, status: "queued" });

      await runDrainOnce(db.query, logger, db.tx);

      expect(db.buildsOf("app")[0].status).toBe("success");
      const w = db.buildsOf("worker");
      expect(w).toHaveLength(1);
      expect(w[0]).toMatchObject({ git_sha: X, status: "queued", triggered_by: "poll" });
      expect(db.txCalls).toHaveLength(1);
      // Cross-repo dependent: manual-style build, HEAD resolved at run time.
      expect(db.buildsOf("other")).toMatchObject([{ git_sha: "", triggered_by: "manual" }]);
      // The chain build never consulted the branch head.
      expect(state.spawns.some((c) => c.args.includes("ls-remote"))).toBe(false);

      // The pinned dependent then builds against the dep image AT X.
      state.spawns = [];
      await runDrainOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker")[0].status).toBe("success");
      const dockerBuild = state.spawns.find((c) => c.cmd === "docker" && c.args[0] === "build");
      expect(dockerBuild!.args).toContain(`APP_IMAGE=panel.dev.kaiad.dev/mochimask-app:${X}`);
    });

    it("waits until ALL same-repo deps succeeded at the sha, then queues exactly once", async () => {
      const deps = ["mochimask-app", "mochimask-base"];
      const db = makeDb([app(), base(), worker(deps)]);
      db.addBuild({ service_id: "app", git_sha: X, status: "queued" });
      await runDrainOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker")).toEqual([]);
      expect(logger.info).toHaveBeenCalledWith(
        "dependent build waiting for other same-repo deps",
        expect.objectContaining({ waiting: ["mochimask-base"] })
      );

      db.addBuild({ service_id: "base", git_sha: X, status: "queued" });
      await runDrainOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker")).toMatchObject([{ git_sha: X, status: "queued" }]);

      // A rebuild of a dep at the same sha does not duplicate the dependent
      // (first drain builds the queued worker, the second the app rebuild).
      db.addBuild({ service_id: "app", git_sha: X, status: "queued", triggered_by: "manual" });
      await runDrainOnce(db.query, logger, db.tx);
      await runDrainOnce(db.query, logger, db.tx);
      expect(db.buildsOf("app").map((b) => b.status)).toEqual(["success", "success"]);
      expect(db.buildsOf("worker")).toMatchObject([{ git_sha: X, status: "success" }]);
      expect(logger.info).toHaveBeenCalledWith(
        "dependent build already exists at sha",
        expect.objectContaining({ dependentServiceId: "worker" })
      );
    });
  });

  describe("same-sha resolution", () => {
    it("blocks a dependent whose dependency failed at that commit: no deploy, no incident", async () => {
      const db = makeDb([app(), worker()]);
      db.addBuild({ service_id: "app", git_sha: OLD, status: "success" }); // older success must not be used
      db.addBuild({ service_id: "app", git_sha: X, status: "failed", failure_reason: "docker build exited 1" });
      db.addBuild({ service_id: "worker", git_sha: X, status: "queued" });

      await runDrainOnce(db.query, logger, db.tx);

      const w = db.buildsOf("worker")[0];
      expect(w.status).toBe("failed");
      expect(w.failure_reason).toBe("blocked: dependency mochimask-app at ccccccc failed");
      expect(w.log).toContain("blocked: dependency mochimask-app at ccccccc failed");
      expect(db.incidentsRaised()).toBe(0);
      expect(db.sqlLog.some((x) => /FROM agent_services/.test(x))).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(state.spawns.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
    });

    it("blocks while the dependency at that commit is still running", async () => {
      const db = makeDb([app(), worker()]);
      db.addBuild({ service_id: "app", git_sha: X, status: "running" });
      db.addBuild({ service_id: "worker", git_sha: X, status: "queued" });
      await runDrainOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker")[0].failure_reason).toBe(
        "blocked: dependency mochimask-app at ccccccc is still running"
      );
    });

    it("applies to manual builds: HEAD is pinned first, then the dep must exist at HEAD", async () => {
      const db = makeDb([app(), worker()]);
      db.addBuild({ service_id: "app", git_sha: X, status: "success" });
      db.addBuild({ service_id: "worker", git_sha: "", status: "queued", triggered_by: "manual" });
      await runDrainOnce(db.query, logger, db.tx);
      const w = db.buildsOf("worker")[0];
      expect(w.git_sha).toBe(HEAD);
      expect(w.failure_reason).toBe("blocked: dependency mochimask-app has no build at aaaaaaa");
      expect(db.incidentsRaised()).toBe(0);
    });

    it("a real failure (not blocked) still raises an incident", async () => {
      const db = makeDb([app(), svc({ id: "bad", yaml: "this: : : not yaml ::::" })]);
      db.addBuild({ service_id: "bad", git_sha: X, status: "queued" });
      await runDrainOnce(db.query, logger, db.tx);
      expect(db.buildsOf("bad")[0].status).toBe("failed");
      expect(db.incidentsRaised()).toBeGreaterThan(0);
    });

    it("a cross-repo dep with no successful build is a real (incident-raising) failure, not blocked", async () => {
      const db = makeDb([
        app(),
        svc({ id: "x", git_repo_url: OTHER_REPO, depends_on: ["mochimask-app"], yaml: workerYaml(["mochimask-app"]) })
      ]);
      db.addBuild({ service_id: "x", git_sha: X, status: "queued" });
      await runDrainOnce(db.query, logger, db.tx);
      const b = db.buildsOf("x")[0];
      expect(b.status).toBe("failed");
      expect(b.failure_reason).toMatch(/has no successful build yet/);
      expect(b.failure_reason).not.toMatch(/^blocked: /);
      expect(db.incidentsRaised()).toBeGreaterThan(0);
    });

    it("fails on unresolved template vars after resolving a same-commit dep", async () => {
      const db = makeDb([
        app(),
        svc({
          id: "worker",
          name: "mochimask-worker",
          depends_on: ["mochimask-app"],
          yaml: workerYaml(["mochimask-app"]).replace("{mochimask_app_image_ref}", "{typo_var}")
        })
      ]);
      db.addBuild({ service_id: "app", git_sha: X, status: "success" });
      db.addBuild({ service_id: "worker", git_sha: X, status: "queued" });
      await runDrainOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker")[0].failure_reason).toMatch(/unresolved template variable\(s\).*typo_var/);
    });
  });

  describe("chain trigger failures", () => {
    it("logs a failed dependent enqueue, keeps going, and never fails the dep build", async () => {
      const db = makeDb([app(), worker(), svc({ id: "w2", name: "w2", depends_on: ["mochimask-app"], yaml: workerYaml(["mochimask-app"]) })]);
      db.addBuild({ service_id: "app", git_sha: X, status: "queued" });
      const failingTx: TransactionRunner = async () => {
        throw new Error("tx failed");
      };
      await runDrainOnce(db.query, logger, failingTx);
      expect(db.buildsOf("app")[0].status).toBe("success");
      expect(logger.error).toHaveBeenCalledWith(
        "dependent enqueue failed",
        expect.objectContaining({ dependentServiceId: "worker", err: "tx failed" })
      );
      expect(logger.error).toHaveBeenCalledWith(
        "dependent enqueue failed",
        expect.objectContaining({ dependentServiceId: "w2" })
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "dependent-build trigger failed",
        expect.objectContaining({ err: expect.stringContaining("mochimask-worker: tx failed") })
      );
    });
  });

  describe("catch-up pass", () => {
    it("queues a dependent missing at the latest commit all its same-repo deps succeeded at", async () => {
      const db = makeDb([app(), worker()]);
      db.addBuild({ service_id: "app", git_sha: OLD, status: "success" });
      db.addBuild({ service_id: "app", git_sha: HEAD, status: "success" }); // poller sees HEAD as built
      await runPollOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker")).toMatchObject([{ git_sha: HEAD, status: "queued", triggered_by: "poll" }]);
      expect(db.buildsOf("app")).toHaveLength(2); // app itself not re-queued
    });

    it("recovers a blocked dependent build", async () => {
      const db = makeDb([app(), worker()]);
      db.addBuild({ service_id: "app", git_sha: HEAD, status: "success" });
      db.addBuild({ service_id: "worker", git_sha: HEAD, status: "failed", failure_reason: "blocked: dependency mochimask-app at aaaaaaa is still running" });
      await runPollOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker").map((b) => b.status)).toEqual(["failed", "queued"]);
    });

    it("does not re-queue a dependent that really failed", async () => {
      const db = makeDb([app(), worker()]);
      db.addBuild({ service_id: "app", git_sha: HEAD, status: "success" });
      db.addBuild({ service_id: "worker", git_sha: HEAD, status: "failed", failure_reason: "docker build exited 1" });
      await runPollOnce(db.query, logger, db.tx);
      expect(db.buildsOf("worker")).toHaveLength(1);
    });

    it("needs every same-repo dep to have succeeded at the commit", async () => {
      const deps = ["mochimask-app", "mochimask-base"];
      const db = makeDb([app(), base(), worker(deps)]);
      db.addBuild({ service_id: "app", git_sha: X, status: "success" });
      db.addBuild({ service_id: "base", git_sha: X, status: "failed", failure_reason: "boom" });
      const services = [app(), base(), worker(deps)].map((s) => ({
        id: s.id, tenantId: s.tenant_id, name: s.name, gitRepoUrl: s.git_repo_url, branch: s.branch, dependsOn: s.depends_on
      }));
      const graph = await listServiceDependencyRefs(db.query);
      await runDependentCatchUp(db.query, db.tx, logger, services, graph);
      expect(db.buildsOf("worker")).toEqual([]);

      db.addBuild({ service_id: "base", git_sha: X, status: "success" });
      await runDependentCatchUp(db.query, db.tx, logger, services, graph);
      await runDependentCatchUp(db.query, db.tx, logger, services, graph);
      expect(db.buildsOf("worker")).toMatchObject([{ git_sha: X }]); // idempotent across passes
    });

    it("logs and continues when one dependent's catch-up fails", async () => {
      const db = makeDb([app(), worker()]);
      db.addBuild({ service_id: "app", git_sha: X, status: "success" });
      const failingTx: TransactionRunner = async () => {
        throw new Error("db down");
      };
      const graph = await listServiceDependencyRefs(db.query);
      await runDependentCatchUp(db.query, failingTx, logger, [
        { id: "worker", tenantId: "t1", name: "mochimask-worker", gitRepoUrl: REPO_SSH, branch: "main", dependsOn: ["mochimask-app"] }
      ], graph);
      expect(logger.error).toHaveBeenCalledWith(
        "catch-up for dependent failed",
        expect.objectContaining({ serviceId: "worker", err: "db down" })
      );
    });
  });
});
