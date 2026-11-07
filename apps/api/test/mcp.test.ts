import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/server.js";
import { createMemoryDomainStore } from "../src/domainStore.js";
import { __resetApiCredentialStoreForTests } from "../src/apiCredentialsStore.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// End-to-end coverage for the hosted MCP endpoint (POST /mcp). We drive it with
// the real MCP SDK client over a real socket so the Streamable HTTP handshake,
// scope gating, and tool round-trips are all exercised the way a client would.

const domainStore = createMemoryDomainStore();
const app = buildServer({ domainStore });
let mcpUrl: URL;
let seededServiceId: string;

beforeAll(async () => {
  process.env.KAIAD_SKIP_SETUP_GATE = "1";
  process.env.SM_ENROLLMENT_STORE = "memory";
  await __resetApiCredentialStoreForTests();
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);

  // Seed one service under the dev tenant (Bearer dev-token => tenant t-1).
  const svc = await domainStore.createService("t-1", {
    name: "web",
    gitRepoUrl: "https://github.com/example/web",
    branch: "main"
  });
  seededServiceId = svc.id;
});

afterAll(async () => {
  await app.close();
});

/** Connect an MCP client with an optional bearer token. Caller closes it. */
async function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {}
  });
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** Mint an API credential with the given scopes via the admin REST endpoint. */
/** Mint an API credential (scopes + optional fine-grained permissions) via the admin REST endpoint. */
async function createCredential(scopes: string[], permissions: string[] = []): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/admin/api-credentials",
    headers: { authorization: "Bearer dev-token" },
    payload: { name: `mcp-${scopes.join("-") || "none"}-${permissions.join("-") || "legacy"}`, scopes, permissions }
  });
  expect(res.statusCode).toBeLessThan(300);
  return (res.json() as { token: string }).token;
}

/**
 * Parse the first text content block of a tool result as JSON. The SDK's
 * callTool result type is a union that also includes the legacy
 * `{ toolResult }` shape, so narrow at runtime instead of in the signature.
 */
function parsed(result: object): unknown {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error(`tool result has no content array: ${JSON.stringify(result)}`);
  }
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === "text");
  return JSON.parse(block?.text ?? "null");
}

