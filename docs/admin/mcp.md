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
fresh MCP session per request, bound to the calling credential's tenant,
scopes, and permissions. It wraps the same domain logic the REST API uses, so
anything a tool does is equivalent to the corresponding `/api/v1` call.

## Authentication, scopes & permissions

Every request must carry a bearer token in the `Authorization` header — either a
signed-in **session token** or, more typically for automation, an
[API credential]({% link admin/api-credentials.md %}). Authorization has three
layers:

1. **Entry scopes** — connecting to `/mcp` at all requires `mcp.read` or
   `mcp.write` on the credential. Mutating tools additionally require
   `mcp.write`.
2. **Fine-grained permissions** — every tool checks a permission from the
   shared platform model (`services:write`, `agents:read`,
   `registry:admin`, …). Owner/admin sessions hold the `*` wildcard. API
   credentials hold the permissions picked at mint time; a credential with
   *no* permissions falls back to its legacy scope-derived access (see
   [API credentials → Fine-grained permissions]({% link admin/api-credentials.md %}#fine-grained-permissions)).
3. **User-session-only tools** — users/groups, API-credential, and
   auth-settings tools refuse machine API credentials outright, mirroring the
   REST gates, so a leaked credential can never escalate itself.

| Scope | Grants |
|---|---|
| `mcp.read` | Connect to `/mcp` and run read/inspect tools (each still checks its read permission). |
| `mcp.write` | Connect and run mutating tools too. Implies `mcp.read`. |

Mint a credential scoped for MCP automation:

```bash
curl -sX POST https://<panel>/api/v1/admin/api-credentials \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"assistant","scopes":["mcp.read","mcp.write"],"permissions":["services:read","services:write","builds:trigger"]}'
# => { "id": "...", "token": "kop_...", "scopes": ["mcp.read","mcp.write"], "permissions": ["services:read","services:write","builds:trigger"], ... }
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

All tools are tenant-scoped to the calling credential. The permission each
tool requires is listed alongside; mutating tools also need the `mcp.write`
scope.

### Services & deployments
- `list_services`, `get_service`, `list_services_for_agent` — `services:read`
- `create_service`, `update_service`, `delete_service` — `services:write` (create/update accept `healthcheck`, `securityContext`, and `locked`)
- `attach_service_to_agent` (deploy), `detach_service_from_agent` (undeploy + teardown) — `agents:bind`

### Builds & deploys
- `list_builds`, `get_build` — `services:read`
- `trigger_build` — `builds:trigger`
- `deploy_build` (all bound agents), `deploy_build_to_agent`, `reconcile_agent_deploys` — `services:deploy`

### Pipeline overrides (kaiad.yaml)
- `get_pipeline_override` — `services:read`
- `set_pipeline_override`, `delete_pipeline_override` — `pipeline:edit`

### Registry
- `list_repositories`, `list_tags`, `get_registry_stats`, `get_registry_retention` — `registry:read`
- `delete_tag`, `set_repository_visibility`, `set_registry_retention`, `run_registry_retention` — `registry:admin`

### Agents & enrollment
- `list_agents`, `get_agent` — `agents:read`
- `get_agent_logs` — `agents:logs`
- `update_agent`, `delete_agent` — `agents:manage`
- `list_enrollment_tokens`, `create_enrollment_token`, `deactivate_enrollment_token`, `delete_enrollment_token` — `enrollment:manage`

### SSH keys
- `list_ssh_keys` — `sshkeys:read` (metadata only; key material is never returned)
- `create_ssh_key`, `delete_ssh_key` — `sshkeys:write`

### Operators
- `get_operator_install_yaml` — no permission (same as the unauthenticated REST download).

### Incidents & observability
- `list_incidents`, `get_incident`, `list_error_groups` — `incidents:read`
- `update_incident_status`, `delete_incident` — `incidents:write`
- `list_load_balancers` — `loadbalancers:read`

### Tenant settings
- `get_tenant_settings` — any authenticated MCP caller
- `update_tenant_settings` — `settings:manage`
- `update_tenant_settings` — `settings:manage`

### Build worker settings (instance-wide)
- `get_build_settings` — `settings:manage` (parallel-build limit + running/queued counts)
- `set_build_settings` — `settings:manage` (`maxConcurrentBuilds` 1–8; see [Build settings]({% link admin/build-settings.md %}))
### Users, groups & permissions — *user session only*
- `list_users`, `list_groups`, `list_permissions` — `users:read`
- `add_user`, `update_user`, `remove_user`, `create_group`, `update_group`, `delete_group` — `users:manage`

### API credentials — *user session only*
- `list_api_credentials`, `create_api_credential`, `revoke_api_credential` — `apicredentials:manage`

### Auth settings — *user session only*
- `list_auth_providers` — any authenticated MCP caller (no secrets returned)
- `set_oauth_provider`, `get_github_app_settings`, `set_github_app_settings` — `settings:manage`

*User session only* tools return an error for machine API-credential callers
regardless of scopes or permissions — the same privilege-escalation gate the
REST API enforces.

Not exposed via MCP: tenant create/delete (cross-tenant; the MCP server is
bound to the caller's tenant), the setup wizard, login/OAuth flows, and the
internal agent/operator ingestion endpoints.

> Registry, build, pipeline, users/groups, and load-balancer tools require a
> Postgres-backed deployment (`DATABASE_URL` set); without it they return a
> clear "not configured" error or empty lists.
