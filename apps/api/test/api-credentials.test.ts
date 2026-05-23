import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import {
  __resetAuthStoreForTests,
  createMemoryAuthStore,
  seedDevUser
} from "../src/memoryAuthStore.js";
import { __resetTenantStoreForTests } from "../src/store.js";
import { __resetApiCredentialStoreForTests } from "../src/apiCredentialsStore.js";

let app: ReturnType<typeof buildServer>;
let ownerToken: string;

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  __resetAuthStoreForTests();
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

beforeEach(async () => {
  __resetTenantStoreForTests();
  await __resetApiCredentialStoreForTests();
});

afterAll(async () => {
  await app.close();
});

const ownerAuth = () => `Bearer ${ownerToken}`;

describe("admin api-credentials CRUD", () => {
  it("rejects unauthenticated POST", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      payload: { name: "operator", scopes: ["enrollment-tokens.create"] }
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a credential and returns the token exactly once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() },
      payload: { name: "operator", scopes: ["enrollment-tokens.create"] }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; name: string; scopes: string[]; token: string };
    expect(body.token).toMatch(/^kop_[a-f0-9]+$/);
    expect(body.scopes).toEqual(["enrollment-tokens.create"]);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() }
    });
    const listBody = list.json() as { credentials: Array<{ id: string }> };
    expect(listBody.credentials).toHaveLength(1);
    expect(listBody.credentials[0]).not.toHaveProperty("token");
  });

  it("rejects empty scopes array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() },
      payload: { name: "operator", scopes: [] }
    });
    expect(res.statusCode).toBe(400);
  });

  it("revokes a credential and removes it from acceptance", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() },
      payload: { name: "operator", scopes: ["enrollment-tokens.create"] }
    });
    const { id, token } = created.json() as { id: string; token: string };

    // Token works before revoke
    const before = await app.inject({
      method: "POST",
      url: "/api/v1/agents/enrollment-tokens",
      headers: { authorization: `Bearer ${token}` },
      payload: { ttlSeconds: 3600 }
    });
    expect(before.statusCode).toBe(200);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/api-credentials/${id}`,
      headers: { authorization: ownerAuth() }
    });
    expect(del.statusCode).toBe(204);

    // Token rejected after revoke (resolveSession returns null → 401)
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/agents/enrollment-tokens",
      headers: { authorization: `Bearer ${token}` },
      payload: { ttlSeconds: 3600 }
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("api-credential bearer in resolveSession", () => {
  it("accepts a credential with the right scope to mint enrollment tokens", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() },
      payload: { name: "operator", scopes: ["enrollment-tokens.create"] }
    });
    const { token } = created.json() as { token: string };

    const mint = await app.inject({
      method: "POST",
      url: "/api/v1/agents/enrollment-tokens",
      headers: { authorization: `Bearer ${token}` },
      payload: { ttlSeconds: 3600 }
    });
    expect(mint.statusCode).toBe(200);
    const body = mint.json() as { token: string };
    expect(typeof body.token).toBe("string");
  });

  it("rejects a credential lacking the scope with 403", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() },
      payload: { name: "limited", scopes: ["agents.read"] }
    });
    const { token } = created.json() as { token: string };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agents/enrollment-tokens",
      headers: { authorization: `Bearer ${token}` },
      payload: { ttlSeconds: 3600 }
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string };
    expect(body.code).toBe("FORBIDDEN");
  });

  it("rejects api credentials from creating other api credentials", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() },
      payload: { name: "machine", scopes: ["enrollment-tokens.create"] }
    });
    const { token } = created.json() as { token: string };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "child", scopes: ["enrollment-tokens.create"] }
    });
    expect(res.statusCode).toBe(403);
  });
});

// /registry/token is the docker-bearer flow: clients hit it with Basic
// auth where the password is the kaiad token. For api-credential
// bearers we gate on the new registry.pull / registry.push scopes
// instead of the user-session "is owner/admin?" check.
describe("api-credential scopes at /registry/token", () => {
  function basic(token: string): string {
    return "Basic " + Buffer.from(`kaiad:${token}`).toString("base64");
  }
  function decodeAccess(jwt: string): Array<{ type: string; name: string; actions: string[] }> {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8"
      )
    );
    return payload.access ?? [];
  }
  async function mintCred(scopes: string[]): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/api-credentials",
      headers: { authorization: ownerAuth() },
      payload: { name: `s-${scopes.join("+")}`, scopes }
    });
    return (created.json() as { token: string }).token;
  }

  it("registry.pull issues a pull-only access claim, no push", async () => {
    const token = await mintCred(["registry.pull"]);
    const res = await app.inject({
      method: "GET",
      url: "/registry/token?service=kaiad-registry&scope=repository:tenant-app:pull,push",
      headers: { authorization: basic(token) }
    });
    expect(res.statusCode).toBe(200);
    expect(decodeAccess(res.json().token)).toEqual([
      { type: "repository", name: "tenant-app", actions: ["pull"] }
    ]);
  });

  it("registry.push issues pull+push (push implies pull)", async () => {
    const token = await mintCred(["registry.push"]);
    const res = await app.inject({
      method: "GET",
      url: "/registry/token?service=kaiad-registry&scope=repository:tenant-app:pull,push",
      headers: { authorization: basic(token) }
    });
    expect(res.statusCode).toBe(200);
    expect(decodeAccess(res.json().token)).toEqual([
      { type: "repository", name: "tenant-app", actions: ["pull", "push"] }
    ]);
  });

  it("a credential without registry scopes can't even pull a non-public repo", async () => {
    const token = await mintCred(["enrollment-tokens.create"]);
    const res = await app.inject({
      method: "GET",
      url: "/registry/token?service=kaiad-registry&scope=repository:tenant-app:pull",
      headers: { authorization: basic(token) }
    });
    // Falls through to anonymous-pull path; the repo isn't public → 401.
    expect(res.statusCode).toBe(401);
  });
});
