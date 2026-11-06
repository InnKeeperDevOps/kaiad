import { describe, it, expect, vi } from "vitest";
import {
  createTransactionRunner,
  withTransaction,
  type TransactionClient,
  type TransactionPool
} from "../src/transaction.js";

function makePool(opts: { failOn?: string[]; connectError?: Error } = {}) {
  const statements: string[] = [];
  const client: TransactionClient & { release: ReturnType<typeof vi.fn> } = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (opts.failOn?.includes(text)) throw new Error(`${text} exploded`);
      return { rows: [{ ok: text }] };
    }),
    release: vi.fn()
  };
  const pool: TransactionPool = {
    connect: vi.fn(async () => {
      if (opts.connectError) throw opts.connectError;
      return client;
    })
  };
  return { pool, client, statements };
}

const quietLogger = () => ({ error: vi.fn() });

describe("withTransaction", () => {
  it("runs BEGIN, the callback on the same client, COMMIT, and releases to the pool", async () => {
    const { pool, client, statements } = makePool();
    const logger = quietLogger();
    const result = await withTransaction(
      pool,
      async (q) => {
        const r = await q("SELECT 1", []);
        return r.rows[0];
      },
      logger
    );
    expect(result).toEqual({ ok: "SELECT 1" });
    expect(statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("rolls back, logs, rethrows and releases the client when the callback throws", async () => {
    const { pool, client, statements } = makePool();
    const logger = quietLogger();
    const boom = new Error("callback failed");
    await expect(
      withTransaction(
        pool,
        async () => {
          throw boom;
        },
        logger
      )
    ).rejects.toBe(boom);
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(logger.error).toHaveBeenCalledWith(
      "transaction failed — rolling back",
      expect.objectContaining({ err: "callback failed" })
    );
  });

  it("rolls back when COMMIT fails", async () => {
    const { pool, client, statements } = makePool({ failOn: ["COMMIT"] });
    await expect(withTransaction(pool, async () => 1, quietLogger())).rejects.toThrow(
      "COMMIT exploded"
    );
    expect(statements).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("destroys the client (release with the error) when ROLLBACK itself fails", async () => {
    const { pool, client } = makePool({ failOn: ["ROLLBACK"] });
    const logger = quietLogger();
    const boom = new Error("callback failed");
    await expect(
      withTransaction(
        pool,
        async () => {
          throw boom;
        },
        logger
      )
    ).rejects.toBe(boom); // the ORIGINAL error surfaces, not the rollback one
    expect(client.release).toHaveBeenCalledTimes(1);
    const arg = client.release.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Error);
    expect((arg as Error).message).toBe("ROLLBACK exploded");
    expect(logger.error).toHaveBeenCalledWith(
      "transaction ROLLBACK failed — destroying client",
      expect.objectContaining({ err: "callback failed", rollbackErr: "ROLLBACK exploded" })
    );
  });

  it("logs and rethrows when the pool cannot hand out a client", async () => {
    const err = new Error("pool exhausted");
    const { pool, client } = makePool({ connectError: err });
    const logger = quietLogger();
    await expect(withTransaction(pool, async () => 1, logger)).rejects.toBe(err);
    expect(client.release).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "transaction: pool.connect failed",
      expect.objectContaining({ err: "pool exhausted" })
    );
  });

  it("wraps non-Error rejections when ROLLBACK fails", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text === "ROLLBACK") return Promise.reject("socket closed");
        if (text === "SELECT boom") return Promise.reject("bad");
        return { rows: [] };
      }),
      release: vi.fn()
    };
    const pool = { connect: async () => client };
    await expect(
      withTransaction(pool, (q) => q("SELECT boom", []), quietLogger())
    ).rejects.toBe("bad");
    expect((client.release.mock.calls[0][0] as Error).message).toBe("socket closed");
  });

  it("uses the default console logger when none is given", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { pool } = makePool({ failOn: ["BEGIN"] });
      await expect(withTransaction(pool, async () => 1)).rejects.toThrow("BEGIN exploded");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createTransactionRunner", () => {
  it("binds the pool so callers only pass the callback", async () => {
    const { pool, statements } = makePool();
    const tx = createTransactionRunner(pool, quietLogger());
    await expect(tx(async (q) => (await q("SELECT 2", [])).rows.length)).resolves.toBe(1);
    expect(statements).toEqual(["BEGIN", "SELECT 2", "COMMIT"]);
  });
});