/** First text block of a tool result (for error-message assertions). */
function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}
describe("MCP endpoint /mcp", () => {
  it("rejects unauthenticated connections", async () => {
    await expect(connect()).rejects.toThrow();
  });

  it("rejects credentials without an mcp scope", async () => {
    const token = await createCredential(["enrollment-tokens.create"]);
    await expect(connect(token)).rejects.toThrow();
  });

  it("exposes management tools across all domains", async () => {
    const client = await connect("dev-token");
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // One representative tool per requested domain.
      expect(names).toEqual(
        expect.arrayContaining([
          "list_services", // deployments/services
          "trigger_build", // builds
          "deploy_build", // deploys
          "set_pipeline_override", // pipeline (kaiad.yaml) editor
          "list_repositories", // registry
          "get_registry_retention", // registry retention
          "get_build_settings", // build worker settings (parallel builds)
          "set_build_settings",
          "list_agents", // agents
          "get_agent_logs", // agent self-logs
          "deactivate_enrollment_token", // enrollment tokens
          "list_ssh_keys", // ssh keys
          "get_operator_install_yaml", // operators
          "list_incidents", // incidents
          "list_error_groups", // error groups
          "list_load_balancers", // load balancers
          "get_tenant_settings", // tenant settings
          "list_users", // users
          "list_groups", // groups
          "list_permissions", // permission catalogue
          "list_api_credentials", // api credentials
          "set_oauth_provider", // oauth settings
          "get_github_app_settings" // github app settings
        ])
      );
    } finally {
      await client.close();
    }
  });

  it("runs read + write tools end-to-end for an owner session", async () => {
    const client = await connect("dev-token");
    try {
      const before = parsed(await client.callTool({ name: "list_services", arguments: {} })) as unknown[];
      expect(before.some((s) => (s as { id: string }).id === seededServiceId)).toBe(true);

      const created = parsed(
        await client.callTool({
          name: "create_service",
          arguments: { name: "api", gitRepoUrl: "https://github.com/example/api", branch: "main" }
        })
      ) as { id: string; name: string };
      expect(created.name).toBe("api");

      const after = parsed(await client.callTool({ name: "list_services", arguments: {} })) as unknown[];
      expect(after.length).toBe(before.length + 1);

      // Operator manifest generation (read tool, no DB needed).
      const yaml = await client.callTool({
        name: "get_operator_install_yaml",
        arguments: { namespace: "kaiad" }
      });
      const yamlText = (yaml.content as Array<{ type: string; text: string }>)[0].text;
      expect(yamlText).toContain("apiVersion");
    } finally {
      await client.close();
    }
  });

  it("gates mutating tools on the mcp.write scope", async () => {
    const readOnly = await createCredential(["mcp.read"]);
    const client = await connect(readOnly);
    try {
      // Read tool succeeds with mcp.read.
      const services = parsed(await client.callTool({ name: "list_services", arguments: {} })) as unknown[];
      expect(Array.isArray(services)).toBe(true);

      // Write tool is refused without mcp.write.
      const denied = await client.callTool({
        name: "create_service",
        arguments: { name: "nope", gitRepoUrl: "https://github.com/example/nope", branch: "main" }
      });
      expect(denied.isError).toBe(true);
      const text = (denied.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("mcp.write");
    } finally {
      await client.close();
    }
  });

  it("allows mutating tools with the mcp.write scope", async () => {
    const writer = await createCredential(["mcp.write"]);
    const client = await connect(writer);
    try {
      const created = parsed(
        await client.callTool({
          name: "create_service",
          arguments: { name: "worker", gitRepoUrl: "https://github.com/example/worker", branch: "main" }
        })
      ) as { name: string };
      expect(created.name).toBe("worker");
    } finally {
      await client.close();
    }
  });

  it("enforces fine-grained permissions on credentials that carry them", async () => {
    const token = await createCredential(["mcp.read", "mcp.write"], ["services:read"]);
    const client = await connect(token);
    try {
      // Granted permission → read works.
      const services = parsed(await client.callTool({ name: "list_services", arguments: {} })) as unknown[];
      expect(Array.isArray(services)).toBe(true);

      // mcp.write scope alone is not enough: services:write is missing.
      const denied = await client.callTool({
        name: "create_service",
        arguments: { name: "blocked", gitRepoUrl: "https://github.com/example/blocked", branch: "main" }
      });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain("services:write");

      // Ungranted read permission is refused too.
      const agentsDenied = await client.callTool({ name: "list_agents", arguments: {} });
      expect(agentsDenied.isError).toBe(true);
      expect(textOf(agentsDenied)).toContain("agents:read");
    } finally {
      await client.close();
    }
  });

  it("allows writes when the credential holds the matching permission", async () => {
    const token = await createCredential(["mcp.write"], ["services:read", "services:write"]);
    const client = await connect(token);
    try {
      const created = parsed(
        await client.callTool({
          name: "create_service",
          arguments: { name: "granular", gitRepoUrl: "https://github.com/example/granular", branch: "main" }
        })
      ) as { name: string };
      expect(created.name).toBe("granular");
    } finally {
      await client.close();
    }
  });

  it("refuses sensitive tools for machine API credentials", async () => {
    // Even a write-scoped legacy credential must never touch users/groups
    // or other API credentials — mirrors the REST userOnly gates.
    const token = await createCredential(["mcp.read", "mcp.write"]);
    const client = await connect(token);
    try {
      for (const name of ["list_users", "create_group", "list_api_credentials", "create_api_credential", "set_github_app_settings"]) {
        const res = await client.callTool({
          name,
          arguments:
            name === "create_group"
              ? { name: "g", description: "", permissions: [] }
              : name === "create_api_credential"
                ? { name: "c", scopes: ["mcp.read"], permissions: [] }
                : name === "set_github_app_settings"
                  ? { appId: "1" }
                  : {}
        });
        expect(res.isError, `${name} should be refused for machine credentials`).toBe(true);
        expect(textOf(res)).toContain("user session");
      }
    } finally {
      await client.close();
    }
  });

  it("runs the ssh-key lifecycle for an owner session", async () => {
    const client = await connect("dev-token");
    try {
      const created = parsed(
        await client.callTool({
          name: "create_ssh_key",
          arguments: { name: "deploy-key", type: "local_path", localPath: "/home/kaiad/.ssh/id_ed25519" }
        })
      ) as { id: string; name: string };
      expect(created.name).toBe("deploy-key");

      const listed = parsed(await client.callTool({ name: "list_ssh_keys", arguments: {} })) as {
        keys: Array<{ id: string }>;
      };
      expect(listed.keys.some((k) => k.id === created.id)).toBe(true);

      const deleted = parsed(
        await client.callTool({ name: "delete_ssh_key", arguments: { id: created.id } })
      ) as { deleted: boolean };
      expect(deleted.deleted).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("exposes users/groups and the permission catalogue to owner sessions", async () => {
    const client = await connect("dev-token");
    try {
      const perms = parsed(await client.callTool({ name: "list_permissions", arguments: {} })) as {
        permissions: string[];
      };
      expect(perms.permissions).toContain("services:write");

      // No DATABASE_URL in tests → empty lists, but the tools respond.
      const users = parsed(await client.callTool({ name: "list_users", arguments: {} })) as { users: unknown[] };
      expect(Array.isArray(users.users)).toBe(true);
      const groups = parsed(await client.callTool({ name: "list_groups", arguments: {} })) as { groups: unknown[] };
      expect(Array.isArray(groups.groups)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("manages API credentials from an owner session, rejecting bad permissions", async () => {
    const client = await connect("dev-token");
    try {
      const bad = await client.callTool({
        name: "create_api_credential",
        arguments: { name: "bad", scopes: ["mcp.read"], permissions: ["not:a-permission"] }
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain("Unknown permission");

      const created = parsed(
        await client.callTool({
          name: "create_api_credential",
          arguments: { name: "via-mcp", scopes: ["mcp.read"], permissions: ["services:read"] }
        })
      ) as { id: string; token: string; permissions: string[] };
      expect(created.token).toBeTruthy();
      expect(created.permissions).toEqual(["services:read"]);

      const listed = parsed(await client.callTool({ name: "list_api_credentials", arguments: {} })) as {
        credentials: Array<{ id: string }>;
      };
      expect(listed.credentials.some((c) => c.id === created.id)).toBe(true);

      const revoked = parsed(
        await client.callTool({ name: "revoke_api_credential", arguments: { id: created.id } })
      ) as { revoked: boolean };
      expect(revoked.revoked).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("gates the build-settings tools on settings:manage and reports a missing database", async () => {
    const owner = await connect("dev-token");
    try {
      // Memory harness has no DATABASE_URL → both tools answer with the DB error, not a crash.
      const get = await owner.callTool({ name: "get_build_settings", arguments: {} });
      expect(get.isError).toBe(true);
      expect(textOf(get)).toContain("Persistence unavailable");
      const set = await owner.callTool({ name: "set_build_settings", arguments: { maxConcurrentBuilds: 4 } });
      expect(set.isError).toBe(true);
      expect(textOf(set)).toContain("Persistence unavailable");
    } finally {
      await owner.close();
    }

    const limited = await connect(await createCredential(["mcp.read", "mcp.write"], ["services:read"]));
    try {
      const get = await limited.callTool({ name: "get_build_settings", arguments: {} });
      expect(get.isError).toBe(true);
      expect(textOf(get)).toContain("settings:manage");
      const set = await limited.callTool({ name: "set_build_settings", arguments: { maxConcurrentBuilds: 2 } });
      expect(set.isError).toBe(true);
      expect(textOf(set)).toContain("settings:manage");
    } finally {
      await limited.close();
    }
  });
});
