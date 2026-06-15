import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  enqueueManualBuild,
  getBuild,
  getRegistryStats,
  listBuildsForService,
  setRegistryRepoVisibility,
  listRegistryRepoVisibility,
  type QueryFn
} from "@sm/db";
import {
  deleteTag as registryDeleteTag,
  listRepositories as registryListRepositories,
  listTags as registryListTags
} from "../registry/admin.js";
import {
  buildOperatorInstallYaml,
  parseOperatorInstallOptions
} from "../operatorInstallYaml.js";
import { listEnrollmentTokensForTenant } from "../enrollmentStore.js";
import { hasScope, resolveSession, type AuthStore, type SessionInfo } from "../auth.js";
import type { DomainStore } from "../domainStore.js";

/**
 * Dependencies the MCP tools need. These are the same closures/stores the REST
 * routes use, threaded in from `buildServer` so the tools wrap real domain
 * logic instead of duplicating it.
 */
export type McpRouteDeps = {
  authStore: AuthStore;
  domainStore: DomainStore;
  /** Postgres-backed query fn for builds; null when DATABASE_URL is unset. */
  getBuildsQuery: () => Promise<QueryFn | null>;
  /** Registry admin context (pool + queryFn); null when storage isn't configured. */
  getRegistryAdminContext: () => Promise<{ pool: import("pg").Pool; queryFn: QueryFn } | null>;
  /** Shared detach + teardown dispatch. Returns false when no binding existed. */
  detachServiceWithTeardown: (tenantId: string, agentId: string, serviceId: string) => Promise<boolean>;
  /** Mint an agent enrollment token for the tenant. */
  createEnrollmentToken: (input: {
    tenantId: string;
    createdBy: string;
    ttlSeconds: number;
  }) => Promise<{ response: unknown }>;
  /** Ids of agents with a live realtime websocket. */
  getConnectedAgentIds: () => string[];
  /** Repos that must stay anonymously pullable and cannot be made private. */
  forcedPublicRepos: ReadonlySet<string>;
  logger: { error?: (obj: unknown, msg?: string) => void };
};

const SERVER_NAME = "kaiad";
const SERVER_VERSION = process.env.KAIAD_AGENT_VERSION || "0.1.0";

