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
async function createCredential(scopes: string[]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/admin/api-credentials",
    headers: { authorization: "Bearer dev-token" },
    payload: { name: `mcp-${scopes.join("-") || "none"}`, scopes }
  });
  expect(res.statusCode).toBeLessThan(300);
  return (res.json() as { token: string }).token;
}

/** Parse the first text content block of a tool result as JSON. */
function parsed(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content.find((c) => c.type === "text");
  return JSON.parse(block?.text ?? "null");
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
          "list_repositories", // registry
          "list_agents", // agents
          "get_operator_install_yaml", // operators
          "list_incidents" // incidents
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
});
