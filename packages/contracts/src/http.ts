import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok"]),
  uptimeSeconds: z.number().nonnegative()
});

export const membershipEntrySchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  role: z.enum(["owner", "admin", "operator", "viewer"])
});

export const meResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["owner", "admin", "operator", "viewer"]),
  tenantId: z.string(),
  memberships: z.array(membershipEntrySchema),
  /** Effective permissions for the active tenant (union of the user's groups). */
  permissions: z.array(z.string()).default([])
});

export const switchActiveTenantRequestSchema = z.object({
  tenantId: z.string().min(1)
});

export const switchActiveTenantResponseSchema = meResponseSchema;

export const createTenantRequestSchema = z.object({
  name: z.string().min(1).max(200),
  tenantId: z
    .string()
    .regex(/^t-[a-z0-9-]+$/)
    .optional()
});

/** POST /api/v1/tenants returns the same shape as GET /me after switching to the new tenant. */
export const createTenantResponseSchema = meResponseSchema;

export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

export const tenantSettingsSchema = z.object({
  tenantId: z.string(),
  docsUrl: z.string().url().optional(),
  preferredExecutor: z.enum(["cursor", "claude"]).optional()
});

export const upsertTenantSettingsRequestSchema = tenantSettingsSchema;

export const sshKeySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1),
  type: z.enum(["uploaded", "local_path"]),
  localPath: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const createSshKeyRequestSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["uploaded", "local_path"]),
  privateKey: z.string().optional(),
  localPath: z.string().optional()
});

export const listSshKeysResponseSchema = z.object({
  keys: z.array(sshKeySchema)
});

export const createEnrollmentTokenRequestSchema = z.object({
  ttlSeconds: z.number().int().positive().max(365 * 24 * 60 * 60)
});

export const enrollmentTokenMetadataSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  expiresAt: z.string().datetime(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  usedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  isActive: z.boolean()
});

export const createEnrollmentTokenResponseSchema = enrollmentTokenMetadataSchema.extend({
  token: z.string().min(1)
});

export const listEnrollmentTokensResponseSchema = z.object({
  tokens: z.array(enrollmentTokenMetadataSchema)
});

export type CreateEnrollmentTokenRequest = z.infer<typeof createEnrollmentTokenRequestSchema>;
export type EnrollmentTokenMetadata = z.infer<typeof enrollmentTokenMetadataSchema>;
export type CreateEnrollmentTokenResponse = z.infer<typeof createEnrollmentTokenResponseSchema>;
export type ListEnrollmentTokensResponse = z.infer<typeof listEnrollmentTokensResponseSchema>;

export const incidentStatusSchema = z.enum(["open", "acknowledged", "resolved", "closed"]);

export const incidentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  serviceId: z.string(),
  fingerprint: z.string(),
  status: incidentStatusSchema,
  message: z.string().optional(),
  /** Full captured log / stack trace for the incident. */
  fullLog: z.string().optional(),
  /** Live progress of the latest in-kaiad autonomous fix attempt. */
  lastFixStatus: z
    .enum([
      "running",
      "cloning",
      "cli",
      "committing",
      "pushing",
      "succeeded",
      "no_changes",
      "auth_failed",
      "clone_failed",
      "cli_failed",
      "push_failed",
      "failed"
    ])
    .optional(),
  lastFixExecutor: z.enum(["claude", "cursor"]).optional(),
  lastFixStartedAt: z.string().datetime().optional(),
  lastFixFinishedAt: z.string().datetime().optional(),
  lastFixCommitSha: z.string().optional(),
  lastFixOutput: z.string().optional(),
  lastFixEvents: z
    .array(
      z.object({
        at: z.string().datetime(),
        step: z.string(),
        ok: z.boolean().optional(),
        message: z.string().optional(),
        /** Exact command line executed (e.g. "git clone …", "claude -p …"). */
        cmd: z.string().optional(),
        /** Truncated stdout+stderr from that command. */
        output: z.string().optional(),
        /** Process exit code. */
        code: z.number().int().optional()
      })
    )
    .default([]),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  eventCount: z.number().int().nonnegative().default(1)
});

export const listIncidentsResponseSchema = z.object({
  incidents: z.array(incidentSchema)
});

export const updateIncidentStatusRequestSchema = z.object({
  status: incidentStatusSchema
});

/**
 * AgentBinding is the per-row shape of MonitoredService.agents — the list of
 * agents that observe / can act on this service. Kept as an object (rather
 * than a bare string) so we can grow `priority`, `createdAt`, etc. without
 * a breaking contract change.
 */
export const agentBindingSchema = z.object({
  agentId: z.string()
});

export const monitoredServiceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  gitRepoUrl: z.string(),
  sshKeyId: z.string().nullable().optional(),
  branch: z.string(),
  dockerImage: z.string().nullable().optional(),
  composePath: z.string().nullable().optional(),
  /**
   * For multi-pipeline kaiad.yaml files (services: { php: {...},
   * nginx: {...} }), picks which pipeline this service represents.
   * Null/undefined means "single-pipeline kaiad.yaml" — the only
   * pipeline at the file root.
   */
  pipelineName: z.string().nullable().optional(),
  /**
   * Which AI CLI the agent spins up to author an autonomous fix when
   * this service throws an error kaiad can see. Defaults to claude.
   */
  fixExecutor: z.enum(["claude", "cursor"]).default("claude"),
  /** Agents currently bound to this service. Empty until at least one is attached. */
  agents: z.array(agentBindingSchema).default([])
});

