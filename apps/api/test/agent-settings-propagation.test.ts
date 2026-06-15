/**
 * Integration test: Kaiad emits a `hello` frame on every new agent
 * WebSocket connection. Starts the Kaiad API server in-process and
 * connects a WebSocket client (acting as the agent) to verify the hello
 * frame arrives with the expected shape.
 */
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildServer } from "../src/server.js";
import { __resetTenantStoreForTests, upsertTenantSettings } from "../src/store.js";

// ---------------------------------------------------------------------------
// Shared server fixture
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildServer>;
let wsBaseUrl: string;

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  app = buildServer({ readinessCheckers: [] });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
}, 15_000);

afterAll(async () => {
  await app.close();
  delete process.env.KAIAD_SKIP_SETUP_GATE;
  delete process.env.SM_ENROLLMENT_STORE;
});

afterEach(() => {
  __resetTenantStoreForTests();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HelloFrame = {
  type: string;
  service: string;
  runtime?: { backend: string };
};

/** Connect to /realtime and capture the first (hello) frame. */
function connectAndCaptureHello(): Promise<{ ws: WebSocket; hello: HelloFrame }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBaseUrl}/realtime`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Timeout waiting for hello frame"));
    }, 5_000);

    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.once("message", (data) => {
      clearTimeout(timer);
      try {
        const hello = JSON.parse(data.toString()) as HelloFrame;
        resolve({ ws, hello });
      } catch (err) {
        ws.close();
        reject(err);
      }
    });
  });
}

/** Wait for the socket to reach CLOSED state. */
function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", resolve));
}

// ---------------------------------------------------------------------------
// Hello frame emitted on agent connect
// ---------------------------------------------------------------------------

describe("agent hello frame", () => {
  it("emits a realtime hello with the docker runtime backend", async () => {
    const { ws, hello } = await connectAndCaptureHello();
    expect(hello.type).toBe("hello");
    expect(hello.service).toBe("realtime");
    expect(hello.runtime?.backend).toBe("docker");
    ws.close();
    await waitForClose(ws);
  });

  it("still emits a hello after tenant settings are upserted", async () => {
    await upsertTenantSettings({ tenantId: "t-1" });
    const { ws, hello } = await connectAndCaptureHello();
    expect(hello.type).toBe("hello");
    expect(hello.runtime?.backend).toBe("docker");
    ws.close();
    await waitForClose(ws);
  });
});
