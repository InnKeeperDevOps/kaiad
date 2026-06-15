---
title: MCP Server
nav_order: 6
---

# MCP Server

Kaiad exposes a hosted [Model Context Protocol](https://modelcontextprotocol.io)
server so AI assistants and other MCP clients can manage the control plane
through tools instead of raw HTTP. It runs **inside the Kaiad API process** and
is reachable at:

```
POST https://<your-panel-host>/mcp
```

The endpoint speaks the **Streamable HTTP** transport in stateless mode — a
fresh MCP session per request, bound to the calling credential's tenant and
scopes. It wraps the same domain logic the REST API uses, so anything a tool
does is equivalent to the corresponding `/api/v1` call.

## Authentication & scopes

Every request must carry a bearer token in the `Authorization` header — either a
signed-in **session token** or, more typically for automation, an
[API credential]({% link admin/api-credentials.md %}). Two scopes gate access:

| Scope | Grants |
|---|---|
| `mcp.read` | Connect to `/mcp` and run read/inspect tools. |
| `mcp.write` | Connect to `/mcp` and run mutating tools too (create/update/delete, deploy, trigger builds). Implies `mcp.read`. |

A credential with neither scope is rejected at connect time (`403`). A
`mcp.read`-only credential can list and inspect but every mutating tool returns
an error telling it `mcp.write` is required. Owner/admin **session** tokens hold
both scopes implicitly.

Mint a credential scoped for MCP automation:

```bash
curl -sX POST https://<panel>/api/v1/admin/api-credentials \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"assistant","scopes":["mcp.read","mcp.write"]}'
# => { "id": "...", "token": "kop_...", "scopes": ["mcp.read","mcp.write"], ... }
```

## Connecting a client

Point any MCP client that supports Streamable HTTP at the endpoint and pass the
token as a bearer header. For example, with the TypeScript SDK:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("https://<panel>/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.KAIAD_TOKEN}` } }
});
const client = new Client({ name: "my-assistant", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
await client.callTool({ name: "list_services", arguments: {} });
```

For Claude Desktop / other config-driven clients, register an HTTP MCP server
with the URL `https://<panel>/mcp` and an `Authorization: Bearer kop_...` header.

## Tools

All tools are tenant-scoped to the calling credential.

### Services & deployments
- `list_services`, `get_service`, `list_services_for_agent` *(read)*
- `create_service`, `update_service`, `delete_service` *(write)*
- `attach_service_to_agent` (deploy), `detach_service_from_agent` (undeploy + teardown) *(write)*

### Builds
- `list_builds`, `get_build` *(read)*
- `trigger_build` *(write)*

### Registry
- `list_repositories`, `list_tags`, `get_registry_stats` *(read)*
- `delete_tag`, `set_repository_visibility` *(write)*

### Agents
- `list_agents`, `get_agent`, `list_enrollment_tokens` *(read)*
- `update_agent`, `delete_agent`, `create_enrollment_token` *(write)*

### Operators
- `get_operator_install_yaml` *(read)* — generate the operator install manifest.

### Incidents
- `list_incidents`, `get_incident` *(read)*
- `update_incident_status`, `delete_incident` *(write)*

> Registry and build tools require a Postgres-backed deployment
> (`DATABASE_URL` set); without it they return a clear "not configured" error.