/** Wrap any JSON-serializable value as a single text content block. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Wrap a plain string as a text content block. */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Wrap an error message as an error result the model surfaces to the user. */
function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const READ_ONLY = { readOnlyHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;
const MUTATING = { readOnlyHint: false, destructiveHint: false } as const;

/**
 * Build a per-request MCP server whose tools are bound to the authenticated
 * caller's tenant + scopes. Write tools are gated on the `mcp.write` scope
 * (owners/admins hold it implicitly via `hasScope`).
 */
export function buildMcpServer(deps: McpRouteDeps, session: SessionInfo): McpServer {
  const tenantId = session.tenantId;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Manage the Kaiad control plane: deployments/services, builds, the OCI registry, agents, operators, and incidents. Read tools require the 'mcp.read' scope; mutating tools require 'mcp.write'."
    }
  );

  /** Guard a write tool. Returns an error result when the caller lacks mcp.write. */
  const ensureWrite = (): ReturnType<typeof errorResult> | null =>
    hasScope(session, "mcp.write")
      ? null
      : errorResult("Forbidden: this tool requires the 'mcp.write' scope on your credential.");

  // ---------------------------------------------------------------------------
  // Services / deployments
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_services",
    { title: "List services", description: "List all monitored services (deployments) for the tenant, including their agent bindings.", annotations: READ_ONLY },
    async () => jsonResult(await deps.domainStore.listServices(tenantId))
  );

  server.registerTool(
    "get_service",
    { title: "Get service", description: "Fetch a single service by id.", inputSchema: { id: z.string().describe("Service id (svc-...)") }, annotations: READ_ONLY },
    async ({ id }) => {
      const svc = await deps.domainStore.getService(tenantId, id);
      return svc ? jsonResult(svc) : errorResult(`Service not found: ${id}`);
    }
  );

  server.registerTool(
    "list_services_for_agent",
    { title: "List services for an agent", description: "List the services currently bound to a given agent.", inputSchema: { agentId: z.string() }, annotations: READ_ONLY },
    async ({ agentId }) => jsonResult(await deps.domainStore.listServicesForAgent(tenantId, agentId))
  );

  server.registerTool(
    "create_service",
    {
      title: "Create service",
      description: "Create a new monitored service (deployment). Optionally bind it to agents.",
      inputSchema: {
        name: z.string(),
        gitRepoUrl: z.string(),
        branch: z.string().default("main"),
        sshKeyId: z.string().nullish(),
        dockerImage: z.string().optional(),
        composePath: z.string().optional(),
        pipelineName: z.string().nullish(),
        kaiadYamlPath: z.string().optional(),
        agentIds: z.array(z.string()).optional().describe("Initial agent bindings")
      },
      annotations: MUTATING
    },
    async (args) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const svc = await deps.domainStore.createService(tenantId, {
        name: args.name,
        gitRepoUrl: args.gitRepoUrl,
        branch: args.branch,
        sshKeyId: args.sshKeyId ?? null,
        dockerImage: args.dockerImage,
        composePath: args.composePath,
        pipelineName: args.pipelineName ?? null,
        kaiadYamlPath: args.kaiadYamlPath,
        agentIds: args.agentIds
      });
      return jsonResult(svc);
    }
  );

  server.registerTool(
    "update_service",
    {
      title: "Update service",
      description: "Update fields on an existing service. Omitted fields are left unchanged. Pass agentIds to replace the full set of agent bindings ([] detaches all).",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        gitRepoUrl: z.string().optional(),
        branch: z.string().optional(),
        sshKeyId: z.string().nullish(),
        dockerImage: z.string().optional(),
        composePath: z.string().optional(),
        pipelineName: z.string().nullish(),
        kaiadYamlPath: z.string().optional(),
        locked: z.boolean().optional(),
        agentIds: z.array(z.string()).optional()
      },
      annotations: MUTATING
    },
    async ({ id, ...patch }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const updated = await deps.domainStore.updateService(tenantId, id, patch);
      return updated ? jsonResult(updated) : errorResult(`Service not found: ${id}`);
    }
  );

  server.registerTool(
    "delete_service",
    { title: "Delete service", description: "Permanently delete a service and its agent bindings.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const ok = await deps.domainStore.deleteService(tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult(`Service not found: ${id}`);
    }
  );

  server.registerTool(
    "attach_service_to_agent",
    { title: "Attach service to agent (deploy)", description: "Bind a service to an agent so the agent deploys and reconciles it.", inputSchema: { agentId: z.string(), serviceId: z.string() }, annotations: MUTATING },
    async ({ agentId, serviceId }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const agent = await deps.domainStore.getAgent(tenantId, agentId);
      if (!agent) return errorResult(`Agent not found: ${agentId}`);
      const service = await deps.domainStore.getService(tenantId, serviceId);
      if (!service) return errorResult(`Service not found: ${serviceId}`);
      const bound = await deps.domainStore.attachServiceToAgent(tenantId, agentId, serviceId);
      return jsonResult({ bound, agentId, serviceId });
    }
  );

  server.registerTool(
    "detach_service_from_agent",
    { title: "Detach service from agent (undeploy)", description: "Unbind a service from an agent and dispatch a teardown of what it had deployed.", inputSchema: { agentId: z.string(), serviceId: z.string() }, annotations: DESTRUCTIVE },
    async ({ agentId, serviceId }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const removed = await deps.detachServiceWithTeardown(tenantId, agentId, serviceId);
      return removed ? jsonResult({ detached: true, agentId, serviceId }) : errorResult("Binding not found");
    }
  );

  // ---------------------------------------------------------------------------
  // Builds
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_builds",
    { title: "List builds", description: "List recent builds for a service (most recent first).", inputSchema: { serviceId: z.string(), limit: z.number().int().min(1).max(200).default(50) }, annotations: READ_ONLY },
    async ({ serviceId, limit }) => {
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      const q = await deps.getBuildsQuery();
      if (!q) return jsonResult({ builds: [] });
      return jsonResult({ builds: await listBuildsForService(q, tenantId, serviceId, limit) });
    }
  );

  server.registerTool(
    "get_build",
    { title: "Get build", description: "Fetch a single build by id.", inputSchema: { buildId: z.string() }, annotations: READ_ONLY },
    async ({ buildId }) => {
      const q = await deps.getBuildsQuery();
      if (!q) return errorResult("Build pipeline requires a postgres backend (DATABASE_URL unset).");
      const build = await getBuild(q, tenantId, buildId);
      return build ? jsonResult(build) : errorResult(`Build not found: ${buildId}`);
    }
  );

  server.registerTool(
    "trigger_build",
    { title: "Trigger build", description: "Queue a manual build for a service on its configured branch.", inputSchema: { serviceId: z.string() }, annotations: MUTATING },
    async ({ serviceId }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      const q = await deps.getBuildsQuery();
      if (!q) return errorResult("Build pipeline requires a postgres backend (DATABASE_URL unset).");
      const build = await enqueueManualBuild(q, { tenantId, serviceId: svc.id, branch: svc.branch });
      return jsonResult({ build });
    }
  );

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_repositories",
    { title: "List registry repositories", description: "List OCI repositories in the built-in registry with their public-pull visibility.", annotations: READ_ONLY },
    async () => {
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      const [repositories, visibilityRows] = await Promise.all([
        registryListRepositories(ctx.queryFn),
        listRegistryRepoVisibility(ctx.queryFn)
      ]);
      const visById = new Map(visibilityRows.map((v) => [v.repo, v.public]));
      return jsonResult({
        repositories: repositories.map((r) => {
          const forcedPublic = deps.forcedPublicRepos.has(r.name);
          return { ...r, public: forcedPublic || visById.get(r.name) === true, forcedPublic };
        })
      });
    }
  );

  server.registerTool(
    "list_tags",
    { title: "List repository tags", description: "List the tags of a registry repository with manifest details.", inputSchema: { repo: z.string() }, annotations: READ_ONLY },
    async ({ repo }) => {
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      return jsonResult({ tags: await registryListTags(ctx.pool, ctx.queryFn, repo) });
    }
  );

  server.registerTool(
    "get_registry_stats",
    { title: "Registry stats", description: "Aggregate registry storage statistics (repo/tag/blob counts and sizes).", annotations: READ_ONLY },
    async () => {
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      return jsonResult(await getRegistryStats(ctx.queryFn));
    }
  );

  server.registerTool(
    "delete_tag",
    { title: "Delete registry tag", description: "Delete a tag from a repository; prunes the manifest if no tags reference it.", inputSchema: { repo: z.string(), tag: z.string() }, annotations: DESTRUCTIVE },
    async ({ repo, tag }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      const result = await registryDeleteTag(ctx.queryFn, repo, tag);
      return result.deleted ? jsonResult({ deleted: true, repo, tag, digest: result.digest }) : errorResult(`Tag not found: ${repo}:${tag}`);
    }
  );

  server.registerTool(
    "set_repository_visibility",
    { title: "Set repository visibility", description: "Set whether a repository allows anonymous pulls. Force-public repos cannot be made private.", inputSchema: { repo: z.string(), public: z.boolean() }, annotations: MUTATING },
    async ({ repo, public: isPublic }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      if (deps.forcedPublicRepos.has(repo) && !isPublic) {
        return errorResult(`${repo} is always public and cannot be made private.`);
      }
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      await setRegistryRepoVisibility(ctx.queryFn, repo, isPublic);
      return jsonResult({ repo, public: isPublic || deps.forcedPublicRepos.has(repo) });
    }
  );

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_agents",
    { title: "List agents", description: "List enrolled agents with their status and live websocket connectivity.", annotations: READ_ONLY },
    async () => {
      const agents = await deps.domainStore.listAgents(tenantId);
      const connected = new Set(deps.getConnectedAgentIds());
      return jsonResult({ agents: agents.map((a) => ({ ...a, websocketConnected: connected.has(a.id) })) });
    }
  );

  server.registerTool(
    "get_agent",
    { title: "Get agent", description: "Fetch a single agent by id.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
    async ({ id }) => {
      const agent = await deps.domainStore.getAgent(tenantId, id);
      if (!agent) return errorResult(`Agent not found: ${id}`);
      return jsonResult({ ...agent, websocketConnected: deps.getConnectedAgentIds().includes(agent.id) });
    }
  );

  server.registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent's administrative metadata (name, environment, allowed capabilities).",
      inputSchema: {
        id: z.string(),
        name: z.string().nullish(),
        environment: z.string().optional(),
        allowedCapabilities: z.array(z.string()).optional()
      },
      annotations: MUTATING
    },
    async ({ id, ...data }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const updated = await deps.domainStore.updateAgent(tenantId, id, data);
      return updated ? jsonResult(updated) : errorResult(`Agent not found: ${id}`);
    }
  );

  server.registerTool(
    "delete_agent",
    { title: "Delete agent", description: "Remove an agent and all of its service bindings.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const ok = await deps.domainStore.deleteAgent(tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult(`Agent not found: ${id}`);
    }
  );

  server.registerTool(
    "list_enrollment_tokens",
    { title: "List enrollment tokens", description: "List active agent enrollment tokens for the tenant (secrets are not returned).", annotations: READ_ONLY },
    async () => jsonResult({ tokens: await listEnrollmentTokensForTenant(tenantId) })
  );

  server.registerTool(
    "create_enrollment_token",
    { title: "Create enrollment token", description: "Mint a new agent enrollment token. The plaintext token is returned once.", inputSchema: { ttlSeconds: z.number().int().min(60).max(60 * 60 * 24 * 30).default(3600) }, annotations: MUTATING },
    async ({ ttlSeconds }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const { response } = await deps.createEnrollmentToken({ tenantId, createdBy: session.id, ttlSeconds });
      return jsonResult(response);
    }
  );

  // ---------------------------------------------------------------------------
  // Operators
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_operator_install_yaml",
    {
      title: "Operator install manifest",
      description: "Generate the Kubernetes install manifest (YAML) for the Kaiad operator. Optionally override namespace and image.",
      inputSchema: { namespace: z.string().optional(), image: z.string().optional() },
      annotations: READ_ONLY
    },
    async ({ namespace, image }) => {
      const parsed = parseOperatorInstallOptions({ namespace, image });
      if (!parsed.ok) return errorResult(parsed.reason);
      return textResult(buildOperatorInstallYaml(parsed.value));
    }
  );

  // ---------------------------------------------------------------------------
  // Incidents
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_incidents",
    { title: "List incidents", description: "List incidents for the tenant.", annotations: READ_ONLY },
    async () => jsonResult({ incidents: await deps.domainStore.listIncidents(tenantId) })
  );

  server.registerTool(
    "get_incident",
    { title: "Get incident", description: "Fetch a single incident by id, including its fix-attempt timeline.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
    async ({ id }) => {
      const inc = await deps.domainStore.getIncident(tenantId, id);
      return inc ? jsonResult(inc) : errorResult(`Incident not found: ${id}`);
    }
  );

  server.registerTool(
    "update_incident_status",
    { title: "Update incident status", description: "Set an incident's status (open, acknowledged, resolved).", inputSchema: { id: z.string(), status: z.enum(["open", "acknowledged", "resolved"]) }, annotations: MUTATING },
    async ({ id, status }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const updated = await deps.domainStore.updateIncidentStatus(tenantId, id, status);
      return updated ? jsonResult(updated) : errorResult(`Incident not found: ${id}`);
    }
  );

  server.registerTool(
    "delete_incident",
    { title: "Delete incident", description: "Permanently delete an incident.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = ensureWrite();
      if (denied) return denied;
      const ok = await deps.domainStore.deleteIncident(tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult(`Incident not found: ${id}`);
    }
  );

  return server;
}

/**
 * Register the hosted MCP endpoint. `POST /mcp` speaks the Streamable HTTP
 * transport in stateless mode (a fresh transport + server per request, bound to
 * the caller's session). Entry requires the `mcp.read` or `mcp.write` scope;
 * individual mutating tools additionally require `mcp.write`. `GET`/`DELETE`
 * return 405 — there is no standalone SSE stream or session to delete in
 * stateless mode.
 */
export function registerMcpRoute(app: FastifyInstance, deps: McpRouteDeps): void {
  app.post("/mcp", async (req, reply) => {
    const session = await resolveSession(deps.authStore, req.headers.authorization);
    if (!session) {
      return reply
        .status(401)
        .header("WWW-Authenticate", "Bearer")
        .send({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" }, id: null });
    }
    if (!hasScope(session, "mcp.read") && !hasScope(session, "mcp.write")) {
      return reply
        .status(403)
        .send({ jsonrpc: "2.0", error: { code: -32002, message: "Forbidden: credential lacks the 'mcp.read' or 'mcp.write' scope" }, id: null });
    }

    // Hand the raw socket to the transport. A stateless transport must not be
    // reused, so we create a fresh transport + server per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcpServer(deps, session);
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      deps.logger.error?.({ err }, "mcp request handling failed");
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader("content-type", "application/json");
        reply.raw.end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null })
        );
      }
    }
  });

  // The Streamable HTTP spec also defines GET (standalone SSE) and DELETE
  // (session teardown). Neither applies in stateless mode; 405 tells compliant
  // clients to fall back to plain POST request/response.
  const methodNotAllowed = (_req: unknown, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply
      .status(405)
      .send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless MCP endpoint)" }, id: null });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
