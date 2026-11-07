// /api/v1/admin/build-settings — auth + validation against the memory
// harness (401/403/400/503) and the 200 round-trip against a real
// Postgres when TEST_DATABASE_URL is set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { hasTestDb, openTestPool, TEST_DB_URL } from "./_pg.js";

describe("admin build-settings routes (memory harness)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let ownerToken: string;

  beforeAll(async () => {
    process.env.KAIAD_SKIP_SETUP_GATE = "1";
    process.env.SM_ENROLLMENT_STORE = "memory";
    const { buildServer } = await import("../src/server.js");
    const { __resetAuthStoreForTests, createMemoryAuthStore, seedDevUser } = await import("../src/memoryAuthStore.js");
    const { __resetApiCredentialStoreForTests } = await import("../src/apiCredentialsStore.js");
    __resetAuthStoreForTests();
    await __resetApiCredentialStoreForTests();
    const authStore = createMemoryAuthStore();
    await seedDevUser(authStore);
    app = buildServer({ authStore });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "admin@example.com", password: "admin" }
    });
    ownerToken = (res.json() as { token: string }).token;
  });

  afterAll(async () => {
    await app?.close();
  });

  const auth = () => ({ authorization: `Bearer ${ownerToken}` });

  it("GET/PUT reject unauthenticated callers with 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/build-settings" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "PUT", url: "/api/v1/admin/build-settings", payload: { maxConcurrentBuilds: 2 } })).statusCode
    ).toBe(401);
  });

  it("GET/PUT reject a credential without settings:manage with 403", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: auth(),
      payload: { name: "limited", scopes: ["mcp.read"], permissions: ["services:read"] }
    });
    expect(created.statusCode).toBe(200);
    const { token } = created.json() as { token: string };
    const h = { authorization: `Bearer ${token}` };
    const get = await app.inject({ method: "GET", url: "/api/v1/admin/build-settings", headers: h });
    expect(get.statusCode).toBe(403);
    expect((get.json() as { message: string }).message).toContain("settings:manage");
    const put = await app.inject({ method: "PUT", url: "/api/v1/admin/build-settings", headers: h, payload: { maxConcurrentBuilds: 2 } });
    expect(put.statusCode).toBe(403);
  });

  it("PUT validates the body before touching persistence (400)", async () => {
    for (const payload of [{}, { maxConcurrentBuilds: 0 }, { maxConcurrentBuilds: 9 }, { maxConcurrentBuilds: 2.5 }, { maxConcurrentBuilds: "3" }]) {
      const res = await app.inject({ method: "PUT", url: "/api/v1/admin/build-settings", headers: auth(), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect((res.json() as { code: string }).code).toBe("BAD_REQUEST");
    }
  });

  it("returns 503 when no database is configured", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const get = await app.inject({ method: "GET", url: "/api/v1/admin/build-settings", headers: auth() });
      expect(get.statusCode).toBe(503);
      expect((get.json() as { code: string }).code).toBe("DB_UNAVAILABLE");
      const put = await app.inject({ method: "PUT", url: "/api/v1/admin/build-settings", headers: auth(), payload: { maxConcurrentBuilds: 2 } });
      expect(put.statusCode).toBe(503);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});

const d = hasTestDb ? describe : describe.skip;

d("admin build-settings routes (Postgres)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let pool: Pool;
  const AUTH = { authorization: "Bearer dev-token" };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.KAIAD_SKIP_SETUP_GATE = "1";
    pool = await openTestPool();
    const { buildServer } = await import("../src/server.js");
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("GET returns the settings, live counts and disk figures; PUT persists + records the user", async () => {
    const before = await app.inject({ method: "GET", url: "/api/v1/admin/build-settings", headers: AUTH });
    expect(before.statusCode).toBe(200);
    const body = before.json() as {
      maxConcurrentBuilds: number;
      running: number;
      queued: number;
      buildsDisk: { freeBytes: number; totalBytes: number } | null;
      updatedAt: string;
      updatedBy: string | null;
    };
    expect(body.maxConcurrentBuilds).toBeGreaterThanOrEqual(1);
    expect(typeof body.running).toBe("number");
    expect(typeof body.queued).toBe("number");
    expect(body.buildsDisk === null || body.buildsDisk.totalBytes >= body.buildsDisk.freeBytes).toBe(true);
    try {
      const target = body.maxConcurrentBuilds === 3 ? 4 : 3;
      const put = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/build-settings",
        headers: AUTH,
        payload: { maxConcurrentBuilds: target }
      });
      expect(put.statusCode).toBe(200);
      const after = put.json() as { maxConcurrentBuilds: number; updatedBy: string | null };
      expect(after.maxConcurrentBuilds).toBe(target);
      expect(after.updatedBy).toBeTruthy();
      const again = await app.inject({ method: "GET", url: "/api/v1/admin/build-settings", headers: AUTH });
      expect((again.json() as { maxConcurrentBuilds: number }).maxConcurrentBuilds).toBe(target);
      const { rows } = await pool.query(`select max_concurrent_builds, updated_by from build_worker_settings where id = 1`);
      expect(rows[0].max_concurrent_builds).toBe(target);
      expect(rows[0].updated_by).toBe(after.updatedBy);
    } finally {
      await app.inject({
        method: "PUT",
        url: "/api/v1/admin/build-settings",
        headers: AUTH,
        payload: { maxConcurrentBuilds: body.maxConcurrentBuilds }
      });
    }
  });
});
