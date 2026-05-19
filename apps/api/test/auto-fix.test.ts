import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { __resetDomainStoreForTests } from "../src/domainStore.js";
import type { KaiadFixParams, KaiadFixResult } from "../src/kaiadFix.js";
import {
  __resetAuthStoreForTests,
  createMemoryAuthStore,
  seedDevUser
} from "../src/memoryAuthStore.js";
import { __resetTenantStoreForTests } from "../src/store.js";

// The fix runs IN kaiad now (not the agent). Stub the runner so the
// test asserts the in-kaiad lifecycle without cloning a real repo.
const fixCalls: KaiadFixParams[] = [];
let fixResult: KaiadFixResult = { ok: true, commitSha: "deadbee1234", output: "ok" };
let app: ReturnType<typeof buildServer>;
let token: string;

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  __resetAuthStoreForTests();
  const authStore = createMemoryAuthStore();
  await seedDevUser(authStore);
  app = buildServer({
    authStore,
    runFix: async (p) => {
      fixCalls.push(p);
      return fixResult;
    }
  });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "admin@example.com", password: "admin" }
  });
  token = (res.json() as { token: string }).token;
});

beforeEach(() => {
  __resetDomainStoreForTests();
  __resetTenantStoreForTests();
  fixCalls.splice(0);
  fixResult = { ok: true, commitSha: "deadbee1234", output: "ok" };
});

afterAll(async () => {
  await app.close();
});

async function bringAgentOnline(agentId: string) {
  const ws = await app.injectWS("/realtime");
  await new Promise<void>((r) => ws.once("message", () => r())); // hello
  ws.send(
    JSON.stringify({
      type: "heartbeat",
      agentId,
      ts: new Date().toISOString(),
      capacity: 4,
      tenantId: "t-1"
    })
  );
  await new Promise<void>((r) => ws.once("message", () => r())); // ack
  return ws;
}

async function createSshKey(name = "deploy") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/ssh-keys",
    headers: { authorization: `Bearer ${token}` },
    payload: { name, type: "uploaded", privateKey: "fake-key-material" }
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function createService(opts: { sshKeyId?: string; agentId: string; name: string }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/services",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: opts.name,
      gitRepoUrl: `git@github.com:example/${opts.name}.git`,
      sshKeyId: opts.sshKeyId,
      branch: "main",
      agentIds: [opts.agentId]
    }
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function listGroupsForService(serviceId: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/services/${serviceId}/error-groups`,
    headers: { authorization: `Bearer ${token}` }
  });
  return (res.json() as { groups: { status: string; sampleMessage: string }[] }).groups;
}

async function waitForGroupStatus(serviceId: string, status: string, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const groups = await listGroupsForService(serviceId);
    if (groups[0]?.status === status) return groups;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  return listGroupsForService(serviceId);
}

describe("auto-fix loop end-to-end (runs in kaiad)", () => {
  it("runs the fix in kaiad and marks the group fixed on success", async () => {
    const ws = await bringAgentOnline("a-fix");
    const sshKeyId = await createSshKey();
    const serviceId = await createService({ sshKeyId, agentId: "a-fix", name: "checkout" });

    const ack = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(
      JSON.stringify({
        type: "app_log_error",
        agentId: "a-fix",
        serviceId,
        ts: new Date().toISOString(),
        message: "TypeError: cannot read property foo of null",
        contextLines: ["startup ok", "request received", "boom"]
      })
    );
    await ack;

    const groups = await waitForGroupStatus(serviceId, "fixed");
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("fixed");
    expect(groups[0].sampleMessage).toContain("TypeError");

    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0].repoUrl).toBe("git@github.com:example/checkout.git");
    expect(fixCalls[0].branch).toBe("main");
    expect(fixCalls[0].sshKeyType).toBe("uploaded");
    // Upload normalization guarantees a trailing newline (OpenSSH needs it).
    expect(fixCalls[0].sshKeyValue).toBe("fake-key-material\n");
    expect(fixCalls[0].executor).toBe("claude");
    expect(fixCalls[0].errorMessage).toContain("TypeError");
    ws.terminate();
  });

  it("marks the group missing_auth when service has no sshKeyId (no fix run)", async () => {
    const ws = await bringAgentOnline("a-noauth");
    const serviceId = await createService({ agentId: "a-noauth", name: "noauth" });

    const ack = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(
      JSON.stringify({
        type: "app_log_error",
        agentId: "a-noauth",
        serviceId,
        ts: new Date().toISOString(),
        message: "ECONNREFUSED 127.0.0.1:5432",
        contextLines: []
      })
    );
    await ack;
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(fixCalls).toHaveLength(0);
    const groups = await listGroupsForService(serviceId);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("missing_auth");
    ws.terminate();
  });

  it("on a failed fix the group returns to open (retryable)", async () => {
    fixResult = { ok: false, reason: "cli_failed", output: "claude exited 1" };
    const ws = await bringAgentOnline("a-failfix");
    const sshKeyId = await createSshKey("failkey");
    const serviceId = await createService({ sshKeyId, agentId: "a-failfix", name: "failsvc" });

    const ack = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(
      JSON.stringify({
        type: "app_log_error",
        agentId: "a-failfix",
        serviceId,
        ts: new Date().toISOString(),
        message: "RuntimeError: kaboom",
        contextLines: []
      })
    );
    await ack;

    const groups = await waitForGroupStatus(serviceId, "open");
    expect(fixCalls).toHaveLength(1);
    expect(groups[0].status).toBe("open");
    ws.terminate();
  });

  it("filters out user-input errors and does not create a group", async () => {
    const ws = await bringAgentOnline("a-userinp");
    const sshKeyId = await createSshKey("uikey");
    const serviceId = await createService({ sshKeyId, agentId: "a-userinp", name: "uinput" });

    const ack = new Promise<void>((r) => ws.once("message", () => r()));
    ws.send(
      JSON.stringify({
        type: "app_log_error",
        agentId: "a-userinp",
        serviceId,
        ts: new Date().toISOString(),
        message: "HTTP 400 bad request: missing required field email",
        contextLines: []
      })
    );
    await ack;
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(fixCalls).toHaveLength(0);
    const groups = await listGroupsForService(serviceId);
    expect(groups).toHaveLength(0);
    ws.terminate();
  });
});
