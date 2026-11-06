// Enrollment-token expiry semantics: expires_at bounds the ENROLLMENT
// window only. Once an agent has connected with a token (used_at set) it
// keeps working for /realtime reconnects and registry pulls until revoked.
// Regression for gcp-01 dropping off the control plane on the first panel
// restart after its 30-day token expired.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import * as store from "../src/enrollmentStore.js";
import { hasTestDb, openTestPool, seedDevTenant, DEV_TENANT, TEST_DB_URL } from "./_pg.js";

const HOUR = 3600 * 1000;

describe("enrollment token expiry (memory store)", () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.SM_ENROLLMENT_STORE = "memory";
    await store.__resetEnrollmentStoreForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    await store.__resetEnrollmentStoreForTests();
  });

  it("a used token keeps authenticating after expiry", async () => {
    const { token } = await store.createEnrollmentTokenForTenant({ tenantId: "t-1", createdBy: "u", ttlSeconds: 3600 });
    expect(await store.validateEnrollmentToken(token)).toMatchObject({ tenantId: "t-1" });

    vi.setSystemTime(new Date(Date.now() + 48 * HOUR));
    expect(await store.validateEnrollmentToken(token)).toMatchObject({ tenantId: "t-1" });
    expect(await store.peekEnrollmentToken(token)).toMatchObject({ tenantId: "t-1" });
  });

  it("an unused token cannot enroll after expiry", async () => {
    const { token } = await store.createEnrollmentTokenForTenant({ tenantId: "t-1", createdBy: "u", ttlSeconds: 3600 });
    vi.setSystemTime(new Date(Date.now() + 2 * HOUR));
    expect(await store.validateEnrollmentToken(token)).toBeNull();
    expect(await store.peekEnrollmentToken(token)).toBeNull();
  });

  it("a used, expired token can still be revoked, and revocation wins", async () => {
    const { token, response } = await store.createEnrollmentTokenForTenant({ tenantId: "t-1", createdBy: "u", ttlSeconds: 3600 });
    await store.validateEnrollmentToken(token);
    vi.setSystemTime(new Date(Date.now() + 48 * HOUR));

    expect(await store.deactivateEnrollmentTokenForTenant("t-1", response.id)).toBe("deactivated");
    expect(await store.validateEnrollmentToken(token)).toBeNull();
    expect(await store.peekEnrollmentToken(token)).toBeNull();
    expect(await store.deactivateEnrollmentTokenForTenant("t-1", response.id)).toBe("not_revocable");
  });

  it("an unused, expired token is not revocable (nothing to revoke)", async () => {
    const { response } = await store.createEnrollmentTokenForTenant({ tenantId: "t-1", createdBy: "u", ttlSeconds: 3600 });
    vi.setSystemTime(new Date(Date.now() + 2 * HOUR));
    expect(await store.deactivateEnrollmentTokenForTenant("t-1", response.id)).toBe("not_revocable");
  });

  it("a used token is not listed as active (enrollment window semantics unchanged)", async () => {
    const { token } = await store.createEnrollmentTokenForTenant({ tenantId: "t-1", createdBy: "u", ttlSeconds: 3600 });
    await store.validateEnrollmentToken(token);
    const [listed] = await store.listEnrollmentTokensForTenant("t-1");
    expect(listed.isActive).toBe(false);
    expect(listed.usedAt).not.toBeNull();
  });
});

const d = hasTestDb ? describe : describe.skip;

d("enrollment token expiry (Postgres store)", () => {
  const originalEnv = { ...process.env };
  let pool: Pool;

  beforeAll(async () => {
    pool = await openTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // No resetDb: other Postgres suites share this DB and run in parallel.
    // Each test mints its own token, so isolation needs no truncate.
    await seedDevTenant(pool);
    process.env.DATABASE_URL = TEST_DB_URL;
    delete process.env.SM_ENROLLMENT_STORE;
    await store.__resetEnrollmentStoreForTests();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await store.__resetEnrollmentStoreForTests();
  });

  async function expire(id: string): Promise<void> {
    await pool.query(`update agent_enrollment_tokens set expires_at = now() - interval '1 day' where id = $1`, [id]);
  }

  it("used + expired: reconnect and registry peek still resolve; revoke works and wins", async () => {
    const { token, response } = await store.createEnrollmentTokenForTenant({ tenantId: DEV_TENANT, createdBy: "u", ttlSeconds: 3600 });
    expect(await store.validateEnrollmentToken(token)).toMatchObject({ tenantId: DEV_TENANT, tokenId: response.id });
    await expire(response.id);

    expect(await store.validateEnrollmentToken(token)).toMatchObject({ tokenId: response.id });
    expect(await store.peekEnrollmentToken(token)).toMatchObject({ tokenId: response.id });

    expect(await store.deactivateEnrollmentTokenForTenant(DEV_TENANT, response.id)).toBe("deactivated");
    expect(await store.validateEnrollmentToken(token)).toBeNull();
    expect(await store.peekEnrollmentToken(token)).toBeNull();
  });

  it("unused + expired: cannot enroll, cannot be revoked", async () => {
    const { token, response } = await store.createEnrollmentTokenForTenant({ tenantId: DEV_TENANT, createdBy: "u", ttlSeconds: 3600 });
    await expire(response.id);
    expect(await store.validateEnrollmentToken(token)).toBeNull();
    expect(await store.peekEnrollmentToken(token)).toBeNull();
    expect(await store.deactivateEnrollmentTokenForTenant(DEV_TENANT, response.id)).toBe("not_revocable");
  });
});
