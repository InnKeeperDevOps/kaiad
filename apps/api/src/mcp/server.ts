import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  enqueueManualBuild,
  getBuild,
  getRegistryStats,
  listBuildsForService,
  listBuildsForTenant,
  decodeBuildCursor,
  setRegistryRepoVisibility,
  listRegistryRepoVisibility,
  getRegistryRetentionPolicy,
  updateRegistryRetentionPolicy,
  applyRegistryRetention,
  getBuildWorkerSettings,
  updateBuildWorkerSettings,
  getBuildQueueStats,
  getServicePipelineOverride,
  setServicePipelineOverride,
  getRepoPipelineOverride,
  setRepoPipelineOverride,
  listServicesForRepo,
  getLatestBuildPipelineYaml,
  listLoadBalancerStatusForTenant,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  listTenantMembers,
  addTenantMemberByEmail,
  setMemberRole,
  setMemberCustomGroups,
  removeTenantMember,
  type QueryFn
} from "@sm/db";
import {
  hasPermission,
  parsePipelineYaml,
  selectPipeline,
  healthcheckSchema,
  podSecurityContextSchema,
  apiCredentialScopeSchema,
  upsertTenantSettingsRequestSchema,
  PERMISSIONS,
  WILDCARD
} from "@sm/contracts";
import {
  deleteTag as registryDeleteTag,
  listRepositories as registryListRepositories,
  listTags as registryListTags
} from "../registry/admin.js";
import {
  buildOperatorInstallYaml,
  parseOperatorInstallOptions
} from "../operatorInstallYaml.js";
import {
  deactivateEnrollmentTokenForTenant,
  deleteEnrollmentTokenForTenant,
  listEnrollmentTokensForTenant
} from "../enrollmentStore.js";
import {
  createApiCredentialForTenant,
  listApiCredentialsForTenant,
  revokeApiCredentialForTenant
} from "../apiCredentialsStore.js";
import { getTenantSettings, upsertTenantSettings } from "../store.js";
import { addOAuthProvider, listProviders, type OAuthProviderConfig } from "../oauth.js";
import { readConfig, writeConfig, type KaiadConfig } from "../configPersistence.js";
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
  /**
   * Effective fine-grained permissions for the session (same resolver the
   * REST `authorize` helper uses; caches on the session object).
   */
  getSessionPermissions: (session: SessionInfo) => Promise<string[]>;
  /** Shared deploy dispatch (same closure the REST deploy routes use). */
  deployBuildToAgents: (
    tenantId: string,
    serviceId: string,
    buildId: string,
    targets: { agentId: string; environment: string }[]
  ) => Promise<unknown>;
  /** Re-deploy services bound to an agent (env flip / reconnect reconcile). */
  reconcileAgentDeploys: (tenantId: string, agentId: string) => Promise<unknown>;
  /** Tenant-scoped in-memory error groups (same store the REST route reads). */
  listErrorGroups: (tenantId: string) => unknown[];
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
 * caller's tenant + scopes + fine-grained permissions.
 *
 * Gating model:
 * - Endpoint entry requires the `mcp.read` or `mcp.write` scope (checked in
 *   `registerMcpRoute`).
 * - Every tool additionally requires a fine-grained permission (see
 *   `PERMISSIONS` in @sm/contracts). Owner/admin sessions hold `*`; API
 *   credentials hold the permissions minted onto them, or a legacy
 *   scope-derived fallback when none were.
 * - Mutating tools also require the `mcp.write` scope.
 * - Sensitive tools (users/groups, API credentials, auth settings) are
 *   user-session-only: machine API credentials are refused, mirroring the
 *   REST `userOnly` gates, so a leaked credential cannot escalate.
 */
