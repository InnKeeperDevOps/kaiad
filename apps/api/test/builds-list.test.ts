import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// GET /api/v1/builds against the memory-store harness (no DATABASE_URL):
// auth + query validation + the "no builds backend" empty page. The
// Postgres-backed row shape is covered in server.integration.test.ts.

const AUTH = { authorization: "Bearer dev-token" };
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  delete process.env.DATABASE_URL;
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/v1/builds", () => {
  it("returns 401 without a bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/builds" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("returns an empty page when no builds backend is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/builds", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ builds: [], nextCursor: null });
  });

  it("accepts every documented filter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/builds?serviceId=svc-1&status=failed&triggeredBy=manual&limit=10",
      headers: AUTH
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ builds: [], nextCursor: null });
  });

  it("rejects an unknown status with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/builds?status=bogus", headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_REQUEST");
    expect(res.json().message).toContain("status");
  });

  it("rejects no_pipeline as a status filter", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/builds?status=no_pipeline", headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an out-of-range or non-numeric limit with 400", async () => {
    for (const limit of ["0", "201", "abc", "-5"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/builds?limit=${limit}`, headers: AUTH });
      expect(res.statusCode, `limit=${limit}`).toBe(400);
      expect(res.json().message).toContain("limit");
    }
  });

  it("rejects an unknown trigger with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/builds?triggeredBy=cron", headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("triggeredBy");
  });

  it("rejects a malformed cursor with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/builds?cursor=not-a-cursor", headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("cursor");
  });
});
