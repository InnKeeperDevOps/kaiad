import type { CreateTenantRequest, MeResponse, TenantSettings, SshKey, CreateSshKeyRequest } from "@sm/contracts";
export type { SshKey, CreateSshKeyRequest, CreateTenantRequest, MeResponse, TenantSettings };
import type { AuthUser } from "./useAuth.js";

/** Maps `/api/v1/me` JSON to `AuthUser` for React context. */
export function meResponseToAuthUser(m: MeResponse): AuthUser {
  const incomingMemberships = Array.isArray((m as { memberships?: unknown }).memberships)
    ? (m as { memberships: Array<{ tenantId: string; tenantName: string; role: AuthUser["role"] }> }).memberships
    : [];
  const memberships =
    incomingMemberships.length > 0
      ? incomingMemberships.map((row) => ({
          tenantId: row.tenantId,
          tenantName: row.tenantName,
          role: row.role
        }))
      : [
          {
            tenantId: m.tenantId,
            tenantName: m.tenantId,
            role: m.role
          }
        ];

  return {
    id: m.id,
    email: m.email,
    role: m.role,
    tenantId: m.tenantId,
    memberships,
    permissions: Array.isArray((m as { permissions?: unknown }).permissions)
      ? ((m as { permissions: string[] }).permissions)
      : []
  };
}


const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:3001" : "");

/** Derive the WebSocket base URL from API_BASE, falling back to current window origin. */
export function wsBaseUrl(): string {
  if (API_BASE) {
    if (API_BASE.startsWith("http://")) return `ws://${API_BASE.slice("http://".length)}`;
    if (API_BASE.startsWith("https://")) return `wss://${API_BASE.slice("https://".length)}`;
  }
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return "";
}

/** Open the UI telemetry WebSocket, passing the session token in the query string. */
export function openTelemetryStream(): WebSocket {
  const token = encodeURIComponent(getAuthToken());
  return new WebSocket(`${wsBaseUrl()}/api/v1/realtime/ui?token=${token}`);
}

function getAuthToken(): string {
  return localStorage.getItem("sm_token") ?? import.meta.env.VITE_AUTH_TOKEN ?? "dev-token";
}