export const createMonitoredServiceRequestSchema = z.object({
  name: z.string().min(1),
  gitRepoUrl: z.string().min(1),
  sshKeyId: z.string().nullable().optional(),
  branch: z.string().min(1),
  /** Initial agent bindings; safe to omit for unbound services. */
  agentIds: z.array(z.string()).default([]),
  dockerImage: z.string().min(1).optional(),
  composePath: z.string().min(1).optional(),
  pipelineName: z.string().min(1).nullable().optional(),
  fixExecutor: z.enum(["claude", "cursor"]).optional()
});

export const updateMonitoredServiceRequestSchema = z.object({
  name: z.string().min(1).optional(),
  gitRepoUrl: z.string().min(1).optional(),
  sshKeyId: z.string().nullable().optional(),
  branch: z.string().min(1).optional(),
  /**
   * When provided, replaces the full set of agent bindings (delete-not-in,
   * insert-missing). Omit to leave bindings unchanged. To detach all agents,
   * pass `[]`.
   */
  agentIds: z.array(z.string()).optional(),
  dockerImage: z.string().min(1).optional(),
  composePath: z.string().min(1).optional(),
  pipelineName: z.string().min(1).nullable().optional(),
  fixExecutor: z.enum(["claude", "cursor"]).optional()
});

export const listMonitoredServicesResponseSchema = z.object({
  services: z.array(monitoredServiceSchema)
});

export const attachServiceToAgentResponseSchema = z.object({
  bound: z.boolean(),
  agentId: z.string(),
  serviceId: z.string()
});

export const listServicesForAgentResponseSchema = z.object({
  services: z.array(monitoredServiceSchema)
});

/** Latest host_stats payload merged into the agent list response. */
export const agentTelemetrySchema = z.object({
  /** Timestamp of the most recent host_stats frame (ISO). */
  ts: z.string(),
  cpuPercent: z.number().min(0).max(100).optional(),
  memUsedBytes: z.number().int().nonnegative().optional(),
  memTotalBytes: z.number().int().positive().optional(),
  memPercent: z.number().min(0).max(100).optional(),
  diskUsedBytes: z.number().int().nonnegative().optional(),
  diskTotalBytes: z.number().int().positive().optional(),
  diskPath: z.string().optional(),
  netRxBytesPerSec: z.number().nonnegative().optional(),
  netTxBytesPerSec: z.number().nonnegative().optional(),
  processRSSBytes: z.number().int().nonnegative().optional()
});

export type AgentTelemetry = z.infer<typeof agentTelemetrySchema>;

/** Latest app_stats payload (per-container) merged into the agent list response. */
export const agentAppTelemetrySchema = z.object({
  ts: z.string(),
  containerId: z.string(),
  name: z.string().optional(),
  image: z.string().optional(),
  serviceId: z.string().optional(),
  state: z.string().optional(),
  cpuPercent: z.number().min(0).optional(),
  memUsedBytes: z.number().int().nonnegative().optional(),
  memLimitBytes: z.number().int().positive().optional(),
  memPercent: z.number().min(0).max(100).optional(),
  netRxBytesPerSec: z.number().nonnegative().optional(),
  netTxBytesPerSec: z.number().nonnegative().optional()
});

export type AgentAppTelemetry = z.infer<typeof agentAppTelemetrySchema>;

// Lowercase k8s-style names. Mirrors the regex used for kaiad.yaml
// environment names so an agent's environment is a valid key into
// pipelineDefinition.environments.
const agentEnvironmentRegex = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const agentEnvironmentSchema = z
  .string()
  .regex(agentEnvironmentRegex, "environment must be lowercase alphanumeric with hyphens (max 63 chars)");

/** Server may merge RealtimeManager session state into list responses. */
export const agentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  status: z.enum(["online", "offline", "degraded", "unknown"]),
  lastSeenAt: z.string().datetime().nullable(),
  certFingerprint: z.string().nullable().optional(),
  allowedCapabilities: z.array(z.string()).optional(),
  /**
   * Deployment environment this agent serves. Matches the keys used
   * inside `kaiad.yaml`'s `environments:` map so the operator picks
   * the right per-env block when redeploying.
   */
  environment: agentEnvironmentSchema.default("development"),
  /**
   * Runtime backend the agent reports it has actually configured
   * itself for ("docker" | "kubernetes" | "shell"). Null until the
   * first runtime-aware heartbeat lands — pre-upgrade agents predate
   * this field, so the UI shows them as "unknown".
   */
  runtimeBackend: z.enum(["docker", "kubernetes", "shell"]).nullable().optional(),
  websocketConnected: z.boolean().optional(),
  telemetry: agentTelemetrySchema.optional(),
  apps: z.array(agentAppTelemetrySchema).optional()
});

