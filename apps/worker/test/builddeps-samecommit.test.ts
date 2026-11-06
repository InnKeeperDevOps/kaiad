import { describe, it, expect, vi } from "vitest";
import { BuildBlockedError, BuildDepsError, resolveDeps } from "../src/builddeps.js";
import type { QueryFn } from "@sm/db";
import type { PipelineDefinition } from "@sm/contracts";

const SHA = "1234567".padEnd(40, "a");
const OLD = "b".repeat(40);
const REPO = "git@github.com:acme/mochimask.git";

const pl = (dependsOn: string[]) => ({ dependsOn }) as unknown as PipelineDefinition;

const services = [
  { id: "app-id", name: "mochimask-app", gitRepoUrl: "https://github.com/acme/mochimask", branch: "main" },
  { id: "lib-id", name: "shared-lib", gitRepoUrl: "https://github.com/acme/lib", branch: "main" }
];
const dependent = { gitRepoUrl: REPO, branch: "main", gitSha: SHA, services };

/**
 * Routes the two dep lookups: getServiceBuildAtSha (same-repo path) and
 * getLatestSuccessfulBuildByServiceName (legacy path).
 */
function makeQuery(opts: {
  atSha?: Record<string, unknown> | null;
  latest?: Record<string, unknown> | null;
}): QueryFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (sql: string) => {
    if (/WHEN 'success' THEN 0/.test(sql)) return { rows: opts.atSha ? [opts.atSha] : [] };
    if (/JOIN monitored_services s ON s\.id = b\.service_id/.test(sql)) {
      return { rows: opts.latest ? [opts.latest] : [] };
    }
    throw new Error(`unexpected sql ${sql}`);
  }) as unknown as QueryFn & ReturnType<typeof vi.fn>;
}

describe("resolveDeps — same-commit rule for same-repo deps", () => {
  it("uses the dep's successful build at the dependent's sha, not its latest", async () => {
    const query = makeQuery({
      atSha: { id: "app-at-sha", status: "success", git_sha: SHA, image_ref: `reg/mochimask-app:${SHA}`, failure_reason: null },
      latest: { id: "app-latest", service_id: "app-id", git_sha: OLD, image_ref: `reg/mochimask-app:${OLD}` }
    });
    const { vars, resolved } = await resolveDeps(query, "t1", pl(["mochimask-app"]), { dependent });
    expect(resolved).toEqual([
      { depName: "mochimask-app", buildId: "app-at-sha", gitSha: SHA, imageRef: `reg/mochimask-app:${SHA}` }
    ]);
    expect(vars.mochimask_app_image_ref).toBe(`reg/mochimask-app:${SHA}`);
    // Pinned lookup: (dep service id, dependent sha).
    expect(query.mock.calls[0][1]).toEqual(["app-id", SHA]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: "failed" }, "blocked: dependency mochimask-app at 1234567 failed"],
    [{ status: "queued" }, "blocked: dependency mochimask-app at 1234567 is still queued"],
    [{ status: "running" }, "blocked: dependency mochimask-app at 1234567 is still running"],
    [{ status: "no_pipeline" }, "blocked: dependency mochimask-app at 1234567 produced no image (status no_pipeline)"]
  ])("blocks when the dep build at the sha is %o", async (row, reason) => {
    const query = makeQuery({
      atSha: { id: "x", git_sha: SHA, image_ref: null, failure_reason: null, ...row },
      // A newer/older success elsewhere must NOT be used as a fallback.
      latest: { id: "app-latest", service_id: "app-id", git_sha: OLD, image_ref: "reg/old" }
    });
    const err = await resolveDeps(query, "t1", pl(["mochimask-app"]), { dependent }).catch((e) => e);
    expect(err).toBeInstanceOf(BuildBlockedError);
    expect(err).toBeInstanceOf(BuildDepsError);
    expect(err.message).toBe(reason);
    expect(err.depName).toBe("mochimask-app");
  });

  it("blocks when the dep never built that commit", async () => {
    const query = makeQuery({ atSha: null, latest: { id: "l", service_id: "app-id", git_sha: OLD, image_ref: "r" } });
    await expect(resolveDeps(query, "t1", pl(["mochimask-app"]), { dependent })).rejects.toThrow(
      "blocked: dependency mochimask-app has no build at 1234567"
    );
  });

  it("keeps latest-successful resolution for deps in another repo", async () => {
    const query = makeQuery({ latest: { id: "lib-latest", service_id: "lib-id", git_sha: OLD, image_ref: "reg/lib:x" } });
    const { resolved } = await resolveDeps(query, "t1", pl(["shared-lib"]), { dependent });
    expect(resolved[0]).toMatchObject({ buildId: "lib-latest", gitSha: OLD });
  });

  it("keeps latest-successful resolution for the same repo on another branch", async () => {
    const query = makeQuery({ latest: { id: "l", service_id: "app-id", git_sha: OLD, image_ref: null } });
    const { resolved } = await resolveDeps(query, "t1", pl(["mochimask-app"]), {
      dependent: { ...dependent, branch: "develop" }
    });
    expect(resolved[0].buildId).toBe("l");
  });

  it("treats a dep that isn't a known service with the legacy (non-blocked) error", async () => {
    const err = await resolveDeps(makeQuery({}), "t1", pl(["ghost"]), { dependent }).catch((e) => e);
    expect(err).toBeInstanceOf(BuildDepsError);
    expect(err).not.toBeInstanceOf(BuildBlockedError);
  });

  it("refuses (logs + throws) an unpinned dependent build", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        resolveDeps(makeQuery({}), "t1", pl(["mochimask-app"]), { dependent: { ...dependent, gitSha: "" } })
      ).rejects.toThrow(/no git SHA pinned/);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