/** GET /api/v1/settings — returns null when no row exists (404), throws on other errors. */
export async function getTenantSettings(): Promise<TenantSettings | null> {
  const res = await fetch(`${API_BASE}/api/v1/settings`, {
    headers: {
      Authorization: `Bearer ${getAuthToken()}`
    }
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
    throw new Error(body.message ?? `API ${res.status}`);
  }
  return res.json() as Promise<TenantSettings>;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null && init.body !== "";
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined)
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
    throw new Error(body.message ?? `API ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

/** A tenant API credential — a long-lived bearer token for programmatic access. */
export type ApiCredentialScope =
  | "enrollment-tokens.create"
  | "agents.read"
  | "registry.pull"
  | "registry.push";
export type ApiCredential = {
  id: string;
  tenantId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** One line of a kaiad agent's or operator's own process log. */
export type ComponentLogLine = {
  id: string;
  source: "agent" | "operator";
  sourceId: string;
  level: string;
  message: string;
  ts: string;
};

export type Incident = {
  id: string;
  tenantId: string;
  serviceId: string;
  fingerprint: string;
  status: string;
  message?: string;
  /** Full captured log / stack trace for the incident. */
  fullLog?: string;
  lastFixStatus?:
    | "running"
    | "cloning"
    | "cli"
    | "committing"
    | "pushing"
    | "succeeded"
    | "no_changes"
    | "auth_failed"
    | "clone_failed"
    | "cli_failed"
    | "push_failed"
    | "failed";
  lastFixExecutor?: "claude" | "cursor";
  lastFixStartedAt?: string;
  lastFixFinishedAt?: string;
  lastFixCommitSha?: string;
  lastFixOutput?: string;
  lastFixEvents?: {
    at: string;
    step: string;
    ok?: boolean;
    message?: string;
    cmd?: string;
    output?: string;
    code?: number;
  }[];
  firstSeenAt: string;
  lastSeenAt: string;
  eventCount: number;
};

export type AgentTelemetry = {
  ts: string;
  cpuPercent?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  memPercent?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  diskPath?: string;
  netRxBytesPerSec?: number;
  netTxBytesPerSec?: number;
  processRSSBytes?: number;
};

export type AgentAppTelemetry = {
  ts: string;
  containerId: string;
  name?: string;
  image?: string;
  serviceId?: string;
  state?: string;
  cpuPercent?: number;
  memUsedBytes?: number;
  memLimitBytes?: number;
  memPercent?: number;
  netRxBytesPerSec?: number;
  netTxBytesPerSec?: number;
};

export type ErrorGroupStatus = "open" | "fixing" | "fixed" | "paused" | "missing_auth";

export type ErrorGroup = {
  id: string;
  tenantId: string;
  agentId: string;
  serviceId: string;
  fingerprint: string;
  normalizedMessage: string;
  sampleMessage: string;
  status: ErrorGroupStatus;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastFixAt?: string | null;
  lastFixCommit?: string | null;
  contextLines?: string[];
};

export type UiTelemetryEvent =
  | { type: "host_stats"; agentId: string; stats: Omit<AgentTelemetry, never> }
  | {
      type: "app_stats";
      agentId: string;
      containerId: string;
      stats: Omit<AgentAppTelemetry, "containerId">;
    }
  | { type: "agent_presence"; agentId: string; websocketConnected: boolean }
  | { type: "app_gone"; agentId: string; containerId: string }
  | { type: "error_group_updated"; group: ErrorGroup };

export type Agent = {
  id: string;
  tenantId: string;
  name: string | null;
  version: string | null;
  status: string;
  lastSeenAt: string | null;
  certFingerprint?: string | null;
  allowedCapabilities?: string[];
  /** Deployment environment (e.g. "development", "production") — keys into kaiad.yaml's environments map. */
  environment: string;
  /** Runtime backend the agent reports it has configured itself for. Null on legacy agents that predate the field. */
  runtimeBackend?: "docker" | "kubernetes" | "shell" | null;
  /** Present when API merges RealtimeManager session state. */
  websocketConnected?: boolean;
  /** Latest host_stats merged from RealtimeManager. */
  telemetry?: AgentTelemetry;
  /** Latest app_stats per container, merged from RealtimeManager. */
  apps?: AgentAppTelemetry[];
};

/**
 * AgentBinding mirrors the contract type — kept as an object so additional
 * fields (priority, createdAt) can be added without breaking call sites.
 */
export type AgentBinding = { agentId: string };

/**
 * HTTP readiness check shared between kaiad.yaml, the panel form, and
 * the redeploy_service wire schema. When set on a service, the agent
 * renders a readinessProbe + startupProbe and the Deployment strategy
 * holds the old replica until the new one is Ready.
 */
export type Healthcheck = {
  path: string;
  port: number;
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
};

/**
 * Pod-level securityContext for a service. Most common knob: set
 * `runAsUser` so an image whose entrypoint does its own `chown -R`
 * skips that branch (postgres, mysql, …) — saves us when the data
 * volume is on an NFS export with root_squash on.
 */
export type PodSecurityContext = {
  runAsUser?: number;
  runAsGroup?: number;
  fsGroup?: number;
};

export type MonitoredService = {
  id: string;
  tenantId: string;
  name: string;
  gitRepoUrl: string;
  sshKeyId?: string | null;
  branch: string;
  /** Agents currently observing this service. Empty until at least one is bound. */
  agents: AgentBinding[];
  dockerImage?: string | null;
  composePath?: string | null;
  /**
   * Which pipeline to pick from a multi-pipeline kaiad.yaml. When the
   * yaml uses the legacy single-pipeline form, this is null/unset.
   */
  pipelineName?: string | null;
  /** AI CLI kaiad spins up to autonomously fix this service. Defaults to claude. */
  fixExecutor?: "claude" | "cursor";
  /** Null/absent = no probe; the rolling-update strategy still applies. */
  healthcheck?: Healthcheck | null;
  /** Null/absent = no pod securityContext block rendered. */
  securityContext?: PodSecurityContext | null;
  /**
   * When true, the build poller skips this service: new commits to
   * the watched branch don't auto-enqueue a build, so they don't
   * auto-deploy either. The "Start build" button still works.
   */
  locked?: boolean;
};

/** Matches server OAuth provider registration (POST /api/v1/settings/oauth-providers). */
export type OAuthProviderConfigPayload = {
  id: string;
  provider: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
};

export type LoadBalancerEntry = {
  id: string;
  serviceId: string;
  serviceName: string;
  agentId: string | null;
  /** Runtime backend of the reporting agent ("docker"|"kubernetes"|"shell"). Null until first runtime-aware heartbeat. */
  agentRuntime: "docker" | "kubernetes" | "shell" | null;
  environment: string;
  namespace: string;
  lbType: "none" | "k8s" | "metallb" | "nginx";
  externalIp: string | null;
  externalHostname: string | null;
  ports: Array<{ port: number; name?: string; protocol?: string; targetPort?: number }>;
  domains: Array<{ host: string; port: number; protocol: "http" | "https" }>;
  detail: Record<string, unknown>;
  observedAt: string;
};

export type BuildStatus = "queued" | "running" | "success" | "failed" | "no_pipeline";
export type BuildTrigger = "poll" | "manual";

export type ServiceBuild = {
  id: string;
  tenantId: string;
  serviceId: string;
  gitSha: string;
  branch: string;
  status: BuildStatus;
  triggeredBy: BuildTrigger;
  imageRef: string | null;
  log: string;
  pipelineYaml: string | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type ServiceBuildArtifact = {
  buildId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  relPath: string;
  createdAt: string;
};

export type DeployResult = {
  dispatched: number;
  results: Array<{ agentId: string; delivered: boolean; queued: boolean }>;
  skipped: string[];
};

export type RegistryRepository = {
  name: string;
  /** Anonymous pull allowed. */
  public?: boolean;
  /** Always-public (e.g. kaiad-agent) — visibility toggle is locked. */
  forcedPublic?: boolean;
};

export type RegistryTag = {
  tag: string;
  digest?: string;
  sizeBytes?: number;
  createdAt?: string;
  /**
   * Platforms the tag covers, formatted `<os>/<arch>[/<variant>]`.
   * Image-index / manifest-list tags get one entry per referenced
   * per-platform manifest; single-arch tags get a single entry derived
   * from the image config. Empty/absent when the manifest carried no
   * usable platform info.
   */
  platforms?: string[];
};

export type RegistryImageFile = {
  path: string;
  type: "file" | "directory" | "symlink" | "hardlink" | "other";
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  linkTarget?: string;
  /** Index into `layers[]` of the layer that wrote this entry. */
  layerIdx: number;
};

export type RegistryImageFilesResponse =
  | {
      manifestKind: "image";
      digest: string;
      configDigest: string | null;
      layers: Array<{ digest: string; sizeBytes: number; mediaType: string | null }>;
      files: RegistryImageFile[];
    }
  | {
      /** Manifest list / OCI index — no layers of its own; pick a child manifest. */
      manifestKind: "index";
      digest: string;
      referencedManifestDigests: string[];
      layers: [];
      files: [];
    };

export type RegistryImageFileResponse = {
  path: string;
  layerIdx: number;
  layerDigest: string;
  mode: number;
  uid: number;
  gid: number;
  /** Original (uncapped) file size in bytes. */
  size: number;
  /** True when `bodyBase64` carries only a prefix of the file. */
  truncated: boolean;
  bodyBase64: string;
};

export type AuthProviderEntry = {
  id: string;
  provider: string;
  name: string;
};

export type RegistryRetentionPolicy = {
  keepLastNPerRepo: number;
  maxTotalBytes: number;
  keepForDays: number;
  updatedAt: string;
};
export type RegistryStats = {
  totalBytes: number;
  totalBlobs: number;
  repos: { repo: string; tags: number; bytes: number }[];
};
export type RegistryRetentionResponse = { policy: RegistryRetentionPolicy; stats: RegistryStats };
export type RegistryGcStats = {
  tagsDeleted: number;
  manifestsDeleted: number;
  blobsDeleted: number;
  bytesReclaimed: number;
  totalBytesAfter: number;
};

export const api = {
  login: (email: string, password: string) =>
    apiFetch<{ token: string }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),

  logout: () => {
    localStorage.removeItem("sm_token");
    window.location.reload();
  },

  me: () => apiFetch<MeResponse>("/api/v1/me"),

  switchActiveTenant: (tenantId: string) =>
    apiFetch<MeResponse>("/api/v1/session/active-tenant", {
      method: "POST",
      body: JSON.stringify({ tenantId })
    }),

  createTenant: (body: CreateTenantRequest) =>
    apiFetch<MeResponse>("/api/v1/tenants", {
      method: "POST",
      body: JSON.stringify(body)
    }),

  deleteTenant: (tenantId: string) =>
    apiFetch<void>(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
      method: "DELETE"
    }),

  listSshKeys: () => apiFetch<{ keys: SshKey[] }>("/api/v1/ssh-keys"),
  createSshKey: (body: CreateSshKeyRequest) =>
    apiFetch<SshKey>("/api/v1/ssh-keys", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  deleteSshKey: (id: string) =>
    apiFetch<void>(`/api/v1/ssh-keys/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  listIncidents: () => apiFetch<{ incidents: Incident[] }>("/api/v1/incidents"),
  updateIncidentStatus: (id: string, status: string) =>
    apiFetch<Incident>(`/api/v1/incidents/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }),
  deleteIncident: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/incidents/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  runIncidentFix: (id: string) =>
    apiFetch<{ ok: boolean; groupId: string }>(`/api/v1/incidents/${encodeURIComponent(id)}/run-fix`, {
      method: "POST"
    }),

  /** Lists autonomous fixes currently running inside the kaiad process
   *  (scoped to the caller's tenant). Returns elapsed ms per entry so
   *  the UI can show "running for 2m 14s". */
  listInFlightAutoFixes: () =>
    apiFetch<{
      fixes: Array<{
        tenantId: string;
        serviceId: string;
        serviceName: string;
        groupId: string | null;
        fingerprint: string | null;
        incidentId: string | null;
        executor: "claude" | "cursor" | null;
        startedAt: string;
        triggeredBy: "auto" | "manual" | null;
        elapsedMs: number;
        /** Acquire-window lock that hasn't entered the full runner yet
         *  (or whose runner has crashed without releasing). Surfaced
         *  so an operator can cancel an orphaned placeholder. */
        pending?: boolean;
      }>;
    }>("/api/v1/auto-fix/in-flight"),

  /** Cancel the in-flight fix for a service. `action` controls follow-up:
   *  "retry" re-dispatches as soon as the cancel settles; "delete" removes
   *  the incident the cancelled fix was attached to; default kills the run
   *  and leaves the incident at status `cancelled`. */
  cancelInFlightAutoFix: (serviceId: string, action: "retry" | "delete" | "none" = "none") => {
    const q = action === "none" ? "" : `?action=${action}`;
    return apiFetch<{ ok: boolean; action: string; groupId?: string }>(
      `/api/v1/auto-fix/in-flight/${encodeURIComponent(serviceId)}/cancel${q}`,
      { method: "POST" }
    );
  },
  listAgents: () => apiFetch<{ agents: Agent[] }>("/api/v1/agents"),
  getAgent: (id: string) =>
    apiFetch<Agent>(`/api/v1/agents/${encodeURIComponent(id)}`),

  /** Rich per-agent detail: per-service instances/cpu/mem/net + deployed version + queued actions. */
  getAgentDetail: (agentId: string) =>
    apiFetch<{
      connected: boolean;
      queuedActions: { type: string; commandId: string }[];
      services: {
        serviceId: string;
        name: string;
        environment: string;
        namespace: string;
        lbType: string;
        externalIp: string | null;
        imageRef: string | null;
        buildId: string | null;
        gitSha: string | null;
        buildStatus: string | null;
        observedAt: string;
        runningInstances: number;
        cpuPercent: number | null;
        memUsedBytes: number | null;
        memPercent: number | null;
        netRxBytesPerSec: number | null;
        netTxBytesPerSec: number | null;
      }[];
    }>(`/api/v1/agents/${encodeURIComponent(agentId)}/detail`),

  /** Fetch recent logs for a service running on an agent (admin/owner). */
  fetchServiceLogs: (agentId: string, serviceId: string, tail = 200) =>
    apiFetch<{ status: string; output: string }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/services/${encodeURIComponent(serviceId)}/logs?tail=${tail}`,
      { method: "POST" }
    ),
  /** The kaiad agent's own process logs. `afterId` fetches only newer lines. */
  fetchAgentLogs: (agentId: string, afterId?: string, limit = 300) =>
    apiFetch<{ logs: ComponentLogLine[] }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/logs?limit=${limit}` +
        (afterId ? `&afterId=${encodeURIComponent(afterId)}` : "")
    ),
  /** The kaiad operator's own process logs. `afterId` fetches only newer lines. */
  fetchOperatorLogs: (afterId?: string, limit = 300) =>
    apiFetch<{ logs: ComponentLogLine[] }>(
      `/api/v1/operator/logs?limit=${limit}` +
        (afterId ? `&afterId=${encodeURIComponent(afterId)}` : "")
    ),
  updateAgent: (
    id: string,
    data: { name?: string | null; allowedCapabilities?: string[]; environment?: string }
  ) =>
    apiFetch<Agent>(`/api/v1/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),
  deleteAgent: (id: string) =>
    apiFetch<void>(`/api/v1/agents/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  listServices: () => apiFetch<{ services: MonitoredService[] }>("/api/v1/services"),
  listErrorGroups: () => apiFetch<{ groups: ErrorGroup[] }>("/api/v1/error-groups"),
  listErrorGroupsForAgent: (agentId: string) =>
    apiFetch<{ groups: ErrorGroup[] }>(`/api/v1/agents/${encodeURIComponent(agentId)}/error-groups`),
  listErrorGroupsForService: (serviceId: string) =>
    apiFetch<{ groups: ErrorGroup[] }>(`/api/v1/services/${encodeURIComponent(serviceId)}/error-groups`),
  /**
   * Preview a remote repo's kaiad.yaml before creating any services
   * for it. Drives the Add-Service wizard's "what's actually in this
   * repo?" step: tells the UI whether the file is single- or
   * multi-pipeline and lists the pipeline names so the user can decide
   * whether to fan out the create.
   */
  previewPipeline: (data: {
    gitRepoUrl: string;
    branch?: string;
    sshKeyId?: string | null;
    /** Repo-relative path to the pipeline file. Defaults to `kaiad.yaml`. */
    kaiadYamlPath?: string;
  }) =>
    apiFetch<{
      pipelineYaml: string;
      parse:
        | { ok: true; kind: "single"; pipelineNames: string[] }
        | { ok: true; kind: "multi"; pipelineNames: string[] }
        | { ok: false; reason: string };
    }>("/api/v1/services/preview-pipeline", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  createService: (data: {
    name: string;
    gitRepoUrl: string;
    sshKeyId?: string;
    branch: string;
    /** Initial agent bindings (many-to-many). */
    agentIds?: string[];
    dockerImage?: string;
    composePath?: string;
    /** Required when the repo's kaiad.yaml is multi-pipeline. */
    pipelineName?: string | null;
    /** Repo-relative path to the pipeline file. Defaults to `kaiad.yaml`. */
    kaiadYamlPath?: string;
    fixExecutor?: "claude" | "cursor";
    healthcheck?: Healthcheck | null;
    securityContext?: PodSecurityContext | null;
    locked?: boolean;
  }) =>
    apiFetch<MonitoredService>("/api/v1/services", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  updateService: (id: string, data: {
    name?: string;
    gitRepoUrl?: string;
    sshKeyId?: string | null;
    branch?: string;
    /** When defined, replaces the full set of agent bindings. Pass [] to detach all. */
    agentIds?: string[];
    dockerImage?: string;
    composePath?: string;
    /**
     * Set to a string to pick a pipeline from a multi-pipeline kaiad.yaml.
     * Set to null to clear (revert to single-pipeline default).
     */
    pipelineName?: string | null;
    fixExecutor?: "claude" | "cursor";
    /** null clears the probe; an object replaces it whole. */
    healthcheck?: Healthcheck | null;
    /** null clears every securityContext column; an object replaces it whole. */
    securityContext?: PodSecurityContext | null;
    /** Toggles the poller's auto-build behaviour for this service. */
    locked?: boolean;
  }) =>
    apiFetch<MonitoredService>(`/api/v1/services/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  // --- Many-to-many agent ↔ service binding helpers ---

  listServicesForAgent: (agentId: string) =>
    apiFetch<{ services: MonitoredService[] }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/services`
    ),

  listRunningServicesForAgent: (agentId: string) =>
    apiFetch<{
      running: Array<{
        serviceId: string;
        environment: string;
        namespace: string;
        imageRef: string | null;
        buildId: string | null;
        observedAt: string;
        externalIp: string | null;
        externalHostname: string | null;
      }>;
    }>(`/api/v1/agents/${encodeURIComponent(agentId)}/running-services`),

  attachServiceToAgent: (agentId: string, serviceId: string) =>
    apiFetch<{ bound: boolean; agentId: string; serviceId: string }>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/services/${encodeURIComponent(serviceId)}`,
      { method: "POST" }
    ),

  detachServiceFromAgent: (agentId: string, serviceId: string) =>
    apiFetch<void>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/services/${encodeURIComponent(serviceId)}`,
      { method: "DELETE" }
    ),

  deleteService: (id: string) =>
    apiFetch<void>(`/api/v1/services/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  listLoadBalancers: () =>
    apiFetch<{ entries: LoadBalancerEntry[] }>("/api/v1/load-balancers"),

  /**
   * Asks the service's bound k8s agent (or any tenant k8s agent) to
   * enumerate IPs in a MetalLB IPAddressPool, split into available vs
   * taken. Powers the Pinned IP(s) multi-select on the service editor.
   */
  listMetalLBPoolIPs: (serviceId: string, pool: string) =>
    apiFetch<{
      agentId: string;
      pool: string;
      available: string[];
      taken: Array<{ ip: string; service?: string; namespace?: string }>;
      ranges: string[];
    }>(
      `/api/v1/services/${encodeURIComponent(serviceId)}/metallb-pool-ips?pool=${encodeURIComponent(pool)}`
    ),

  // --- Service builds ---

  listServiceBuilds: (serviceId: string) =>
    apiFetch<{ builds: ServiceBuild[] }>(
      `/api/v1/services/${encodeURIComponent(serviceId)}/builds`
    ),

  /** Manually queue a build for the service. Worker resolves HEAD on claim. */
  triggerServiceBuild: (serviceId: string) =>
    apiFetch<{ build: ServiceBuild }>(
      `/api/v1/services/${encodeURIComponent(serviceId)}/builds`,
      { method: "POST" }
    ),

  getServiceBuild: (serviceId: string, buildId: string) =>
    apiFetch<{ build: ServiceBuild; artifacts: ServiceBuildArtifact[] }>(
      `/api/v1/services/${encodeURIComponent(serviceId)}/builds/${encodeURIComponent(buildId)}`
    ),

  /** Panel-stored kaiad.yaml override (null = use the repo file). */
  getPipelineOverride: (serviceId: string) =>
    apiFetch<{
      scope: "repo" | "service";
      serviceOverride: string | null;
      repoOverride: string | null;
      repoYaml: string | null;
      pipelineName: string | null;
      gitRepoUrl: string;
      branch: string;
      repoServices: { id: string; name: string; pipelineName: string | null; hasServiceOverride: boolean }[];
    }>(`/api/v1/services/${encodeURIComponent(serviceId)}/pipeline-override`),
  savePipelineOverride: (serviceId: string, yaml: string, scope: "repo" | "service") =>
    apiFetch<{ ok: true; scope: "repo" | "service"; affectedServices: { id: string; name: string }[] }>(
      `/api/v1/services/${encodeURIComponent(serviceId)}/pipeline-override`,
      { method: "PUT", body: JSON.stringify({ yaml, scope }) }
    ),
  clearPipelineOverride: (serviceId: string, scope: "repo" | "service" | "all" = "all") =>
    apiFetch<{ ok: true; scope: string }>(
      `/api/v1/services/${encodeURIComponent(serviceId)}/pipeline-override?scope=${scope}`,
      { method: "DELETE" }
    ),

  /** Deploy a specific build (version) of a service to ALL its bound agents. */
  deployServiceVersion: (serviceId: string, buildId: string) =>
    apiFetch<DeployResult & { boundAgents: number }>(
      `/api/v1/services/${encodeURIComponent(serviceId)}/deploy`,
      { method: "POST", body: JSON.stringify({ buildId }) }
    ),

  /** Deploy a specific build (version) of a bound service to ONE agent. */
  deployToAgent: (agentId: string, serviceId: string, buildId: string) =>
    apiFetch<DeployResult>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/deploy`,
      { method: "POST", body: JSON.stringify({ serviceId, buildId }) }
    ),

  /** Fully-qualified URL for downloading an artifact (Authorization header is on the API path). */
  serviceBuildArtifactUrl: (serviceId: string, buildId: string, name: string): string => {
    return `${API_BASE}/api/v1/services/${encodeURIComponent(serviceId)}/builds/${encodeURIComponent(
      buildId
    )}/artifacts/${encodeURIComponent(name)}`;
  },

  // --- Registry management (panel-only; admin-gated) ---

  listRegistryRepositories: () =>
    apiFetch<{ repositories: RegistryRepository[] }>("/api/v1/registry/repositories"),

  listRegistryTags: (name: string) =>
    apiFetch<{ name: string; tags: RegistryTag[] }>(
      `/api/v1/registry/repositories/${encodeURIComponent(name)}/tags`
    ),

  deleteRegistryTag: (name: string, tag: string) =>
    apiFetch<{ deleted: boolean; digest?: string }>(
      `/api/v1/registry/repositories/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}`,
      { method: "DELETE" }
    ),

  setRegistryVisibility: (name: string, isPublic: boolean) =>
    apiFetch<{ name: string; public: boolean }>(
      `/api/v1/registry/repositories/${encodeURIComponent(name)}/visibility`,
      { method: "PUT", body: JSON.stringify({ public: isPublic }) }
    ),

  /**
   * List every file in an image tag. Returns `manifestKind: "index"`
   * for multi-arch manifest lists (the panel then asks the user to
   * pick a platform); otherwise an `image` payload with a flat,
   * already-sorted file list.
   */
  listRegistryImageFiles: (name: string, tag: string) =>
    apiFetch<RegistryImageFilesResponse>(
      `/api/v1/registry/repositories/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}/files`
    ),

  /**
   * Read one file from a tagged image. `layerIdx` is the index
   * returned by `listRegistryImageFiles` and lets the server jump
   * straight to the owning layer.
   */
  getRegistryImageFile: (
    name: string,
    tag: string,
    path: string,
    layerIdx?: number
  ) => {
    const q = new URLSearchParams({ path });
    if (typeof layerIdx === "number") q.set("layer", String(layerIdx));
    return apiFetch<RegistryImageFileResponse>(
      `/api/v1/registry/repositories/${encodeURIComponent(name)}/tags/${encodeURIComponent(tag)}/file?${q.toString()}`
    );
  },

  getSettings: () => getTenantSettings(),
  updateSettings: (data: TenantSettings) =>
    apiFetch<TenantSettings>("/api/v1/settings", {
      method: "POST",
      body: JSON.stringify(data)
    }),
  listEnrollmentTokens: (opts: { includeInactive?: boolean } = {}) =>
    apiFetch<{
      tokens: {
        id: string;
        tenantId: string;
        expiresAt: string;
        createdBy: string;
        createdAt: string;
        usedAt: string | null;
        revokedAt: string | null;
        isActive: boolean;
      }[];
    }>(
      `/api/v1/agents/enrollment-tokens${opts.includeInactive ? "?includeInactive=true" : ""}`
    ),

  createEnrollmentToken: (data: { ttlSeconds: number }) =>
    apiFetch<{
      id: string;
      tenantId: string;
      token: string;
      expiresAt: string;
      createdBy: string;
      createdAt: string;
      usedAt: string | null;
      revokedAt: string | null;
      isActive: boolean;
    }>("/api/v1/agents/enrollment-tokens", {
      method: "POST",
      body: JSON.stringify(data)
    }),
  deactivateEnrollmentToken: (tokenId: string) =>
    apiFetch<void>(`/api/v1/agents/enrollment-tokens/${encodeURIComponent(tokenId)}/deactivate`, {
      method: "POST"
    }),
  deleteEnrollmentToken: (tokenId: string) =>
    apiFetch<void>(`/api/v1/agents/enrollment-tokens/${encodeURIComponent(tokenId)}`, {
      method: "DELETE"
    }),
  /** API credentials — long-lived bearer tokens (admin only). */
  listApiCredentials: () =>
    apiFetch<{ credentials: ApiCredential[] }>("/api/v1/admin/api-credentials"),
  createApiCredential: (data: { name: string; scopes: ApiCredentialScope[] }) =>
    apiFetch<ApiCredential & { token: string }>("/api/v1/admin/api-credentials", {
      method: "POST",
      body: JSON.stringify(data)
    }),
  deleteApiCredential: (id: string) =>
    apiFetch<void>(`/api/v1/admin/api-credentials/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),

  listGithubInstallations: () =>
    apiFetch<{ installations: { installationId: number; accountLogin: string; repos?: string[] }[] }>(
      "/api/v1/github/installations"
    ).catch(() => ({ installations: [] })),

  syncGithubInstallation: (installationId: number) =>
    apiFetch<{ installationId: number; accountLogin: string; appId: number }>(
      "/api/v1/github/installations/sync",
      {
        method: "POST",
        body: JSON.stringify({ installationId })
      }
    ),

  /** Repositories visible to this tenant's linked GitHub App installation (GitHub REST). */
  listGithubInstallationRepos: () =>
    apiFetch<{ repos: string[] }>("/api/v1/github/installation-repositories"),

  getRegistryRetention: () =>
    apiFetch<RegistryRetentionResponse>("/api/v1/admin/registry-retention"),
  updateRegistryRetention: (patch: Partial<Pick<RegistryRetentionPolicy, "keepLastNPerRepo" | "maxTotalBytes" | "keepForDays">>) =>
    apiFetch<RegistryRetentionResponse>("/api/v1/admin/registry-retention", {
      method: "PUT",
      body: JSON.stringify(patch)
    }),
  runRegistryRetention: () =>
    apiFetch<RegistryGcStats>("/api/v1/admin/registry-retention/run", { method: "POST" }),

  getAuthProviders: () => apiFetch<{ providers: AuthProviderEntry[] }>("/api/v1/auth/providers"),

  createOAuthProvider: (payload: OAuthProviderConfigPayload) =>
    apiFetch<{ ok: boolean }>("/api/v1/settings/oauth-providers", {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  getGithubAppSettings: () =>
    apiFetch<{
      appId: string | null;
      appSlug: string | null;
      /** Ready-to-open GitHub install URL when the server could resolve the app slug. */
      installUrl: string | null;
      privateKeyConfigured: boolean;
      webhookSecretConfigured: boolean;
    }>("/api/v1/settings/github-app"),

  updateGithubAppSettings: (payload: {
    githubAppId: string;
    githubAppSlug?: string;
    githubAppPrivateKeyPem?: string;
    githubWebhookSecret?: string;
  }) =>
    apiFetch<{ ok: boolean }>("/api/v1/settings/github-app", {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  getOAuthAuthorizeUrl: (providerId: string) =>
    apiFetch<{ authorizeUrl: string }>(`/api/v1/auth/oauth/authorize?provider=${encodeURIComponent(providerId)}`),

  handleOAuthCallback: (code: string, state: string) =>
    apiFetch<{ token: string }>(`/api/v1/auth/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`),

  getSetupStatus: () =>
    apiFetch<{ setupRequired: boolean; version: string }>("/api/v1/setup/status"),

  testDatabase: (databaseUrl: string) =>
    apiFetch<{ ok: boolean }>("/api/v1/setup/test-database", {
      method: "POST",
      body: JSON.stringify({ databaseUrl }),
    }),

  testRedis: (redisUrl: string) =>
    apiFetch<{ ok: boolean }>("/api/v1/setup/test-redis", {
      method: "POST",
      body: JSON.stringify({ redisUrl }),
    }),

  getSetupTenants: (databaseUrl: string) =>
    apiFetch<{ tenants: { id: string; name: string }[] }>(
      `/api/v1/setup/tenants?databaseUrl=${encodeURIComponent(databaseUrl)}`
    ),

  completeSetup: (data: {
    databaseUrl: string;
    redisUrl: string;
    publicBaseUrl?: string;
    adminEmail: string;
    adminPassword: string;
    githubAppId?: string;
    githubAppPrivateKeyPem?: string;
    githubWebhookSecret?: string;
    googleClientId?: string;
    googleClientSecret?: string;
    defaultWebhookTenantId?: string;
    kubernetesNamespace?: string;
  }) =>
    apiFetch<{ ok: boolean; tenantId: string; adminEmail: string }>("/api/v1/setup/complete", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // --- Users, groups & permissions ---
  listPermissions: () => apiFetch<{ permissions: string[] }>("/api/v1/permissions"),
  listGroups: () =>
    apiFetch<{ groups: PermissionGroup[] }>("/api/v1/groups"),
  createGroup: (body: { name: string; description?: string; permissions: string[] }) =>
    apiFetch<PermissionGroup>("/api/v1/groups", { method: "POST", body: JSON.stringify(body) }),
  updateGroup: (id: string, body: { name?: string; description?: string; permissions?: string[] }) =>
    apiFetch<PermissionGroup>(`/api/v1/groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  deleteGroup: (id: string) =>
    apiFetch<{ ok: true }>(`/api/v1/groups/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listUsers: () => apiFetch<{ users: TenantMember[] }>("/api/v1/users"),
  addUser: (email: string, role: string) =>
    apiFetch<{ ok: true; userId: string }>("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({ email, role })
    }),
  updateUser: (userId: string, body: { role?: string; groupIds?: string[] }) =>
    apiFetch<{ ok: true }>(`/api/v1/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  removeUser: (userId: string) =>
    apiFetch<void>(`/api/v1/users/${encodeURIComponent(userId)}`, { method: "DELETE" }),
};

export type PermissionGroup = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
};
export type TenantMember = {
  userId: string;
  email: string;
  role: string;
  groups: { id: string; name: string; builtin: boolean }[];
};