export const updateAgentRequestSchema = z.object({
  name: z.string().nullable().optional(),
  allowedCapabilities: z.array(z.string()).optional(),
  environment: agentEnvironmentSchema.optional()
});

export const listAgentsResponseSchema = z.object({
  agents: z.array(agentSchema)
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type MembershipEntry = z.infer<typeof membershipEntrySchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type SshKey = z.infer<typeof sshKeySchema>;
export type CreateSshKeyRequest = z.infer<typeof createSshKeyRequestSchema>;
export type ListSshKeysResponse = z.infer<typeof listSshKeysResponseSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type AgentBinding = z.infer<typeof agentBindingSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type MonitoredService = z.infer<typeof monitoredServiceSchema>;
export type CreateMonitoredServiceRequest = z.infer<typeof createMonitoredServiceRequestSchema>;
export type UpdateMonitoredServiceRequest = z.infer<typeof updateMonitoredServiceRequestSchema>;
export type AttachServiceToAgentResponse = z.infer<typeof attachServiceToAgentResponseSchema>;
export type ListServicesForAgentResponse = z.infer<typeof listServicesForAgentResponseSchema>;
export type Agent = z.infer<typeof agentSchema>;

// ---------------------------------------------------------------------------
// OAuth / OIDC auth
// ---------------------------------------------------------------------------

export const oauthAuthorizeResponseSchema = z.object({
  authorizeUrl: z.string()
});

export const oauthCallbackResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    tenantId: z.string(),
    role: z.enum(["owner", "admin", "operator", "viewer"])
  })
});

export const authProviderEntrySchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string()
});

export const listAuthProvidersResponseSchema = z.object({
  providers: z.array(authProviderEntrySchema)
});

export type OAuthAuthorizeResponse = z.infer<typeof oauthAuthorizeResponseSchema>;
export type OAuthCallbackResponse = z.infer<typeof oauthCallbackResponseSchema>;
export type AuthProviderEntry = z.infer<typeof authProviderEntrySchema>;
export type ListAuthProvidersResponse = z.infer<typeof listAuthProvidersResponseSchema>;

export const apiCredentialScopeSchema = z.enum(["enrollment-tokens.create", "agents.read"]);

export const apiCredentialMetadataSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string().datetime(),
  createdBy: z.string().nullable(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable()
});

export const createApiCredentialRequestSchema = z.object({
  name: z.string().min(1),
  scopes: z.array(apiCredentialScopeSchema).min(1)
});

export const createApiCredentialResponseSchema = apiCredentialMetadataSchema.extend({
  token: z.string().min(1)
});

export const listApiCredentialsResponseSchema = z.object({
  credentials: z.array(apiCredentialMetadataSchema)
});

export type ApiCredentialScope = z.infer<typeof apiCredentialScopeSchema>;
export type ApiCredentialMetadata = z.infer<typeof apiCredentialMetadataSchema>;
export type CreateApiCredentialRequest = z.infer<typeof createApiCredentialRequestSchema>;
export type CreateApiCredentialResponse = z.infer<typeof createApiCredentialResponseSchema>;
export type ListApiCredentialsResponse = z.infer<typeof listApiCredentialsResponseSchema>;

// --- Registry retention -----------------------------------------------------

export const registryRetentionPolicySchema = z.object({
  keepLastNPerRepo: z.number().int().min(0),
  maxTotalBytes: z.number().int().min(0),
  /** 0 = no age-based pruning (only keep-last-N + size cap apply). */
  keepForDays: z.number().int().min(0),
  updatedAt: z.string().datetime()
});
export const updateRegistryRetentionPolicyRequestSchema = z.object({
  keepLastNPerRepo: z.number().int().min(0).optional(),
  maxTotalBytes: z.number().int().min(0).optional(),
  keepForDays: z.number().int().min(0).optional()
});
export const registryStatsSchema = z.object({
  totalBytes: z.number().int().min(0),
  totalBlobs: z.number().int().min(0),
  repos: z.array(
    z.object({
      repo: z.string(),
      tags: z.number().int().min(0),
      bytes: z.number().int().min(0)
    })
  )
});
export const registryGcStatsSchema = z.object({
  tagsDeleted: z.number().int().min(0),
  manifestsDeleted: z.number().int().min(0),
  blobsDeleted: z.number().int().min(0),
  bytesReclaimed: z.number().int().min(0),
  totalBytesAfter: z.number().int().min(0)
});
export const registryRetentionResponseSchema = z.object({
  policy: registryRetentionPolicySchema,
  stats: registryStatsSchema
});

export type RegistryRetentionPolicy = z.infer<typeof registryRetentionPolicySchema>;
export type UpdateRegistryRetentionPolicyRequest = z.infer<typeof updateRegistryRetentionPolicyRequestSchema>;
export type RegistryStats = z.infer<typeof registryStatsSchema>;
export type RegistryGcStats = z.infer<typeof registryGcStatsSchema>;
export type RegistryRetentionResponse = z.infer<typeof registryRetentionResponseSchema>;
