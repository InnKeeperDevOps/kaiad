// Transaction helper for the raw-SQL QueryFn layer.
//
// A plain QueryFn (e.g. `(sql, params) => pool.query(sql, params)`) runs
// every statement on whatever pool connection is free, so BEGIN/COMMIT
// issued through it would land on different connections and mean
// nothing. `withTransaction` checks out ONE client, runs BEGIN, hands
// the callback a QueryFn bound to that client, then COMMITs.
//
// Failure paths:
//   - callback / COMMIT throws → ROLLBACK, log, rethrow the original error.
//   - ROLLBACK itself throws   → log, and release the client WITH the
//     error so pg destroys it instead of returning a connection in an
//     unknown transaction state to the pool.
//   - The client is always released (finally).
//
// Keep callbacks short: no network calls (git, HTTP) inside a
// transaction — they hold a pool connection and any locks taken.
import type { QueryFn } from "./queries.js";

/** The subset of pg.PoolClient this helper needs. */
export interface TransactionClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  /** pg semantics: a truthy argument destroys the client instead of pooling it. */
  release(err?: Error | boolean): void;
}

/** The subset of pg.Pool this helper needs. */
export interface TransactionPool {
  connect(): Promise<TransactionClient>;
}

export interface TransactionLogger {
  error: (msg: string, ctx?: unknown) => void;
}

/** Runs `fn` inside one BEGIN/COMMIT on a single connection. */
export type TransactionRunner = <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;

const defaultLogger: TransactionLogger = {
  error: (m, c) => console.error(`[db][ERR] ${m}`, c ?? "")
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export async function withTransaction<T>(
  pool: TransactionPool,
  fn: (query: QueryFn) => Promise<T>,
  logger: TransactionLogger = defaultLogger
): Promise<T> {
  let client: TransactionClient;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.error("transaction: pool.connect failed", { err: toError(err).message });
    throw err;
  }
  // Set only when ROLLBACK fails — tells pg to destroy the connection.
  let releaseErr: Error | undefined;
  try {
    await client.query("BEGIN");
    const txQuery: QueryFn = async (sql, params) => {
      const r = await client.query(sql, params);
      return { rows: r.rows as Record<string, unknown>[] };
    };
    const result = await fn(txQuery);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    logger.error("transaction failed — rolling back", { err: toError(err).message });
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      releaseErr = toError(rollbackErr);
      logger.error("transaction ROLLBACK failed — destroying client", {
        err: toError(err).message,
        rollbackErr: releaseErr.message
      });
    }
    throw err;
  } finally {
    client.release(releaseErr);
  }
}

/** Bind a pool (and logger) into a reusable TransactionRunner. */
export function createTransactionRunner(
  pool: TransactionPool,
  logger: TransactionLogger = defaultLogger
): TransactionRunner {
  return (fn) => withTransaction(pool, fn, logger);
}
