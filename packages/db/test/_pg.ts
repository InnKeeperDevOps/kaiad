// Real-Postgres harness for @sm/db. Opt-in via TEST_DATABASE_URL (same
// contract as apps/api/test/_pg.ts) so devs without a DB still run the
// mocked suites. Suites sharing the DB run in parallel, so NEVER truncate
// here — every suite must use unique ids.
import { Pool } from "pg";
import { ensureCoreSchema, __resetEnsureCoreSchemaForTests } from "../src/index.js";
import type { QueryFn } from "../src/queries.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL?.trim() || "";
export const hasTestDb = TEST_DB_URL.length > 0;

/** Open a pool against the test DB and ensure the core schema exists. */
export async function openTestPool(max = 6): Promise<Pool> {
  const pool = new Pool({ connectionString: TEST_DB_URL, max });
  __resetEnsureCoreSchemaForTests();
  await ensureCoreSchema(pool);
  return pool;
}

export function poolQuery(pool: Pool): QueryFn {
  return async (sql, params) => {
    const r = await pool.query(sql, params as unknown[]);
    return { rows: r.rows as Record<string, unknown>[] };
  };
}

/** Seed a tenant + service with unique ids; returns the ids. */
export async function seedTenantAndService(
  pool: Pool,
  prefix: string
): Promise<{ tenantId: string; serviceId: string }> {
  const tenantId = `${prefix}-t-${crypto.randomUUID().slice(0, 8)}`;
  const serviceId = `${prefix}-s-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(`insert into tenants (id, name) values ($1, $1)`, [tenantId]);
  await pool.query(
    `insert into monitored_services (id, tenant_id, name, git_repo_url, branch)
     values ($1, $2, $1, 'https://example.com/r.git', 'main')`,
    [serviceId, tenantId]
  );
  return { tenantId, serviceId };
}

export async function seedService(pool: Pool, tenantId: string, prefix: string): Promise<string> {
  const serviceId = `${prefix}-s-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `insert into monitored_services (id, tenant_id, name, git_repo_url, branch)
     values ($1, $2, $1, 'https://example.com/r.git', 'main')`,
    [serviceId, tenantId]
  );
  return serviceId;
}