export function buildMcpServer(deps: McpRouteDeps, session: SessionInfo): McpServer {
  const tenantId = session.tenantId;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Manage the Kaiad control plane: deployments/services, builds, pipeline overrides, deploys, the OCI registry, agents, SSH keys, incidents, load balancers, tenant settings, users/groups, and API credentials. " +
        "Entry requires the 'mcp.read' or 'mcp.write' scope; each tool also requires a fine-grained permission (e.g. services:write) and mutating tools require 'mcp.write'. " +
        "User/group, API-credential, and auth-settings tools require a user session — machine API credentials are refused."
    }
  );

  /** True when the session holds `perm` (owner/admin hold `*`). */
  const can = async (perm: string): Promise<boolean> =>
    hasPermission(await deps.getSessionPermissions(session), perm);

  /** Guard a read tool. Returns an error result when the caller lacks `perm`. */
  const ensureRead = async (perm: string): Promise<ReturnType<typeof errorResult> | null> =>
    (await can(perm)) ? null : errorResult(`Forbidden: this tool requires the '${perm}' permission.`);

  /** Guard a write tool: `mcp.write` scope plus the fine-grained permission. */
  const ensureWrite = async (perm: string): Promise<ReturnType<typeof errorResult> | null> => {
    if (!hasScope(session, "mcp.write")) {
      return errorResult("Forbidden: this tool requires the 'mcp.write' scope on your credential.");
    }
    return ensureRead(perm);
  };

  /** Guard a user-session-only tool (mirrors the REST `userOnly` gates). */
  const ensureUserSession = (): ReturnType<typeof errorResult> | null =>
    session.kind === "apiCredential"
      ? errorResult("Forbidden: a user session is required for this tool; machine API credentials are refused.")
      : null;

  const requireQuery = async (): Promise<QueryFn | null> => deps.getBuildsQuery();
  const dbUnavailable = errorResult("Persistence unavailable (DATABASE_URL unset).");

  // ---------------------------------------------------------------------------
  // Services / deployments
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_services",
    { title: "List services", description: "List all monitored services (deployments) for the tenant, including their agent bindings. Requires services:read.", annotations: READ_ONLY },
    async () => (await ensureRead("services:read")) ?? jsonResult(await deps.domainStore.listServices(tenantId))
  );

  server.registerTool(
    "get_service",
    { title: "Get service", description: "Fetch a single service by id. Requires services:read.", inputSchema: { id: z.string().describe("Service id (svc-...)") }, annotations: READ_ONLY },
    async ({ id }) => {
      const denied = await ensureRead("services:read");
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, id);
      return svc ? jsonResult(svc) : errorResult(`Service not found: ${id}`);
    }
  );

  server.registerTool(
    "list_services_for_agent",
    { title: "List services for an agent", description: "List the services currently bound to a given agent. Requires services:read.", inputSchema: { agentId: z.string() }, annotations: READ_ONLY },
    async ({ agentId }) =>
      (await ensureRead("services:read")) ?? jsonResult(await deps.domainStore.listServicesForAgent(tenantId, agentId))
  );

  server.registerTool(
    "create_service",
    {
      title: "Create service",
      description: "Create a new monitored service (deployment). Optionally bind it to agents. Requires services:write.",
      inputSchema: {
        name: z.string(),
        gitRepoUrl: z.string(),
        branch: z.string().default("main"),
        sshKeyId: z.string().nullish(),
        dockerImage: z.string().optional(),
        composePath: z.string().optional(),
        pipelineName: z.string().nullish(),
        kaiadYamlPath: z.string().optional(),
        healthcheck: healthcheckSchema.nullish().describe("HTTP readiness probe for rolling deploys; null clears"),
        securityContext: podSecurityContextSchema.nullish().describe("Pod securityContext (runAsUser/runAsGroup/fsGroup); null clears"),
        locked: z.boolean().optional().describe("When true, the build poller skips this service"),
        agentIds: z.array(z.string()).optional().describe("Initial agent bindings")
      },
      annotations: MUTATING
    },
    async (args) => {
      const denied = await ensureWrite("services:write");
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
        healthcheck: args.healthcheck ?? null,
        securityContext: args.securityContext ?? null,
        locked: args.locked,
        agentIds: args.agentIds
      });
      return jsonResult(svc);
    }
  );

  server.registerTool(
    "update_service",
    {
      title: "Update service",
      description: "Update fields on an existing service. Omitted fields are left unchanged. Pass agentIds to replace the full set of agent bindings ([] detaches all). Requires services:write.",
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
        healthcheck: healthcheckSchema.nullish().describe("null clears the probe; an object replaces it whole"),
        securityContext: podSecurityContextSchema.nullish().describe("null clears; an object replaces it whole"),
        locked: z.boolean().optional(),
        agentIds: z.array(z.string()).optional()
      },
      annotations: MUTATING
    },
    async ({ id, ...patch }) => {
      const denied = await ensureWrite("services:write");
      if (denied) return denied;
      const updated = await deps.domainStore.updateService(tenantId, id, patch);
      return updated ? jsonResult(updated) : errorResult(`Service not found: ${id}`);
    }
  );

  server.registerTool(
    "delete_service",
    { title: "Delete service", description: "Permanently delete a service and its agent bindings. Requires services:write.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = await ensureWrite("services:write");
      if (denied) return denied;
      const ok = await deps.domainStore.deleteService(tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult(`Service not found: ${id}`);
    }
  );

  server.registerTool(
    "attach_service_to_agent",
    { title: "Attach service to agent (deploy)", description: "Bind a service to an agent so the agent deploys and reconciles it. Requires agents:bind.", inputSchema: { agentId: z.string(), serviceId: z.string() }, annotations: MUTATING },
    async ({ agentId, serviceId }) => {
      const denied = await ensureWrite("agents:bind");
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
    { title: "Detach service from agent (undeploy)", description: "Unbind a service from an agent and dispatch a teardown of what it had deployed. Requires agents:bind.", inputSchema: { agentId: z.string(), serviceId: z.string() }, annotations: DESTRUCTIVE },
    async ({ agentId, serviceId }) => {
      const denied = await ensureWrite("agents:bind");
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
    { title: "List builds", description: "List recent builds for a service (most recent first). Requires services:read.", inputSchema: { serviceId: z.string(), limit: z.number().int().min(1).max(200).default(50) }, annotations: READ_ONLY },
    async ({ serviceId, limit }) => {
      const denied = await ensureRead("services:read");
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      const q = await requireQuery();
      if (!q) return jsonResult({ builds: [] });
      return jsonResult({ builds: await listBuildsForService(q, tenantId, serviceId, limit) });
    }
  );

  server.registerTool(
    "list_all_builds",
    {
      title: "List builds across services",
      description:
        "Tenant-wide build history (newest first) with optional service/status/trigger filters and cursor pagination. Rows omit the log; use get_build for it.",
      inputSchema: {
        serviceId: z.string().optional(),
        status: z.enum(["queued", "running", "success", "failed"]).optional(),
        triggeredBy: z.enum(["poll", "manual"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional().describe("nextCursor from a previous page")
      },
      annotations: READ_ONLY
    },
    async (args) => {
      const q = await deps.getBuildsQuery();
      if (!q) return jsonResult({ builds: [], nextCursor: null });
      if (args.cursor && !decodeBuildCursor(args.cursor)) return errorResult("Invalid cursor");
      return jsonResult(await listBuildsForTenant(q, tenantId, args));
    }
  );

  server.registerTool(
    "get_build",
    { title: "Get build", description: "Fetch a single build by id. Requires services:read.", inputSchema: { buildId: z.string() }, annotations: READ_ONLY },
    async ({ buildId }) => {
      const denied = await ensureRead("services:read");
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return errorResult("Build pipeline requires a postgres backend (DATABASE_URL unset).");
      const build = await getBuild(q, tenantId, buildId);
      return build ? jsonResult(build) : errorResult(`Build not found: ${buildId}`);
    }
  );

  server.registerTool(
    "trigger_build",
    { title: "Trigger build", description: "Queue a manual build for a service on its configured branch. Requires builds:trigger.", inputSchema: { serviceId: z.string() }, annotations: MUTATING },
    async ({ serviceId }) => {
      const denied = await ensureWrite("builds:trigger");
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      const q = await requireQuery();
      if (!q) return errorResult("Build pipeline requires a postgres backend (DATABASE_URL unset).");
      const build = await enqueueManualBuild(q, { tenantId, serviceId: svc.id, branch: svc.branch });
      return jsonResult({ build });
    }
  );

  // ---------------------------------------------------------------------------
  // Deploys
  // ---------------------------------------------------------------------------
  server.registerTool(
    "deploy_build",
    {
      title: "Deploy build to bound agents",
      description: "Deploy a specific successful build of a service to every agent the service is bound to. Requires services:deploy.",
      inputSchema: { serviceId: z.string(), buildId: z.string() },
      annotations: MUTATING
    },
    async ({ serviceId, buildId }) => {
      const denied = await ensureWrite("services:deploy");
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      const q = await requireQuery();
      if (!q) return errorResult("Build store not configured (DATABASE_URL unset).");
      const { rows } = await q(
        `SELECT a.id AS agent_id, a.environment
           FROM agent_services s
           JOIN agents a ON a.id = s.agent_id
          WHERE s.service_id = $1`,
        [serviceId]
      );
      const targets = rows.map((r) => ({
        agentId: String(r.agent_id),
        environment: String(r.environment ?? "development")
      }));
      try {
        const result = await deps.deployBuildToAgents(tenantId, serviceId, buildId, targets);
        return jsonResult({ ...(result as object), boundAgents: targets.length });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : "Deploy failed");
      }
    }
  );

  server.registerTool(
    "deploy_build_to_agent",
    {
      title: "Deploy build to one agent",
      description: "Deploy a chosen build of a bound service to a single agent. Requires services:deploy.",
      inputSchema: { agentId: z.string(), serviceId: z.string(), buildId: z.string() },
      annotations: MUTATING
    },
    async ({ agentId, serviceId, buildId }) => {
      const denied = await ensureWrite("services:deploy");
      if (denied) return denied;
      const agent = await deps.domainStore.getAgent(tenantId, agentId);
      if (!agent) return errorResult(`Agent not found: ${agentId}`);
      const q = await requireQuery();
      if (!q) return errorResult("Build store not configured (DATABASE_URL unset).");
      const { rows } = await q(
        `SELECT 1 FROM agent_services WHERE agent_id = $1 AND service_id = $2 LIMIT 1`,
        [agentId, serviceId]
      );
      if (rows.length === 0) return errorResult("Agent is not bound to this service");
      try {
        const result = await deps.deployBuildToAgents(tenantId, serviceId, buildId, [
          { agentId, environment: agent.environment ?? "development" }
        ]);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : "Deploy failed");
      }
    }
  );

  server.registerTool(
    "reconcile_agent_deploys",
    {
      title: "Reconcile agent deploys",
      description: "Re-deploy every service bound to an agent from its latest successful build (e.g. after an environment flip). Requires services:deploy.",
      inputSchema: { agentId: z.string() },
      annotations: MUTATING
    },
    async ({ agentId }) => {
      const denied = await ensureWrite("services:deploy");
      if (denied) return denied;
      const agent = await deps.domainStore.getAgent(tenantId, agentId);
      if (!agent) return errorResult(`Agent not found: ${agentId}`);
      return jsonResult(await deps.reconcileAgentDeploys(tenantId, agentId));
    }
  );

  // ---------------------------------------------------------------------------
  // Pipeline overrides (kaiad.yaml editor)
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_pipeline_override",
    {
      title: "Get pipeline override",
      description: "Read the effective pipeline (kaiad.yaml) override state for a service: service-scoped override, repo-scoped override, and the repo's captured kaiad.yaml. Requires services:read.",
      inputSchema: { serviceId: z.string() },
      annotations: READ_ONLY
    },
    async ({ serviceId }) => {
      const denied = await ensureRead("services:read");
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      const q = await requireQuery();
      if (!q) {
        return jsonResult({ scope: "repo", serviceOverride: null, repoOverride: null, repoYaml: null, pipelineName: svc.pipelineName ?? null, gitRepoUrl: svc.gitRepoUrl, branch: svc.branch, repoServices: [] });
      }
      const serviceOverride = await getServicePipelineOverride(q, tenantId, serviceId);
      const repoOverride = await getRepoPipelineOverride(q, tenantId, svc.gitRepoUrl, svc.branch, svc.kaiadYamlPath);
      const repoYaml =
        serviceOverride == null && repoOverride == null
          ? await getLatestBuildPipelineYaml(q, tenantId, serviceId)
          : null;
      const repoServices = await listServicesForRepo(q, tenantId, svc.gitRepoUrl, svc.branch, svc.kaiadYamlPath);
      return jsonResult({
        scope: serviceOverride != null ? "service" : "repo",
        serviceOverride: serviceOverride ?? null,
        repoOverride: repoOverride ?? null,
        repoYaml: repoYaml ?? null,
        pipelineName: svc.pipelineName ?? null,
        gitRepoUrl: svc.gitRepoUrl,
        branch: svc.branch,
        repoServices
      });
    }
  );

  server.registerTool(
    "set_pipeline_override",
    {
      title: "Set pipeline override",
      description: "Set a pipeline (kaiad.yaml) override. scope 'repo' (default) applies to every service sharing the repo+branch+path; 'service' overrides just this service. YAML is validated before persisting. Requires pipeline:edit.",
      inputSchema: {
        serviceId: z.string(),
        yaml: z.string().min(1).describe("Full kaiad.yaml content"),
        scope: z.enum(["repo", "service"]).default("repo")
      },
      annotations: MUTATING
    },
    async ({ serviceId, yaml, scope }) => {
      const denied = await ensureWrite("pipeline:edit");
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      // Validate before persisting so a bad override can't brick builds.
      const parsed = parsePipelineYaml(yaml);
      if (!parsed.ok) return errorResult(`Invalid pipeline: ${parsed.reason}`);
      const picked = selectPipeline(parsed, svc.pipelineName ?? null);
      if (!picked.ok) return errorResult(`Invalid pipeline: ${picked.reason}`);
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      if (scope === "service") {
        const ok = await setServicePipelineOverride(q, tenantId, serviceId, yaml);
        if (!ok) return errorResult(`Service not found: ${serviceId}`);
        return jsonResult({ ok: true, scope, affectedServices: [{ id: svc.id, name: svc.name }] });
      }
      await setRepoPipelineOverride(q, tenantId, svc.gitRepoUrl, svc.branch, svc.kaiadYamlPath, yaml);
      const repoServices = await listServicesForRepo(q, tenantId, svc.gitRepoUrl, svc.branch, svc.kaiadYamlPath);
      const affectedServices = repoServices.filter((s) => !s.hasServiceOverride).map((s) => ({ id: s.id, name: s.name }));
      return jsonResult({ ok: true, scope, affectedServices });
    }
  );

  server.registerTool(
    "delete_pipeline_override",
    {
      title: "Clear pipeline override",
      description: "Clear pipeline overrides. scope 'service' clears this service's override, 'repo' clears the shared repo override, 'all' (default) clears both. Requires pipeline:edit.",
      inputSchema: { serviceId: z.string(), scope: z.enum(["service", "repo", "all"]).default("all") },
      annotations: DESTRUCTIVE
    },
    async ({ serviceId, scope }) => {
      const denied = await ensureWrite("pipeline:edit");
      if (denied) return denied;
      const svc = await deps.domainStore.getService(tenantId, serviceId);
      if (!svc) return errorResult(`Service not found: ${serviceId}`);
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      if (scope === "service" || scope === "all") {
        await setServicePipelineOverride(q, tenantId, serviceId, null);
      }
      if (scope === "repo" || scope === "all") {
        await setRepoPipelineOverride(q, tenantId, svc.gitRepoUrl, svc.branch, svc.kaiadYamlPath, null);
      }
      return jsonResult({ ok: true, scope });
    }
  );

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_repositories",
    { title: "List registry repositories", description: "List OCI repositories in the built-in registry with their public-pull visibility. Requires registry:read.", annotations: READ_ONLY },
    async () => {
      const denied = await ensureRead("registry:read");
      if (denied) return denied;
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
    { title: "List repository tags", description: "List the tags of a registry repository with manifest details. Requires registry:read.", inputSchema: { repo: z.string() }, annotations: READ_ONLY },
    async ({ repo }) => {
      const denied = await ensureRead("registry:read");
      if (denied) return denied;
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      return jsonResult({ tags: await registryListTags(ctx.pool, ctx.queryFn, repo) });
    }
  );

  server.registerTool(
    "get_registry_stats",
    { title: "Registry stats", description: "Aggregate registry storage statistics (repo/tag/blob counts and sizes). Requires registry:read.", annotations: READ_ONLY },
    async () => {
      const denied = await ensureRead("registry:read");
      if (denied) return denied;
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      return jsonResult(await getRegistryStats(ctx.queryFn));
    }
  );

  server.registerTool(
    "delete_tag",
    { title: "Delete registry tag", description: "Delete a tag from a repository; prunes the manifest if no tags reference it. Requires registry:admin.", inputSchema: { repo: z.string(), tag: z.string() }, annotations: DESTRUCTIVE },
    async ({ repo, tag }) => {
      const denied = await ensureWrite("registry:admin");
      if (denied) return denied;
      const ctx = await deps.getRegistryAdminContext();
      if (!ctx) return errorResult("Registry storage not configured (DATABASE_URL missing).");
      const result = await registryDeleteTag(ctx.queryFn, repo, tag);
      return result.deleted ? jsonResult({ deleted: true, repo, tag, digest: result.digest }) : errorResult(`Tag not found: ${repo}:${tag}`);
    }
  );

  server.registerTool(
    "set_repository_visibility",
    { title: "Set repository visibility", description: "Set whether a repository allows anonymous pulls. Force-public repos cannot be made private. Requires registry:admin.", inputSchema: { repo: z.string(), public: z.boolean() }, annotations: MUTATING },
    async ({ repo, public: isPublic }) => {
      const denied = await ensureWrite("registry:admin");
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

  server.registerTool(
    "get_registry_retention",
    { title: "Get registry retention policy", description: "Read the registry retention policy (keep-last-N, size cap, max age) and current storage stats. Requires registry:read.", annotations: READ_ONLY },
    async () => {
      const denied = await ensureRead("registry:read");
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      const [policy, stats] = await Promise.all([getRegistryRetentionPolicy(q), getRegistryStats(q)]);
      return jsonResult({ policy, stats });
    }
  );

  server.registerTool(
    "set_registry_retention",
    {
      title: "Update registry retention policy",
      description: "Update the registry retention policy. Omitted fields are left unchanged; 0 disables that pruning dimension. Requires registry:admin.",
      inputSchema: {
        keepLastNPerRepo: z.number().int().min(0).optional(),
        maxTotalBytes: z.number().int().min(0).optional(),
        keepForDays: z.number().int().min(0).optional()
      },
      annotations: MUTATING
    },
    async (args) => {
      const denied = await ensureWrite("registry:admin");
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      const policy = await updateRegistryRetentionPolicy(q, args);
      const stats = await getRegistryStats(q);
      return jsonResult({ policy, stats });
    }
  );

  server.registerTool(
    "run_registry_retention",
    { title: "Run registry retention sweep", description: "Apply the retention policy now (manual garbage-collection sweep). Requires registry:admin.", annotations: DESTRUCTIVE },
    async () => {
      const denied = await ensureWrite("registry:admin");
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      const policy = await getRegistryRetentionPolicy(q);
      return jsonResult(await applyRegistryRetention(q, policy));
    }
  );

  // ---------------------------------------------------------------------------
  // Build worker settings (instance-wide)
  // ---------------------------------------------------------------------------
  const buildSettingsPayload = async (q: QueryFn) => {
    const [settings, stats] = await Promise.all([getBuildWorkerSettings(q), getBuildQueueStats(q)]);
    return { ...settings, running: stats.running, queued: stats.queued };
  };

  server.registerTool(
    "get_build_settings",
    {
      title: "Get build worker settings",
      description: "Read the instance-wide parallel-build limit (maxConcurrentBuilds, 1-8) plus the number of running and queued builds. Requires settings:manage.",
      annotations: READ_ONLY
    },
    async () => {
      const denied = await ensureRead("settings:manage");
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      return jsonResult(await buildSettingsPayload(q));
    }
  );

  server.registerTool(
    "set_build_settings",
    {
      title: "Update build worker settings",
      description: "Set how many builds may run in parallel across all worker processes (1-8). Lowering it never interrupts running builds; one build per service runs at a time regardless. Keep limit × ~25 GB under the free space of the build workspace. Requires settings:manage.",
      inputSchema: { maxConcurrentBuilds: z.number().int().min(1).max(8) },
      annotations: MUTATING
    },
    async (args) => {
      const denied = await ensureWrite("settings:manage");
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      await updateBuildWorkerSettings(q, {
        maxConcurrentBuilds: args.maxConcurrentBuilds,
        updatedBy: session.email || session.id
      });
      return jsonResult(await buildSettingsPayload(q));
    }
  );

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_agents",
    { title: "List agents", description: "List enrolled agents with their status and live websocket connectivity. Requires agents:read.", annotations: READ_ONLY },
    async () => {
      const denied = await ensureRead("agents:read");
      if (denied) return denied;
      const agents = await deps.domainStore.listAgents(tenantId);
      const connected = new Set(deps.getConnectedAgentIds());
      return jsonResult({ agents: agents.map((a) => ({ ...a, websocketConnected: connected.has(a.id) })) });
    }
  );

  server.registerTool(
    "get_agent",
    { title: "Get agent", description: "Fetch a single agent by id. Requires agents:read.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
    async ({ id }) => {
      const denied = await ensureRead("agents:read");
      if (denied) return denied;
      const agent = await deps.domainStore.getAgent(tenantId, id);
      if (!agent) return errorResult(`Agent not found: ${id}`);
      return jsonResult({ ...agent, websocketConnected: deps.getConnectedAgentIds().includes(agent.id) });
    }
  );

  server.registerTool(
    "update_agent",
    {
      title: "Update agent",
      description: "Update an agent's administrative metadata (name, environment, allowed capabilities). Requires agents:manage.",
      inputSchema: {
        id: z.string(),
        name: z.string().nullish(),
        environment: z.string().optional(),
        allowedCapabilities: z.array(z.string()).optional()
      },
      annotations: MUTATING
    },
    async ({ id, ...data }) => {
      const denied = await ensureWrite("agents:manage");
      if (denied) return denied;
      const updated = await deps.domainStore.updateAgent(tenantId, id, data);
      return updated ? jsonResult(updated) : errorResult(`Agent not found: ${id}`);
    }
  );

  server.registerTool(
    "delete_agent",
    { title: "Delete agent", description: "Remove an agent and all of its service bindings. Requires agents:manage.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = await ensureWrite("agents:manage");
      if (denied) return denied;
      const ok = await deps.domainStore.deleteAgent(tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult(`Agent not found: ${id}`);
    }
  );

  server.registerTool(
    "get_agent_logs",
    {
      title: "Get agent logs",
      description: "Read an agent's own process log lines (the agent's self-logs, not deployed-service logs). Requires agents:logs.",
      inputSchema: {
        agentId: z.string(),
        limit: z.number().int().min(1).max(500).default(100),
        afterId: z.string().optional().describe("Return only lines after this log row id (for paging)")
      },
      annotations: READ_ONLY
    },
    async ({ agentId, limit, afterId }) => {
      const denied = await ensureRead("agents:logs");
      if (denied) return denied;
      const agent = await deps.domainStore.getAgent(tenantId, agentId);
      if (!agent) return errorResult(`Agent not found: ${agentId}`);
      const logs = await deps.domainStore.listComponentLogs(
        tenantId,
        { source: "agent", sourceId: agent.id },
        { limit, afterId }
      );
      return jsonResult({ logs });
    }
  );

  server.registerTool(
    "list_enrollment_tokens",
    { title: "List enrollment tokens", description: "List active agent enrollment tokens for the tenant (secrets are not returned). Requires enrollment:manage.", annotations: READ_ONLY },
    async () =>
      (await ensureRead("enrollment:manage")) ?? jsonResult({ tokens: await listEnrollmentTokensForTenant(tenantId) })
  );

  server.registerTool(
    "create_enrollment_token",
    { title: "Create enrollment token", description: "Mint a new agent enrollment token. The plaintext token is returned once. Requires enrollment:manage.", inputSchema: { ttlSeconds: z.number().int().min(60).max(60 * 60 * 24 * 30).default(3600) }, annotations: MUTATING },
    async ({ ttlSeconds }) => {
      const denied = await ensureWrite("enrollment:manage");
      if (denied) return denied;
      const { response } = await deps.createEnrollmentToken({ tenantId, createdBy: session.id, ttlSeconds });
      return jsonResult(response);
    }
  );

  server.registerTool(
    "deactivate_enrollment_token",
    { title: "Deactivate enrollment token", description: "Deactivate (revoke) an unused enrollment token so it can no longer enroll an agent. Requires enrollment:manage.", inputSchema: { tokenId: z.string() }, annotations: MUTATING },
    async ({ tokenId }) => {
      const denied = await ensureWrite("enrollment:manage");
      if (denied) return denied;
      const outcome = await deactivateEnrollmentTokenForTenant(tenantId, tokenId);
      if (outcome === "not_found") return errorResult(`Enrollment token not found: ${tokenId}`);
      if (outcome === "not_revocable") {
        return errorResult("Enrollment token cannot be deactivated (already used, revoked, or expired)");
      }
      return jsonResult({ deactivated: true, tokenId });
    }
  );

  server.registerTool(
    "delete_enrollment_token",
    { title: "Delete enrollment token", description: "Permanently delete an enrollment token record. Requires enrollment:manage.", inputSchema: { tokenId: z.string() }, annotations: DESTRUCTIVE },
    async ({ tokenId }) => {
      const denied = await ensureWrite("enrollment:manage");
      if (denied) return denied;
      const deleted = await deleteEnrollmentTokenForTenant(tenantId, tokenId);
      return deleted ? jsonResult({ deleted: true, tokenId }) : errorResult(`Enrollment token not found: ${tokenId}`);
    }
  );

  // ---------------------------------------------------------------------------
  // SSH keys
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_ssh_keys",
    { title: "List SSH keys", description: "List the tenant's SSH deploy keys (metadata only; key material is never returned). Requires sshkeys:read.", annotations: READ_ONLY },
    async () => (await ensureRead("sshkeys:read")) ?? jsonResult({ keys: await deps.domainStore.listSshKeys(tenantId) })
  );

  server.registerTool(
    "create_ssh_key",
    {
      title: "Create SSH key",
      description: "Add an SSH deploy key: either upload private key material ('uploaded') or reference a path on the agent host ('local_path'). Requires sshkeys:write.",
      inputSchema: {
        name: z.string().min(1),
        type: z.enum(["uploaded", "local_path"]),
        privateKey: z.string().optional().describe("PEM private key; required when type=uploaded"),
        localPath: z.string().optional().describe("Absolute path on the agent host; required when type=local_path")
      },
      annotations: MUTATING
    },
    async ({ name, type, privateKey, localPath }) => {
      const denied = await ensureWrite("sshkeys:write");
      if (denied) return denied;
      if (type === "uploaded" && !privateKey?.trim()) return errorResult("privateKey is required when type=uploaded");
      if (type === "local_path" && !localPath?.trim()) return errorResult("localPath is required when type=local_path");
      const key = await deps.domainStore.createSshKey(tenantId, { name, type, privateKey, localPath });
      return jsonResult(key);
    }
  );

  server.registerTool(
    "delete_ssh_key",
    { title: "Delete SSH key", description: "Permanently delete an SSH key. Services referencing it lose their deploy key. Requires sshkeys:write.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = await ensureWrite("sshkeys:write");
      if (denied) return denied;
      const ok = await deps.domainStore.deleteSshKey(tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult(`SSH key not found: ${id}`);
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
  // Incidents & observability
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_incidents",
    { title: "List incidents", description: "List incidents for the tenant. Requires incidents:read.", annotations: READ_ONLY },
    async () => (await ensureRead("incidents:read")) ?? jsonResult({ incidents: await deps.domainStore.listIncidents(tenantId) })
  );

  server.registerTool(
    "get_incident",
    { title: "Get incident", description: "Fetch a single incident by id, including its fix-attempt timeline. Requires incidents:read.", inputSchema: { id: z.string() }, annotations: READ_ONLY },
    async ({ id }) => {
      const denied = await ensureRead("incidents:read");
      if (denied) return denied;
      const inc = await deps.domainStore.getIncident(tenantId, id);
      return inc ? jsonResult(inc) : errorResult(`Incident not found: ${id}`);
    }
  );

  server.registerTool(
    "update_incident_status",
    { title: "Update incident status", description: "Set an incident's status (open, acknowledged, resolved). Requires incidents:write.", inputSchema: { id: z.string(), status: z.enum(["open", "acknowledged", "resolved"]) }, annotations: MUTATING },
    async ({ id, status }) => {
      const denied = await ensureWrite("incidents:write");
      if (denied) return denied;
      const updated = await deps.domainStore.updateIncidentStatus(tenantId, id, status);
      return updated ? jsonResult(updated) : errorResult(`Incident not found: ${id}`);
    }
  );

  server.registerTool(
    "delete_incident",
    { title: "Delete incident", description: "Permanently delete an incident. Requires incidents:write.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = await ensureWrite("incidents:write");
      if (denied) return denied;
      const ok = await deps.domainStore.deleteIncident(tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult(`Incident not found: ${id}`);
    }
  );

  server.registerTool(
    "list_error_groups",
    { title: "List error groups", description: "List grouped application errors detected in service logs. Requires incidents:read.", annotations: READ_ONLY },
    async () => (await ensureRead("incidents:read")) ?? jsonResult({ groups: deps.listErrorGroups(tenantId) })
  );

  server.registerTool(
    "list_load_balancers",
    { title: "List load balancers", description: "List load-balancer / ingress status rows reported by agents (external IPs, hostnames, ports, domains). Requires loadbalancers:read.", annotations: READ_ONLY },
    async () => {
      const denied = await ensureRead("loadbalancers:read");
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return jsonResult({ entries: [] });
      const rows = await listLoadBalancerStatusForTenant(q, tenantId);
      const services = await deps.domainStore.listServices(tenantId);
      const byId = new Map(services.map((s) => [s.id, s.name]));
      return jsonResult({
        entries: rows.map((r) => ({ ...r, serviceName: byId.get(r.serviceId) ?? r.serviceId }))
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Tenant settings
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_tenant_settings",
    { title: "Get tenant settings", description: "Read the tenant's settings (e.g. docsUrl).", annotations: READ_ONLY },
    async () => {
      const settings = await getTenantSettings(tenantId);
      return settings ? jsonResult(settings) : jsonResult({ tenantId, docsUrl: null });
    }
  );

  server.registerTool(
    "update_tenant_settings",
    {
      title: "Update tenant settings",
      description: "Upsert the tenant's settings. Requires settings:manage.",
      inputSchema: { docsUrl: z.string().url().optional().describe("URL of the tenant's documentation site") },
      annotations: MUTATING
    },
    async ({ docsUrl }) => {
      const denied = await ensureWrite("settings:manage");
      if (denied) return denied;
      const payload = upsertTenantSettingsRequestSchema.parse({ tenantId, ...(docsUrl !== undefined ? { docsUrl } : {}) });
      return jsonResult(await upsertTenantSettings(payload));
    }
  );

  // ---------------------------------------------------------------------------
  // Users, groups & permissions — user-session-only (machine API credentials
  // are refused, mirroring the REST `userOnly` gates).
  // ---------------------------------------------------------------------------
  const VALID_PERMS = new Set<string>([...PERMISSIONS, WILDCARD]);

  server.registerTool(
    "list_permissions",
    { title: "List permissions", description: "List every fine-grained permission the platform defines (assignable to groups and API credentials). Requires users:read.", annotations: READ_ONLY },
    async () => (await ensureRead("users:read")) ?? jsonResult({ permissions: [...PERMISSIONS] })
  );

  server.registerTool(
    "list_users",
    { title: "List users", description: "List the tenant's members with their role and group assignments. User session only; requires users:read.", annotations: READ_ONLY },
    async () => {
      const denied = ensureUserSession() ?? (await ensureRead("users:read"));
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return jsonResult({ users: [] });
      return jsonResult({ users: await listTenantMembers(q, tenantId) });
    }
  );

  server.registerTool(
    "add_user",
    {
      title: "Add user to tenant",
      description: "Add an existing platform user to this tenant by email with a role. User session only; requires users:manage.",
      inputSchema: { email: z.string().email(), role: z.enum(["owner", "admin", "operator", "viewer"]).default("viewer") },
      annotations: MUTATING
    },
    async ({ email, role }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("users:manage"));
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      const r = await addTenantMemberByEmail(q, tenantId, email, role);
      return r.ok ? jsonResult({ ok: true, userId: r.userId }) : errorResult(r.reason);
    }
  );

  server.registerTool(
    "update_user",
    {
      title: "Update user",
      description: "Change a member's role and/or replace their custom group assignments. User session only; requires users:manage.",
      inputSchema: {
        userId: z.string(),
        role: z.enum(["owner", "admin", "operator", "viewer"]).optional(),
        groupIds: z.array(z.string()).optional().describe("Replaces the full set of custom group memberships")
      },
      annotations: MUTATING
    },
    async ({ userId, role, groupIds }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("users:manage"));
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      if (role) {
        const ok = await setMemberRole(q, tenantId, userId, role);
        if (!ok) return errorResult(`Member not found: ${userId}`);
      }
      if (groupIds) {
        await setMemberCustomGroups(q, tenantId, userId, groupIds);
      }
      return jsonResult({ ok: true, userId });
    }
  );

  server.registerTool(
    "remove_user",
    { title: "Remove user from tenant", description: "Remove a member from the tenant. You cannot remove yourself. User session only; requires users:manage.", inputSchema: { userId: z.string() }, annotations: DESTRUCTIVE },
    async ({ userId }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("users:manage"));
      if (denied) return denied;
      if (session.id === userId) return errorResult("You cannot remove yourself");
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      const ok = await removeTenantMember(q, tenantId, userId);
      return ok ? jsonResult({ removed: true, userId }) : errorResult(`Member not found: ${userId}`);
    }
  );

  server.registerTool(
    "list_groups",
    { title: "List groups", description: "List permission groups (built-in role groups and custom groups). User session only; requires users:read.", annotations: READ_ONLY },
    async () => {
      const denied = ensureUserSession() ?? (await ensureRead("users:read"));
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return jsonResult({ groups: [] });
      return jsonResult({ groups: await listGroups(q, tenantId) });
    }
  );

  server.registerTool(
    "create_group",
    {
      title: "Create group",
      description: "Create a custom permission group. User session only; requires users:manage.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().default(""),
        permissions: z.array(z.string()).default([]).describe("Permission strings from list_permissions; '*' = superuser")
      },
      annotations: MUTATING
    },
    async ({ name, description, permissions }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("users:manage"));
      if (denied) return denied;
      const bad = permissions.filter((p) => !VALID_PERMS.has(p));
      if (bad.length) return errorResult(`Unknown permission(s): ${bad.join(", ")}`);
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      try {
        return jsonResult(await createGroup(q, tenantId, { name, description, permissions }));
      } catch {
        return errorResult("A group with that name already exists");
      }
    }
  );

  server.registerTool(
    "update_group",
    {
      title: "Update group",
      description: "Update a custom group's name, description, or permissions. Built-in role groups are read-only. User session only; requires users:manage.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        permissions: z.array(z.string()).optional()
      },
      annotations: MUTATING
    },
    async ({ id, name, description, permissions }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("users:manage"));
      if (denied) return denied;
      if (permissions) {
        const bad = permissions.filter((p) => !VALID_PERMS.has(p));
        if (bad.length) return errorResult(`Unknown permission(s): ${bad.join(", ")}`);
      }
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      const updated = await updateGroup(q, tenantId, id, { name, description, permissions });
      return updated ? jsonResult(updated) : errorResult("Group not found or built-in (read-only)");
    }
  );

  server.registerTool(
    "delete_group",
    { title: "Delete group", description: "Delete a custom group. Built-in role groups cannot be deleted. User session only; requires users:manage.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("users:manage"));
      if (denied) return denied;
      const q = await requireQuery();
      if (!q) return dbUnavailable;
      const ok = await deleteGroup(q, tenantId, id);
      return ok ? jsonResult({ deleted: true, id }) : errorResult("Group not found or built-in (cannot delete)");
    }
  );

  // ---------------------------------------------------------------------------
  // API credentials — user-session-only. A credential can never mint or
  // revoke other credentials, even via MCP.
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_api_credentials",
    { title: "List API credentials", description: "List the tenant's API credentials (metadata only; tokens are never returned). User session only; requires apicredentials:manage.", annotations: READ_ONLY },
    async () => {
      const denied = ensureUserSession() ?? (await ensureRead("apicredentials:manage"));
      if (denied) return denied;
      return jsonResult({ credentials: await listApiCredentialsForTenant(tenantId) });
    }
  );

  server.registerTool(
    "create_api_credential",
    {
      title: "Create API credential",
      description: "Mint a long-lived machine bearer token with explicit scopes and optional fine-grained permissions. The plaintext token is returned once. User session only; requires apicredentials:manage.",
      inputSchema: {
        name: z.string().min(1),
        scopes: z.array(apiCredentialScopeSchema).min(1),
        permissions: z.array(z.string()).default([]).describe("Fine-grained permissions from list_permissions; empty = legacy scope-derived access")
      },
      annotations: MUTATING
    },
    async ({ name, scopes, permissions }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("apicredentials:manage"));
      if (denied) return denied;
      const bad = permissions.filter((p) => !VALID_PERMS.has(p));
      if (bad.length) return errorResult(`Unknown permission(s): ${bad.join(", ")}`);
      const { metadata, token } = await createApiCredentialForTenant({
        tenantId,
        name,
        scopes,
        permissions,
        createdBy: session.id
      });
      return jsonResult({ ...metadata, token });
    }
  );

  server.registerTool(
    "revoke_api_credential",
    { title: "Revoke API credential", description: "Revoke an API credential; its token stops working immediately. User session only; requires apicredentials:manage.", inputSchema: { id: z.string() }, annotations: DESTRUCTIVE },
    async ({ id }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("apicredentials:manage"));
      if (denied) return denied;
      const ok = await revokeApiCredentialForTenant(tenantId, id);
      return ok ? jsonResult({ revoked: true, id }) : errorResult("Credential not found or already revoked");
    }
  );

  // ---------------------------------------------------------------------------
  // Auth settings (OAuth providers, GitHub App) — user-session-only; these
  // carry client secrets and key material.
  // ---------------------------------------------------------------------------
  server.registerTool(
    "list_auth_providers",
    { title: "List auth providers", description: "List configured login providers (no secrets returned).", annotations: READ_ONLY },
    async () => jsonResult({ providers: listProviders() })
  );

  server.registerTool(
    "set_oauth_provider",
    {
      title: "Configure OAuth provider",
      description: "Add or replace an OAuth login provider configuration. User session only; requires settings:manage.",
      inputSchema: {
        id: z.string().min(1),
        provider: z.string().min(1),
        clientId: z.string().min(1),
        clientSecret: z.string().default(""),
        authorizeUrl: z.string().default(""),
        tokenUrl: z.string().default(""),
        userInfoUrl: z.string().default(""),
        scopes: z.array(z.string()).default([])
      },
      annotations: MUTATING
    },
    async (args) => {
      const denied = ensureUserSession() ?? (await ensureWrite("settings:manage"));
      if (denied) return denied;
      const cfg: OAuthProviderConfig = {
        id: args.id,
        provider: args.provider,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        authorizeUrl: args.authorizeUrl,
        tokenUrl: args.tokenUrl,
        userInfoUrl: args.userInfoUrl,
        scopes: args.scopes
      };
      try {
        addOAuthProvider(cfg);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : "Invalid OAuth provider configuration");
      }
      return jsonResult({ ok: true, id: args.id });
    }
  );

  server.registerTool(
    "get_github_app_settings",
    { title: "Get GitHub App settings", description: "Read the GitHub App configuration (secrets redacted — only whether they are set). User session only; requires settings:manage.", annotations: READ_ONLY },
    async () => {
      const denied = ensureUserSession() ?? (await ensureRead("settings:manage"));
      if (denied) return denied;
      const gh = readConfig()?.githubApp;
      return jsonResult({
        appId: gh?.appId?.trim() ? gh.appId : null,
        appSlug: gh?.appSlug?.trim() ? gh.appSlug : null,
        privateKeyConfigured: !!gh?.privateKeyPem?.trim(),
        webhookSecretConfigured: !!gh?.webhookSecret?.trim()
      });
    }
  );

  server.registerTool(
    "set_github_app_settings",
    {
      title: "Configure GitHub App",
      description: "Set the GitHub App used for repo webhooks/checkouts. Omit privateKeyPem/webhookSecret to keep the stored values. User session only; requires settings:manage.",
      inputSchema: {
        appId: z.string().min(1),
        appSlug: z.string().optional(),
        privateKeyPem: z.string().optional(),
        webhookSecret: z.string().optional()
      },
      annotations: MUTATING
    },
    async ({ appId, appSlug, privateKeyPem, webhookSecret }) => {
      const denied = ensureUserSession() ?? (await ensureWrite("settings:manage"));
      if (denied) return denied;
      const current = readConfig();
      if (!current) {
        return errorResult("Server configuration file not found; complete setup before editing GitHub App credentials");
      }
      const existing = current.githubApp;
      const nextPem = privateKeyPem?.trim() || existing?.privateKeyPem?.trim() || "";
      const nextSecret = webhookSecret?.trim() || existing?.webhookSecret?.trim() || "";
      if (!nextPem) return errorResult("GitHub App private key is required when none is stored yet");
      if (!nextSecret) return errorResult("GitHub webhook secret is required when none is stored yet");
      const nextSlug = appSlug !== undefined ? appSlug.trim() : existing?.appSlug?.trim() ?? "";
      const next: KaiadConfig = {
        ...current,
        githubApp: {
          appId,
          privateKeyPem: nextPem,
          webhookSecret: nextSecret,
          ...(nextSlug ? { appSlug: nextSlug } : {})
        }
      };
      try {
        await writeConfig(next);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : "Failed to write configuration");
      }
      return jsonResult({ ok: true });
    }
  );

  return server;
}

/**
 * Register the hosted MCP endpoint. `POST /mcp` speaks the Streamable HTTP
 * transport in stateless mode (a fresh transport + server per request, bound to
 * the caller's session). Entry requires the `mcp.read` or `mcp.write` scope;
 * individual tools additionally require a fine-grained permission and mutating
 * tools require `mcp.write`. `GET`/`DELETE` return 405 — there is no
 * standalone SSE stream or session to delete in stateless mode.
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
