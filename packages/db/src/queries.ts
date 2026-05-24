import crypto from "node:crypto";

export type QueryFn = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface SshKeyRow {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  privateKeyEncrypted?: string | null;
  localPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSshKey(r: Record<string, unknown>): SshKeyRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    type: r.type as string,
    privateKeyEncrypted: r.private_key_encrypted == null ? null : String(r.private_key_encrypted),
    localPath: r.local_path == null ? null : String(r.local_path),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
    updatedAt:
      r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : String(r.updated_at),
  };
}

export async function listSshKeys(
  query: QueryFn,
  tenantId: string,
): Promise<SshKeyRow[]> {
  const { rows } = await query(
    `SELECT * FROM ssh_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map(mapSshKey);
}

export async function getSshKey(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<SshKeyRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM ssh_keys WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows.length > 0 ? mapSshKey(rows[0]) : undefined;
}

export async function createSshKey(
  query: QueryFn,
  tenantId: string,
  data: {
    name: string;
    type: string;
    privateKeyEncrypted?: string | null;
    localPath?: string | null;
  },
): Promise<SshKeyRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO ssh_keys (id, tenant_id, name, type, private_key_encrypted, local_path)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, tenantId, data.name, data.type, data.privateKeyEncrypted ?? null, data.localPath ?? null],
  );
  return mapSshKey(rows[0]);
}

export async function deleteSshKey(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM ssh_keys WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, id],
  );
  return rows.length > 0;
}

// --- component_logs: kaiad agent / operator self-logs ---

export type ComponentLogSource = "agent" | "operator";

export interface ComponentLogRow {
  /** bigint identity, serialized as a string for JSON safety. */
  id: string;
  source: ComponentLogSource;
  sourceId: string;
  level: string;
  message: string;
  ts: string;
}

export interface ComponentLogInput {
  source: ComponentLogSource;
  sourceId: string;
  level: string;
  message: string;
  ts: string;
}

function mapComponentLog(r: Record<string, unknown>): ComponentLogRow {
  return {
    id: String(r.id),
    source: r.source as ComponentLogSource,
    sourceId: r.source_id as string,
    level: r.level as string,
    message: r.message as string,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
  };
}

/** Bulk-inserts agent/operator self-log lines for one tenant. */
export async function appendComponentLogs(
  query: QueryFn,
  tenantId: string,
  entries: ComponentLogInput[],
): Promise<void> {
  if (entries.length === 0) return;
  const tuples: string[] = [];
  const params: unknown[] = [tenantId];
  for (const e of entries) {
    const b = params.length;
    tuples.push(`($1, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`);
    params.push(e.source, e.sourceId, e.level, e.message, e.ts);
  }
  await query(
    `INSERT INTO component_logs (tenant_id, source, source_id, level, message, ts)
     VALUES ${tuples.join(", ")}`,
    params,
  );
}

/**
 * Returns component log lines in ascending id order. With `afterId` it
 * returns only newer lines (incremental UI polling); without it, the
 * most recent `limit` lines (initial load).
 */
export async function listComponentLogs(
  query: QueryFn,
  tenantId: string,
  filter: { source: ComponentLogSource; sourceId: string },
  opts: { limit: number; afterId?: string },
): Promise<ComponentLogRow[]> {
  if (opts.afterId) {
    const { rows } = await query(
      `SELECT id, source, source_id, level, message, ts FROM component_logs
       WHERE tenant_id = $1 AND source = $2 AND source_id = $3 AND id > $4
       ORDER BY id ASC LIMIT $5`,
      [tenantId, filter.source, filter.sourceId, opts.afterId, opts.limit],
    );
    return rows.map(mapComponentLog);
  }
  const { rows } = await query(
    `SELECT id, source, source_id, level, message, ts FROM (
       SELECT id, source, source_id, level, message, ts FROM component_logs
       WHERE tenant_id = $1 AND source = $2 AND source_id = $3
       ORDER BY id DESC LIMIT $4
     ) recent ORDER BY id ASC`,
    [tenantId, filter.source, filter.sourceId, opts.limit],
  );
  return rows.map(mapComponentLog);
}

/** Retention: drops component log lines created before `cutoff`. */
export async function pruneComponentLogs(query: QueryFn, cutoff: Date): Promise<void> {
  await query(`DELETE FROM component_logs WHERE created_at < $1`, [cutoff.toISOString()]);
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export interface IncidentRow {
  id: string;
  tenantId: string;
  serviceId: string;
  fingerprint: string;
  message?: string;
  fullLog?: string;
  status: string;
  eventCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastFixStatus?: string;
  lastFixExecutor?: string;
  lastFixStartedAt?: string;
  lastFixFinishedAt?: string;
  lastFixCommitSha?: string;
  lastFixOutput?: string;
  /** Step events of the latest fix attempt (oldest first). Each event
   *  can carry the exact `cmd` that was executed plus its truncated
   *  `output` and exit `code` so the Incidents UI can show "what was
   *  run" alongside the step name. */
  lastFixEvents: {
    at: string;
    step: string;
    ok?: boolean;
    message?: string;
    cmd?: string;
    output?: string;
    code?: number;
  }[];
}

function mapIncident(r: Record<string, unknown>): IncidentRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    serviceId: r.service_id as string,
    fingerprint: r.fingerprint as string,
    message: r.message as string | undefined,
    fullLog: (r.full_log as string | null) ?? undefined,
    status: r.status as string,
    eventCount: Number(r.event_count ?? 1),
    firstSeenAt:
      r.first_seen_at instanceof Date
        ? r.first_seen_at.toISOString()
        : String(r.first_seen_at),
    lastSeenAt:
      r.last_seen_at instanceof Date
        ? r.last_seen_at.toISOString()
        : String(r.last_seen_at),
    lastFixStatus: (r.last_fix_status as string | null) ?? undefined,
    lastFixExecutor: (r.last_fix_executor as string | null) ?? undefined,
    lastFixStartedAt:
      r.last_fix_started_at instanceof Date
        ? r.last_fix_started_at.toISOString()
        : (r.last_fix_started_at as string | null) ?? undefined,
    lastFixFinishedAt:
      r.last_fix_finished_at instanceof Date
        ? r.last_fix_finished_at.toISOString()
        : (r.last_fix_finished_at as string | null) ?? undefined,
    lastFixCommitSha: (r.last_fix_commit_sha as string | null) ?? undefined,
    lastFixOutput: (r.last_fix_output as string | null) ?? undefined,
    lastFixEvents: Array.isArray(r.last_fix_events)
      ? (r.last_fix_events as {
          at: string;
          step: string;
          ok?: boolean;
          message?: string;
          cmd?: string;
          output?: string;
          code?: number;
        }[])
      : [],
  };
}

export async function listIncidents(
  query: QueryFn,
  tenantId: string,
): Promise<IncidentRow[]> {
  const { rows } = await query(
    `SELECT * FROM incidents WHERE tenant_id = $1 ORDER BY last_seen_at DESC`,
    [tenantId],
  );
  return rows.map(mapIncident);
}

export async function getIncident(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<IncidentRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM incidents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows.length > 0 ? mapIncident(rows[0]) : undefined;
}

export async function upsertIncident(
  query: QueryFn,
  tenantId: string,
  data: { serviceId: string; fingerprint: string; message?: string; fullLog?: string },
): Promise<IncidentRow> {
  const { rows: existing } = await query(
    `SELECT * FROM incidents
     WHERE tenant_id = $1 AND service_id = $2 AND fingerprint = $3
       AND status IN ('open', 'acknowledged')
     LIMIT 1`,
    [tenantId, data.serviceId, data.fingerprint],
  );

  if (existing.length > 0) {
    // Refresh message + full_log so the incident always reflects the
    // latest (richest) capture of the recurring error.
    const { rows } = await query(
      `UPDATE incidents
       SET event_count = event_count + 1, last_seen_at = now(),
           message = COALESCE($3, message),
           full_log = COALESCE($4, full_log)
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [existing[0].id, tenantId, data.message ?? null, data.fullLog ?? null],
    );
    return mapIncident(rows[0]);
  }

  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO incidents (id, tenant_id, service_id, fingerprint, message, full_log, status, event_count, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', 1, now(), now())
     RETURNING *`,
    [id, tenantId, data.serviceId, data.fingerprint, data.message ?? null, data.fullLog ?? null],
  );
  return mapIncident(rows[0]);
}

/** Record one step of an in-kaiad fix attempt on the matching incident.
 *  Patch fields are partial: any provided field is overwritten; an
 *  `event` is appended to last_fix_events. `resetEvents` clears the
 *  array first (used when starting a fresh attempt). Matches on the
 *  most recent open/acknowledged incident for (tenant, service,
 *  fingerprint). Idempotent if no incident matches. */
export async function recordFixProgress(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  fingerprint: string,
  patch: {
    /** Pin to a specific incident id (chosen at fix-start). Without
     *  this, mid-run patches landed on whichever incident was most-recent
     *  AT EACH CALL — so events split across rows when a fresh error
     *  arrived during the fix. Always pass this for new code. */
    incidentId?: string;
    status?: string;
    executor?: string;
    startedAt?: string;
    finishedAt?: string;
    commitSha?: string | null;
    output?: string | null;
    event?: { step: string; ok?: boolean; message?: string; cmd?: string; output?: string; code?: number };
    resetEvents?: boolean;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [tenantId, serviceId, fingerprint];
  const push = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (patch.status !== undefined) push("last_fix_status", patch.status);
  if (patch.executor !== undefined) push("last_fix_executor", patch.executor);
  if (patch.startedAt !== undefined) push("last_fix_started_at", patch.startedAt);
  if (patch.finishedAt !== undefined) push("last_fix_finished_at", patch.finishedAt);
  if (patch.commitSha !== undefined) push("last_fix_commit_sha", patch.commitSha);
  if (patch.output !== undefined) push("last_fix_output", patch.output);

  // Events: optionally reset first, then append the new event.
  if (patch.resetEvents) sets.push(`last_fix_events = '[]'::jsonb`);
  if (patch.event) {
    const ev = { at: new Date().toISOString(), ...patch.event };
    values.push(JSON.stringify(ev));
    sets.push(`last_fix_events = COALESCE(last_fix_events, '[]'::jsonb) || $${values.length}::jsonb`);
  }
  if (sets.length === 0) return;
  if (patch.incidentId) {
    // Pinned-id path: every call from one fix-run targets the same row.
    values.push(patch.incidentId);
    await query(
      `UPDATE incidents SET ${sets.join(", ")}
         WHERE id = $${values.length}
           AND tenant_id = $1 AND service_id = $2 AND fingerprint = $3`,
      values,
    );
    return;
  }
  // Legacy fallback: update the most recent incident for this
  // (tenant, service, fingerprint) regardless of status. Kept for
  // back-compat; callers should pass `incidentId` whenever possible.
  await query(
    `UPDATE incidents SET ${sets.join(", ")}
       WHERE id = (
         SELECT id FROM incidents
         WHERE tenant_id = $1 AND service_id = $2 AND fingerprint = $3
         ORDER BY last_seen_at DESC LIMIT 1
       )`,
    values,
  );
}

/** Resolve the most-recent incident id for (tenant, service, fingerprint).
 *  Called at fix-start to pin every subsequent recordFixProgress call to
 *  the same row, so events from one fix run can't split across siblings
 *  if the agent ships a fresh error mid-run. */
export async function getCurrentIncidentId(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  fingerprint: string,
): Promise<string | null> {
  const { rows } = await query(
    `SELECT id FROM incidents
       WHERE tenant_id = $1 AND service_id = $2 AND fingerprint = $3
       ORDER BY last_seen_at DESC LIMIT 1`,
    [tenantId, serviceId, fingerprint],
  );
  return rows.length > 0 ? String(rows[0].id) : null;
}

/** Mark any in-kaiad fix that has been "running"/cloning/cli/committing/
 *  pushing for longer than `olderThanMs` as failed (the runner is gone
 *  — container restart, crash, hung child). Appends a synthetic event
 *  so the UI shows why and frees the timeline for a fresh attempt.
 *  Returns the number of incidents reaped. */
export async function reapStuckFixAttempts(
  query: QueryFn,
  olderThanMs: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const event = {
    at: new Date().toISOString(),
    step: "failed",
    ok: false,
    message: `fix attempt timed out after ${Math.round(olderThanMs / 60000)} min — runner went away`
  };
  const { rows } = await query(
    `UPDATE incidents
        SET last_fix_status = 'failed',
            last_fix_finished_at = now(),
            last_fix_events = COALESCE(last_fix_events, '[]'::jsonb) || $2::jsonb
      WHERE last_fix_status IN ('running','cloning','cli','committing','pushing')
        AND last_fix_started_at IS NOT NULL
        AND last_fix_started_at < $1::timestamptz
      RETURNING id`,
    [cutoff, JSON.stringify(event)],
  );
  return rows.length;
}

/** Resolve any open/acknowledged incident for this service+fingerprint
 *  (called when an autonomous fix lands). Returns the count closed. */
export async function resolveIncidentByFingerprint(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  fingerprint: string,
): Promise<number> {
  const { rows } = await query(
    `UPDATE incidents SET status = 'resolved', last_seen_at = now()
     WHERE tenant_id = $1 AND service_id = $2 AND fingerprint = $3
       AND status IN ('open', 'acknowledged')
     RETURNING id`,
    [tenantId, serviceId, fingerprint],
  );
  return rows.length;
}

/** Auto-resolve incidents whose error hasn't been seen since `cutoff`
 *  (the service is presumed healthy again). Returns the count closed. */
export async function resolveStaleIncidents(
  query: QueryFn,
  cutoff: Date,
): Promise<number> {
  const { rows } = await query(
    `UPDATE incidents SET status = 'resolved'
     WHERE status IN ('open', 'acknowledged') AND last_seen_at < $1
     RETURNING id`,
    [cutoff.toISOString()],
  );
  return rows.length;
}

/** Hard-delete an incident (operator-initiated cleanup). Returns true
 *  when a row was removed. Tenant-scoped to prevent cross-tenant writes. */
export async function deleteIncident(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM incidents WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, id],
  );
  return rows.length > 0;
}

export async function updateIncidentStatus(
  query: QueryFn,
  tenantId: string,
  id: string,
  status: string,
): Promise<IncidentRow | undefined> {
  const { rows } = await query(
    `UPDATE incidents SET status = $1 WHERE tenant_id = $2 AND id = $3 RETURNING *`,
    [status, tenantId, id],
  );
  return rows.length > 0 ? mapIncident(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  tenantId: string;
  name: string | null;
  version: string | null;
  status: string;
  lastSeenAt: string | null;
  certFingerprint?: string | null;
  allowedCapabilities?: string[];
  /** Deployment environment this agent serves (e.g. 'development', 'production'). */
  environment: string;
  /**
   * Runtime backend the agent reports it has configured itself for
   * ("docker" | "kubernetes" | "shell"). Null until the first
   * runtime-aware heartbeat arrives, so the UI can show "unknown"
   * for legacy agents that haven't been upgraded.
   */
  runtimeBackend: string | null;
}

function mapAgent(r: Record<string, unknown>): AgentRow {
  const caps = r.allowed_capabilities;
  const allowedCapabilities = Array.isArray(caps)
    ? (caps as string[])
    : undefined;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name == null ? null : String(r.name),
    version: r.version == null ? null : String(r.version),
    status: r.status as string,
    lastSeenAt:
      r.last_seen_at == null
        ? null
        : r.last_seen_at instanceof Date
          ? r.last_seen_at.toISOString()
          : String(r.last_seen_at),
    certFingerprint:
      r.cert_fingerprint == null ? null : String(r.cert_fingerprint),
    allowedCapabilities,
    environment: String(r.environment ?? "development"),
    runtimeBackend: r.runtime_backend == null ? null : String(r.runtime_backend),
  };
}

export async function listAgents(
  query: QueryFn,
  tenantId: string,
): Promise<AgentRow[]> {
  const { rows } = await query(
    `SELECT * FROM agents WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.map(mapAgent);
}

export async function getAgent(
  query: QueryFn,
  tenantId: string,
  id: string,
): Promise<AgentRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM agents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows.length > 0 ? mapAgent(rows[0]) : undefined;
}

/** Creates or updates a row when an agent sends realtime telemetry for this tenant. */
export async function recordAgentHeartbeat(
  query: QueryFn,
  tenantId: string,
  data: { agentId: string; version: string | null; runtimeBackend?: string | null },
): Promise<void> {
  await query(
    `INSERT INTO agents (id, tenant_id, name, version, status, last_seen_at, cert_fingerprint, allowed_capabilities, runtime_backend)
     VALUES ($1, $2, NULL, $3, 'online', NOW(), NULL, ARRAY[]::text[], $4)
     ON CONFLICT (id) DO UPDATE SET
       version = COALESCE(EXCLUDED.version, agents.version),
       last_seen_at = NOW(),
       status = 'online',
       runtime_backend = COALESCE(EXCLUDED.runtime_backend, agents.runtime_backend)
     WHERE agents.tenant_id = EXCLUDED.tenant_id`,
    [data.agentId, tenantId, data.version, data.runtimeBackend ?? null],
  );
}

export async function markAgentOffline(query: QueryFn, tenantId: string, agentId: string): Promise<void> {
  await query(
    `UPDATE agents SET status = 'offline' WHERE id = $1 AND tenant_id = $2`,
    [agentId, tenantId],
  );
}

export async function updateAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  data: { name?: string | null; allowedCapabilities?: string[]; environment?: string }
): Promise<AgentRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [agentId, tenantId];
  if (data.name !== undefined) {
    params.push(data.name);
    sets.push(`name = $${params.length}`);
  }
  if (data.allowedCapabilities !== undefined) {
    params.push(data.allowedCapabilities);
    sets.push(`allowed_capabilities = $${params.length}`);
  }
  if (data.environment !== undefined) {
    params.push(data.environment);
    sets.push(`environment = $${params.length}`);
  }
  if (sets.length === 0) {
    const { rows } = await query(
      `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId]
    );
    return rows.length > 0 ? mapAgent(rows[0]) : undefined;
  }
  const { rows } = await query(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params
  );
  return rows.length > 0 ? mapAgent(rows[0]) : undefined;
}

export async function deleteAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM agents WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [agentId, tenantId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Monitored Services
// ---------------------------------------------------------------------------

export interface HealthcheckSpec {
  path: string;
  port: number;
  initialDelaySeconds: number;
  periodSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
}

export interface ServiceRow {
  id: string;
  tenantId: string;
  name: string;
  gitRepoUrl: string;
  sshKeyId: string | null;
  branch: string;
  dockerImage?: string | null;
  composePath?: string | null;
  pipelineName?: string | null;
  /** Panel-stored kaiad.yaml override; null = use the repo file. */
  pipelineOverride?: string | null;
  /** AI CLI for autonomous fixes. */
  fixExecutor: "claude" | "cursor";
  /**
   * HTTP readiness check (resolved from kaiad.yaml or the panel form).
   * Null when neither path nor port is set — the agent then renders no
   * probe, but still uses the stricter RollingUpdate strategy.
   */
  healthcheck: HealthcheckSpec | null;
}

// Healthcheck defaults — kept in sync with the zod defaults on
// healthcheckSchema in packages/contracts/src/http.ts. The DB stores
// each value as its own nullable int; missing → fall back to default.
const HEALTHCHECK_DEFAULTS: Omit<HealthcheckSpec, "path" | "port"> = {
  initialDelaySeconds: 0,
  periodSeconds: 10,
  timeoutSeconds: 3,
  failureThreshold: 3,
  successThreshold: 1
};

function mapHealthcheck(r: Record<string, unknown>): HealthcheckSpec | null {
  // The healthcheck is meaningful only when BOTH the http path and port
  // are set; everything else has a sensible default.
  if (r.healthcheck_path == null || r.healthcheck_port == null) return null;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" ? v : v == null ? fallback : Number(v);
  return {
    path: String(r.healthcheck_path),
    port: Number(r.healthcheck_port),
    initialDelaySeconds: num(r.healthcheck_initial_delay_seconds, HEALTHCHECK_DEFAULTS.initialDelaySeconds),
    periodSeconds: num(r.healthcheck_period_seconds, HEALTHCHECK_DEFAULTS.periodSeconds),
    timeoutSeconds: num(r.healthcheck_timeout_seconds, HEALTHCHECK_DEFAULTS.timeoutSeconds),
    failureThreshold: num(r.healthcheck_failure_threshold, HEALTHCHECK_DEFAULTS.failureThreshold),
    successThreshold: num(r.healthcheck_success_threshold, HEALTHCHECK_DEFAULTS.successThreshold)
  };
}

function mapService(r: Record<string, unknown>): ServiceRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    gitRepoUrl: r.git_repo_url as string,
    sshKeyId: (r.ssh_key_id as string) ?? null,
    branch: r.branch as string,
    dockerImage: r.docker_image == null ? null : String(r.docker_image),
    composePath: r.compose_path == null ? null : String(r.compose_path),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name),
    pipelineOverride: r.pipeline_override == null ? null : String(r.pipeline_override),
    fixExecutor: r.fix_executor === "cursor" ? "cursor" : "claude",
    healthcheck: mapHealthcheck(r)
  };
}

/**
 * Read just the healthcheck (or null) for a service. Used by every
 * redeploy_service dispatch site to attach the resolved probe to the
 * realtime message — without this the wire schema's `healthcheck:
 * null` default strips the probe.
 */
export async function getServiceHealthcheck(
  query: QueryFn,
  serviceId: string
): Promise<HealthcheckSpec | null> {
  const { rows } = await query(
    `SELECT healthcheck_path, healthcheck_port,
            healthcheck_initial_delay_seconds, healthcheck_period_seconds,
            healthcheck_timeout_seconds, healthcheck_failure_threshold,
            healthcheck_success_threshold
       FROM monitored_services
      WHERE id = $1`,
    [serviceId]
  );
  if (rows.length === 0) return null;
  return mapHealthcheck(rows[0]);
}

/** Read just the pipeline override (or null) for a service. */
export async function getServicePipelineOverride(
  query: QueryFn,
  tenantId: string,
  id: string
): Promise<string | null | undefined> {
  const { rows } = await query(
    `SELECT pipeline_override FROM monitored_services WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  if (rows.length === 0) return undefined; // service not found
  return rows[0].pipeline_override == null ? null : String(rows[0].pipeline_override);
}

/** Set (string) or clear (null) the per-service explicit override. Returns false if no such service. */
export async function setServicePipelineOverride(
  query: QueryFn,
  tenantId: string,
  id: string,
  override: string | null
): Promise<boolean> {
  const { rows } = await query(
    `UPDATE monitored_services SET pipeline_override = $3 WHERE tenant_id = $1 AND id = $2 RETURNING id`,
    [tenantId, id, override]
  );
  return rows.length > 0;
}

/** Repo-scoped override (default scope): shared by every service built from this git_repo_url+branch. */
export async function getRepoPipelineOverride(
  query: QueryFn,
  tenantId: string,
  gitRepoUrl: string,
  branch: string
): Promise<string | null> {
  const { rows } = await query(
    `SELECT pipeline_override FROM repo_pipeline_overrides
      WHERE tenant_id = $1 AND git_repo_url = $2 AND branch = $3`,
    [tenantId, gitRepoUrl, branch]
  );
  if (rows.length === 0) return null;
  return rows[0].pipeline_override == null ? null : String(rows[0].pipeline_override);
}

/** Upsert (string) or clear (null) the repo-scoped override. */
export async function setRepoPipelineOverride(
  query: QueryFn,
  tenantId: string,
  gitRepoUrl: string,
  branch: string,
  override: string | null
): Promise<void> {
  if (override == null) {
    await query(
      `DELETE FROM repo_pipeline_overrides WHERE tenant_id = $1 AND git_repo_url = $2 AND branch = $3`,
      [tenantId, gitRepoUrl, branch]
    );
    return;
  }
  await query(
    `INSERT INTO repo_pipeline_overrides (tenant_id, git_repo_url, branch, pipeline_override, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, git_repo_url, branch)
       DO UPDATE SET pipeline_override = EXCLUDED.pipeline_override, updated_at = now()`,
    [tenantId, gitRepoUrl, branch, override]
  );
}

/** Services in this tenant built from the same git_repo_url + branch. */
export async function listServicesForRepo(
  query: QueryFn,
  tenantId: string,
  gitRepoUrl: string,
  branch: string
): Promise<Array<{ id: string; name: string; pipelineName: string | null; hasServiceOverride: boolean }>> {
  const { rows } = await query(
    `SELECT id, name, pipeline_name, pipeline_override
       FROM monitored_services
      WHERE tenant_id = $1 AND git_repo_url = $2 AND branch = $3
      ORDER BY name`,
    [tenantId, gitRepoUrl, branch]
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name),
    hasServiceOverride: r.pipeline_override != null
  }));
}

export async function listServices(
  query: QueryFn,
  tenantId: string,
): Promise<ServiceRow[]> {
  const { rows } = await query(
    `SELECT * FROM monitored_services WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows.map(mapService);
}

export async function getService(
  query: QueryFn,
  tenantId: string,
  id: string
): Promise<ServiceRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM monitored_services WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (rows.length === 0) {
    return undefined;
  }
  return mapService(rows[0]);
}

export async function createService(
  query: QueryFn,
  tenantId: string,
  data: {
    name: string;
    gitRepoUrl: string;
    sshKeyId?: string | null;
    branch: string;
    dockerImage?: string;
    composePath?: string;
    pipelineName?: string | null;
    fixExecutor?: string | null;
    healthcheck?: HealthcheckSpec | null;
  },
): Promise<ServiceRow> {
  const id = crypto.randomUUID();
  const hc = data.healthcheck ?? null;
  const { rows } = await query(
    `INSERT INTO monitored_services (
       id, tenant_id, name, git_repo_url, ssh_key_id, branch,
       docker_image, compose_path, pipeline_name, fix_executor,
       healthcheck_path, healthcheck_port,
       healthcheck_initial_delay_seconds, healthcheck_period_seconds,
       healthcheck_timeout_seconds, healthcheck_failure_threshold,
       healthcheck_success_threshold
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      id,
      tenantId,
      data.name,
      data.gitRepoUrl,
      data.sshKeyId ?? null,
      data.branch,
      data.dockerImage ?? null,
      data.composePath ?? null,
      data.pipelineName ?? null,
      data.fixExecutor ?? "claude",
      hc?.path ?? null,
      hc?.port ?? null,
      hc?.initialDelaySeconds ?? null,
      hc?.periodSeconds ?? null,
      hc?.timeoutSeconds ?? null,
      hc?.failureThreshold ?? null,
      hc?.successThreshold ?? null
    ],
  );
  return mapService(rows[0]);
}

// ---------------------------------------------------------------------------
// agent_services join queries (many-to-many).
// ---------------------------------------------------------------------------

export interface AgentBindingRow {
  agentId: string;
}

export async function attachServiceToAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  serviceId: string
): Promise<boolean> {
  const { rows } = await query(
    `INSERT INTO agent_services (tenant_id, agent_id, service_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, service_id) DO NOTHING
     RETURNING agent_id`,
    [tenantId, agentId, serviceId]
  );
  return rows.length > 0;
}

export async function detachServiceFromAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  serviceId: string
): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM agent_services
      WHERE tenant_id = $1 AND agent_id = $2 AND service_id = $3
     RETURNING agent_id`,
    [tenantId, agentId, serviceId]
  );
  return rows.length > 0;
}

export async function listAgentsForService(
  query: QueryFn,
  tenantId: string,
  serviceId: string
): Promise<AgentBindingRow[]> {
  const { rows } = await query(
    `SELECT agent_id FROM agent_services
      WHERE tenant_id = $1 AND service_id = $2
      ORDER BY created_at`,
    [tenantId, serviceId]
  );
  return rows.map((r) => ({ agentId: r.agent_id as string }));
}

export async function listServicesForAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<ServiceRow[]> {
  const { rows } = await query(
    `SELECT ms.* FROM monitored_services ms
       JOIN agent_services j ON j.service_id = ms.id
      WHERE j.tenant_id = $1 AND j.agent_id = $2
      ORDER BY j.created_at`,
    [tenantId, agentId]
  );
  return rows.map(mapService);
}

/**
 * setAgentBindings replaces the agent set for a service in one tx-friendly
 * pair of statements: delete bindings not in the desired set, then upsert the
 * remainder. Designed for `PATCH /api/v1/services/:id { agentIds }`.
 */
export async function setAgentBindings(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  agentIds: string[]
): Promise<void> {
  // Delete bindings whose agent_id is not in the desired list.
  if (agentIds.length === 0) {
    await query(
      `DELETE FROM agent_services WHERE tenant_id = $1 AND service_id = $2`,
      [tenantId, serviceId]
    );
    return;
  }
  await query(
    `DELETE FROM agent_services
      WHERE tenant_id = $1 AND service_id = $2 AND agent_id <> ALL($3::text[])`,
    [tenantId, serviceId, agentIds]
  );
  for (const agentId of agentIds) {
    await query(
      `INSERT INTO agent_services (tenant_id, agent_id, service_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenantId, agentId, serviceId]
    );
  }
}

export interface ApiCredentialRow {
  id: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function mapApiCredential(r: Record<string, unknown>): ApiCredentialRow {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    tokenHash: r.token_hash as string,
    scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
    createdAt: (r.created_at as Date | string).toString(),
    createdBy: (r.created_by as string | null) ?? null,
    lastUsedAt: r.last_used_at == null ? null : (r.last_used_at as Date | string).toString(),
    revokedAt: r.revoked_at == null ? null : (r.revoked_at as Date | string).toString(),
  };
}

export async function createApiCredential(
  query: QueryFn,
  data: { tenantId: string; name: string; tokenHash: string; scopes: string[]; createdBy?: string | null }
): Promise<ApiCredentialRow> {
  const id = `apicred-${crypto.randomUUID()}`;
  const { rows } = await query(
    `INSERT INTO api_credentials (id, tenant_id, name, token_hash, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, data.tenantId, data.name, data.tokenHash, data.scopes, data.createdBy ?? null]
  );
  return mapApiCredential(rows[0]);
}

export async function listApiCredentials(query: QueryFn, tenantId: string): Promise<ApiCredentialRow[]> {
  const { rows } = await query(
    `SELECT * FROM api_credentials WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows.map(mapApiCredential);
}

export async function findApiCredentialByTokenHash(
  query: QueryFn,
  tokenHash: string
): Promise<ApiCredentialRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM api_credentials WHERE token_hash = $1 LIMIT 1`,
    [tokenHash]
  );
  return rows.length === 0 ? undefined : mapApiCredential(rows[0]);
}

export async function revokeApiCredential(
  query: QueryFn,
  tenantId: string,
  id: string
): Promise<boolean> {
  const { rows } = await query(
    `UPDATE api_credentials SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id`,
    [id, tenantId]
  );
  return rows.length > 0;
}

export async function touchApiCredentialLastUsed(
  query: QueryFn,
  id: string
): Promise<void> {
  await query(`UPDATE api_credentials SET last_used_at = now() WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Build pipeline (service_builds, service_build_artifacts)
// ---------------------------------------------------------------------------

export type BuildStatus = "queued" | "running" | "success" | "failed" | "no_pipeline";
export type BuildTrigger = "poll" | "manual";

export interface ServiceBuildRow {
  id: string;
  tenantId: string;
  serviceId: string;
  /** Empty string for manual builds whose SHA hasn't been resolved yet. */
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
}

export interface ServiceBuildArtifactRow {
  buildId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  relPath: string;
  createdAt: string;
}

function mapBuild(r: Record<string, unknown>): ServiceBuildRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    serviceId: String(r.service_id),
    gitSha: String(r.git_sha ?? ""),
    branch: String(r.branch),
    status: String(r.status) as BuildStatus,
    triggeredBy: (String(r.triggered_by ?? "poll") as BuildTrigger),
    imageRef: r.image_ref == null ? null : String(r.image_ref),
    log: String(r.log ?? ""),
    pipelineYaml: r.pipeline_yaml == null ? null : String(r.pipeline_yaml),
    failureReason: r.failure_reason == null ? null : String(r.failure_reason),
    createdAt: new Date(r.created_at as string).toISOString(),
    startedAt: r.started_at == null ? null : new Date(r.started_at as string).toISOString(),
    finishedAt: r.finished_at == null ? null : new Date(r.finished_at as string).toISOString()
  };
}

function mapArtifact(r: Record<string, unknown>): ServiceBuildArtifactRow {
  return {
    buildId: String(r.build_id),
    name: String(r.name),
    sizeBytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    relPath: String(r.rel_path),
    createdAt: new Date(r.created_at as string).toISOString()
  };
}

/**
 * Insert a queued build for the periodic poller. Caller must already have
 * verified via getLatestBuildSha that this SHA hasn't been polled yet —
 * the DB no longer enforces a unique index on (service_id, git_sha) since
 * manual rebuilds at the same SHA are now legal.
 */
export async function enqueueBuild(
  query: QueryFn,
  data: {
    tenantId: string;
    serviceId: string;
    gitSha: string;
    branch: string;
  }
): Promise<ServiceBuildRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO service_builds (id, tenant_id, service_id, git_sha, branch, status, triggered_by)
     VALUES ($1, $2, $3, $4, $5, 'queued', 'poll')
     RETURNING *`,
    [id, data.tenantId, data.serviceId, data.gitSha, data.branch]
  );
  return mapBuild(rows[0]);
}

/**
 * Insert a queued MANUAL build. The SHA is left empty; the worker
 * resolves HEAD via git ls-remote on claim and writes it back via
 * updateBuildGitSha before running the actual build. Manual builds
 * also dispatch a redeploy_service agent command on success.
 */
export async function enqueueManualBuild(
  query: QueryFn,
  data: {
    tenantId: string;
    serviceId: string;
    branch: string;
  }
): Promise<ServiceBuildRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO service_builds (id, tenant_id, service_id, git_sha, branch, status, triggered_by)
     VALUES ($1, $2, $3, '', $4, 'queued', 'manual')
     RETURNING *`,
    [id, data.tenantId, data.serviceId, data.branch]
  );
  return mapBuild(rows[0]);
}

/** Persist a SHA the worker resolved post-claim for a manual build. */
export async function updateBuildGitSha(
  query: QueryFn,
  buildId: string,
  gitSha: string
): Promise<void> {
  await query(`UPDATE service_builds SET git_sha = $2 WHERE id = $1`, [buildId, gitSha]);
}

/**
 * Atomically claim the next queued build (FIFO by created_at). Sets
 * status='running' and started_at=now() in the same UPDATE so two
 * builders racing for the same row get exactly one winner.
 */
export async function claimNextBuild(query: QueryFn): Promise<ServiceBuildRow | null> {
  const { rows } = await query(
    `UPDATE service_builds
        SET status = 'running', started_at = now()
      WHERE id = (
        SELECT id FROM service_builds
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    []
  );
  return rows.length === 0 ? null : mapBuild(rows[0]);
}

export async function appendBuildLog(
  query: QueryFn,
  buildId: string,
  chunk: string
): Promise<void> {
  if (chunk.length === 0) return;
  await query(`UPDATE service_builds SET log = log || $2 WHERE id = $1`, [buildId, chunk]);
}

export async function setBuildPipelineYaml(
  query: QueryFn,
  buildId: string,
  yamlText: string
): Promise<void> {
  await query(`UPDATE service_builds SET pipeline_yaml = $2 WHERE id = $1`, [buildId, yamlText]);
}

/**
 * The most recent build's captured pipeline_yaml for a service. With no
 * panel override this IS the repo's kaiad.yaml at that commit (the build
 * worker stores exactly what it read), so the editor can preload the
 * real config instead of a generic template. Returns null when the
 * service has never produced a build with a pipeline.
 */
export async function getLatestBuildPipelineYaml(
  query: QueryFn,
  tenantId: string,
  serviceId: string
): Promise<string | null> {
  const { rows } = await query(
    `SELECT pipeline_yaml FROM service_builds
      WHERE tenant_id = $1 AND service_id = $2 AND pipeline_yaml IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, serviceId]
  );
  if (rows.length === 0) return null;
  return rows[0].pipeline_yaml == null ? null : String(rows[0].pipeline_yaml);
}

export async function finishBuild(
  query: QueryFn,
  buildId: string,
  data: { status: BuildStatus; imageRef?: string | null; failureReason?: string | null }
): Promise<void> {
  await query(
    `UPDATE service_builds
        SET status = $2,
            image_ref = COALESCE($3, image_ref),
            failure_reason = COALESCE($4, failure_reason),
            finished_at = now()
      WHERE id = $1`,
    [buildId, data.status, data.imageRef ?? null, data.failureReason ?? null]
  );
}

export async function listBuildsForService(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  limit = 50
): Promise<ServiceBuildRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_builds
      WHERE tenant_id = $1 AND service_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, serviceId, limit]
  );
  return rows.map(mapBuild);
}

export async function getBuild(
  query: QueryFn,
  tenantId: string,
  buildId: string
): Promise<ServiceBuildRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM service_builds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, buildId]
  );
  return rows.length === 0 ? undefined : mapBuild(rows[0]);
}

/**
 * Returns the most recent SHA the POLLER has enqueued for this service
 * (any status — the poller treats success, failure, and no_pipeline
 * identically: SHA seen, don't re-enqueue). Filtered to poll-triggered
 * builds so manual rebuilds don't make the poller think it's caught up.
 * Empty SHAs (in-flight manual builds) are skipped too.
 */
export async function getLatestBuildSha(
  query: QueryFn,
  serviceId: string
): Promise<string | null> {
  const { rows } = await query(
    `SELECT git_sha FROM service_builds
      WHERE service_id = $1
        AND triggered_by = 'poll'
        AND git_sha <> ''
      ORDER BY created_at DESC
      LIMIT 1`,
    [serviceId]
  );
  return rows.length === 0 ? null : String(rows[0].git_sha);
}

export async function listAllServicesForPoller(
  query: QueryFn
): Promise<
  Array<{
    id: string;
    tenantId: string;
    name: string;
    gitRepoUrl: string;
    sshKeyId: string | null;
    branch: string;
    pipelineName: string | null;
    kind: string;
    dependsOn: string[];
    pipelineOverride: string | null;
  }>
> {
  const { rows } = await query(
    `SELECT id, tenant_id, name, git_repo_url, ssh_key_id, branch, pipeline_name, kind, depends_on, pipeline_override
       FROM monitored_services`,
    []
  );
  return rows.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    gitRepoUrl: String(r.git_repo_url),
    sshKeyId: r.ssh_key_id == null ? null : String(r.ssh_key_id),
    branch: String(r.branch),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name),
    kind: r.kind == null ? "deployable" : String(r.kind),
    dependsOn: Array.isArray(r.depends_on) ? (r.depends_on as unknown[]).map((v) => String(v)) : [],
    pipelineOverride: r.pipeline_override == null ? null : String(r.pipeline_override)
  }));
}

/**
 * Cache the service's kind + dependsOn from its latest kaiad.yaml so
 * cheap reverse-lookups (find services that depend on X) and policy
 * gates (skip deploy when kind=supporting) don't need to re-parse
 * every build's pipeline_yaml.
 */
export async function updateServicePipelineMeta(
  query: QueryFn,
  tenantId: string,
  serviceId: string,
  data: { kind: string; dependsOn: string[] }
): Promise<void> {
  await query(
    `UPDATE monitored_services
        SET kind        = $3,
            depends_on  = $4::text[]
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, serviceId, data.kind, data.dependsOn]
  );
}

/**
 * Reverse lookup: find every service whose dependsOn array contains
 * `depName`. Used post-build to chain-trigger dependents.
 */
export async function listServicesDependingOn(
  query: QueryFn,
  tenantId: string,
  depName: string
): Promise<Array<{ id: string; name: string; branch: string }>> {
  const { rows } = await query(
    `SELECT id, name, branch
       FROM monitored_services
      WHERE tenant_id = $1
        AND depends_on @> ARRAY[$2]::text[]`,
    [tenantId, depName]
  );
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    branch: String(r.branch)
  }));
}

/**
 * Latest successful build for a service (by tenant + service name).
 * Used at dep resolution time to pick the image_ref + sha that the
 * dependent service's build templates should interpolate.
 */
export async function getLatestSuccessfulBuildByServiceName(
  query: QueryFn,
  tenantId: string,
  serviceName: string
): Promise<{ buildId: string; serviceId: string; gitSha: string; imageRef: string | null } | null> {
  const { rows } = await query(
    `SELECT b.id, b.service_id, b.git_sha, b.image_ref
       FROM service_builds b
       JOIN monitored_services s ON s.id = b.service_id
      WHERE b.tenant_id = $1
        AND s.name      = $2
        AND b.status    = 'success'
      ORDER BY b.created_at DESC
      LIMIT 1`,
    [tenantId, serviceName]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    buildId: String(r.id),
    serviceId: String(r.service_id),
    gitSha: String(r.git_sha),
    imageRef: r.image_ref == null ? null : String(r.image_ref)
  };
}

export async function recordBuildArtifact(
  query: QueryFn,
  data: {
    buildId: string;
    name: string;
    sizeBytes: number;
    sha256: string;
    relPath: string;
  }
): Promise<void> {
  await query(
    `INSERT INTO service_build_artifacts (build_id, name, size_bytes, sha256, rel_path)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (build_id, name) DO UPDATE
       SET size_bytes = EXCLUDED.size_bytes,
           sha256 = EXCLUDED.sha256,
           rel_path = EXCLUDED.rel_path`,
    [data.buildId, data.name, data.sizeBytes, data.sha256, data.relPath]
  );
}

export async function listBuildArtifacts(
  query: QueryFn,
  buildId: string
): Promise<ServiceBuildArtifactRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_build_artifacts WHERE build_id = $1 ORDER BY name`,
    [buildId]
  );
  return rows.map(mapArtifact);
}

// ---------------------------------------------------------------------------
// Load balancer / ingress status (one row per service+environment, upserted
// by the agent after a successful redeploy_service)
// ---------------------------------------------------------------------------

export type LoadBalancerType = "none" | "k8s" | "metallb" | "nginx";

export interface LoadBalancerStatusRow {
  id: string;
  tenantId: string;
  serviceId: string;
  agentId: string | null;
  environment: string;
  namespace: string;
  lbType: LoadBalancerType;
  externalIp: string | null;
  externalHostname: string | null;
  ports: Array<{ port: number; name?: string; protocol?: string; targetPort?: number }>;
  domains: Array<{ host: string; port: number; protocol: "http" | "https" }>;
  detail: Record<string, unknown>;
  /** Fully-qualified image reference the agent applied. */
  imageRef: string | null;
  /** Source build row id, if known. Lets the panel link the running version to its build log. */
  buildId: string | null;
  observedAt: string;
}

function mapLb(r: Record<string, unknown>): LoadBalancerStatusRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    serviceId: String(r.service_id),
    agentId: r.agent_id == null ? null : String(r.agent_id),
    environment: String(r.environment),
    namespace: String(r.namespace ?? ""),
    lbType: String(r.lb_type) as LoadBalancerType,
    externalIp: r.external_ip == null ? null : String(r.external_ip),
    externalHostname: r.external_hostname == null ? null : String(r.external_hostname),
    ports: Array.isArray(r.ports) ? (r.ports as LoadBalancerStatusRow["ports"]) : [],
    domains: Array.isArray(r.domains) ? (r.domains as LoadBalancerStatusRow["domains"]) : [],
    detail: typeof r.detail === "object" && r.detail !== null
      ? (r.detail as Record<string, unknown>)
      : {},
    imageRef: r.image_ref == null ? null : String(r.image_ref),
    buildId: r.build_id == null ? null : String(r.build_id),
    observedAt: new Date(r.observed_at as string).toISOString()
  };
}

export async function upsertLoadBalancerStatus(
  query: QueryFn,
  data: {
    tenantId: string;
    serviceId: string;
    agentId: string | null;
    environment: string;
    namespace: string;
    lbType: LoadBalancerType;
    externalIp: string | null;
    externalHostname: string | null;
    ports: LoadBalancerStatusRow["ports"];
    domains: LoadBalancerStatusRow["domains"];
    detail: Record<string, unknown>;
    imageRef: string | null;
    buildId: string | null;
  }
): Promise<LoadBalancerStatusRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO service_loadbalancer_status
       (id, tenant_id, service_id, agent_id, environment, namespace, lb_type,
        external_ip, external_hostname, ports, domains, detail,
        image_ref, build_id, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, now())
     ON CONFLICT (service_id, environment) DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       namespace = EXCLUDED.namespace,
       lb_type = EXCLUDED.lb_type,
       external_ip = EXCLUDED.external_ip,
       external_hostname = EXCLUDED.external_hostname,
       ports = EXCLUDED.ports,
       domains = EXCLUDED.domains,
       detail = EXCLUDED.detail,
       image_ref = EXCLUDED.image_ref,
       build_id = EXCLUDED.build_id,
       observed_at = now()
     RETURNING *`,
    [
      id,
      data.tenantId,
      data.serviceId,
      data.agentId,
      data.environment,
      data.namespace,
      data.lbType,
      data.externalIp,
      data.externalHostname,
      JSON.stringify(data.ports),
      JSON.stringify(data.domains),
      JSON.stringify(data.detail),
      data.imageRef,
      data.buildId
    ]
  );
  return mapLb(rows[0]);
}

/**
 * Returns the latest reported state for every service this agent is
 * known to be running. Used by the Agents page to show "what version
 * of each service is on this agent". One row per (service_id) — the
 * agent is the source of truth for any service it's bound to.
 */
export async function listRunningServicesForAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<LoadBalancerStatusRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_loadbalancer_status
      WHERE tenant_id = $1 AND agent_id = $2
      ORDER BY observed_at DESC`,
    [tenantId, agentId]
  );
  return rows.map(mapLb);
}

/**
 * Look up + delete the lb_status_report row for one (service, agent)
 * pair. Returns the row that was deleted (so the caller has the last
 * known namespace/env to send in the teardown_service command), or
 * null if nothing was tracked.
 */
export async function popLoadBalancerStatusForAgentService(
  query: QueryFn,
  tenantId: string,
  agentId: string,
  serviceId: string
): Promise<LoadBalancerStatusRow | null> {
  const { rows } = await query(
    `DELETE FROM service_loadbalancer_status
      WHERE tenant_id = $1 AND agent_id = $2 AND service_id = $3
      RETURNING *`,
    [tenantId, agentId, serviceId]
  );
  if (rows.length === 0) return null;
  return mapLb(rows[0]);
}

/**
 * For an agent's reconcile pass: list every (serviceId, latest
 * successful build) pair where this agent is bound but no
 * lb_status_report exists for the (service, env). The caller
 * dispatches a redeploy_service for each row so the agent catches
 * up to the latest image without waiting for a fresh build.
 */
export async function listMissingDeploysForAgent(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<
  Array<{
    serviceId: string;
    serviceName: string;
    branch: string;
    buildId: string;
    gitSha: string;
    imageRef: string;
    pipelineYaml: string;
    pipelineName: string | null;
  }>
> {
  // For each (agent, bound service), pick the most recent successful
  // build that produced an image. Then exclude services that already
  // have a lb_status_report row keyed by this agent — those are
  // "already deployed (or being attempted)".
  //
  // DISTINCT ON (service_id) + ORDER BY service_id, created_at DESC
  // gives us the latest build per service in one round trip.
  const { rows } = await query(
    `WITH latest_builds AS (
       SELECT DISTINCT ON (b.service_id)
              b.service_id,
              b.id          AS build_id,
              b.git_sha,
              b.image_ref,
              b.pipeline_yaml
         FROM service_builds b
        WHERE b.tenant_id = $1
          AND b.status    = 'success'
          AND b.image_ref IS NOT NULL
        ORDER BY b.service_id, b.created_at DESC
     )
     SELECT s.id            AS service_id,
            s.name          AS service_name,
            s.branch        AS branch,
            s.pipeline_name AS pipeline_name,
            lb.build_id,
            lb.git_sha,
            lb.image_ref,
            lb.pipeline_yaml
       FROM agent_services AS j
       JOIN monitored_services s ON s.id = j.service_id
       JOIN latest_builds lb     ON lb.service_id = s.id
  LEFT JOIN service_loadbalancer_status st
         ON st.service_id = s.id AND st.agent_id = $2
      WHERE j.tenant_id = $1
        AND j.agent_id  = $2
        AND st.id IS NULL`,
    [tenantId, agentId]
  );
  return rows.map((r) => ({
    serviceId: String(r.service_id),
    serviceName: String(r.service_name),
    branch: String(r.branch),
    buildId: String(r.build_id),
    gitSha: String(r.git_sha),
    imageRef: String(r.image_ref),
    pipelineYaml: String(r.pipeline_yaml ?? ""),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name)
  }));
}

/**
 * Global cross-tenant drift query — one row per bound (agent, service)
 * with the agent's environment, the latest successful build, and the
 * current lb_status_report (LEFT JOIN, so NULL when not yet deployed).
 *
 * Used by the periodic deployment scheduler. The caller parses each
 * row's pipeline_yaml, resolves the desired config under the agent's
 * env, and compares against currentImageRef/currentBuildId/
 * currentNamespace/currentEnvironment to decide whether to dispatch
 * a redeploy. We don't try to compute drift in SQL because resolving
 * a per-env namespace requires running the kaiad.yaml schema's
 * resolver, which lives in TS.
 */
export async function listAllDeployTargets(
  query: QueryFn
): Promise<
  Array<{
    tenantId: string;
    agentId: string;
    agentEnv: string;
    serviceId: string;
    serviceName: string;
    pipelineName: string | null;
    buildId: string;
    imageRef: string;
    pipelineYaml: string;
    currentImageRef: string | null;
    currentBuildId: string | null;
    currentNamespace: string | null;
    currentEnvironment: string | null;
  }>
> {
  const { rows } = await query(
    `WITH latest_builds AS (
       SELECT DISTINCT ON (b.service_id)
              b.tenant_id,
              b.service_id,
              b.id            AS build_id,
              b.image_ref,
              b.pipeline_yaml
         FROM service_builds b
        WHERE b.status    = 'success'
          AND b.image_ref IS NOT NULL
        ORDER BY b.service_id, b.created_at DESC
     )
     SELECT j.tenant_id,
            j.agent_id,
            a.environment       AS agent_env,
            s.id                AS service_id,
            s.name              AS service_name,
            s.pipeline_name     AS pipeline_name,
            lb.build_id,
            lb.image_ref,
            lb.pipeline_yaml,
            st.image_ref        AS current_image_ref,
            st.build_id         AS current_build_id,
            st.namespace        AS current_namespace,
            st.environment      AS current_environment
       FROM agent_services j
       JOIN agents a              ON a.id = j.agent_id  AND a.tenant_id = j.tenant_id
       JOIN monitored_services s  ON s.id = j.service_id AND s.tenant_id = j.tenant_id
       JOIN latest_builds lb      ON lb.service_id = s.id AND lb.tenant_id = j.tenant_id
  LEFT JOIN service_loadbalancer_status st
         ON st.tenant_id = j.tenant_id
        AND st.service_id = j.service_id
        AND st.agent_id   = j.agent_id`,
    []
  );
  return rows.map((r) => ({
    tenantId: String(r.tenant_id),
    agentId: String(r.agent_id),
    agentEnv: String(r.agent_env ?? "development"),
    serviceId: String(r.service_id),
    serviceName: String(r.service_name),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name),
    buildId: String(r.build_id),
    imageRef: String(r.image_ref),
    pipelineYaml: String(r.pipeline_yaml ?? ""),
    currentImageRef: r.current_image_ref == null ? null : String(r.current_image_ref),
    currentBuildId: r.current_build_id == null ? null : String(r.current_build_id),
    currentNamespace: r.current_namespace == null ? null : String(r.current_namespace),
    currentEnvironment: r.current_environment == null ? null : String(r.current_environment)
  }));
}

/**
 * Like listMissingDeploysForAgent but returns ALL services bound to
 * this agent that have at least one successful build — including ones
 * that already have an lb_status_report row. Caller diffs the resolved
 * config (namespace/instances/domains/loadBalancer) per service across
 * the old vs new environment to decide whether a redeploy is needed.
 *
 * Used by the env-change reconciler. listMissingDeploysForAgent's
 * `st.id IS NULL` filter would hide services that are already running
 * under the OLD env, but those are exactly the ones that need to flip
 * to the NEW env.
 */
export async function listLatestBuildsForBoundServices(
  query: QueryFn,
  tenantId: string,
  agentId: string
): Promise<
  Array<{
    serviceId: string;
    serviceName: string;
    branch: string;
    buildId: string;
    gitSha: string;
    imageRef: string;
    pipelineYaml: string;
    pipelineName: string | null;
  }>
> {
  const { rows } = await query(
    `WITH latest_builds AS (
       SELECT DISTINCT ON (b.service_id)
              b.service_id,
              b.id          AS build_id,
              b.git_sha,
              b.image_ref,
              b.pipeline_yaml
         FROM service_builds b
        WHERE b.tenant_id = $1
          AND b.status    = 'success'
          AND b.image_ref IS NOT NULL
        ORDER BY b.service_id, b.created_at DESC
     )
     SELECT s.id            AS service_id,
            s.name          AS service_name,
            s.branch        AS branch,
            s.pipeline_name AS pipeline_name,
            lb.build_id,
            lb.git_sha,
            lb.image_ref,
            lb.pipeline_yaml
       FROM agent_services AS j
       JOIN monitored_services s ON s.id = j.service_id
       JOIN latest_builds lb     ON lb.service_id = s.id
      WHERE j.tenant_id = $1
        AND j.agent_id  = $2`,
    [tenantId, agentId]
  );
  return rows.map((r) => ({
    serviceId: String(r.service_id),
    serviceName: String(r.service_name),
    branch: String(r.branch),
    buildId: String(r.build_id),
    gitSha: String(r.git_sha),
    imageRef: String(r.image_ref),
    pipelineYaml: String(r.pipeline_yaml ?? ""),
    pipelineName: r.pipeline_name == null ? null : String(r.pipeline_name)
  }));
}

export async function listLoadBalancerStatusForTenant(
  query: QueryFn,
  tenantId: string
): Promise<LoadBalancerStatusRow[]> {
  const { rows } = await query(
    `SELECT * FROM service_loadbalancer_status
      WHERE tenant_id = $1
      ORDER BY observed_at DESC`,
    [tenantId]
  );
  return rows.map(mapLb);
}

export async function getBuildArtifact(
  query: QueryFn,
  buildId: string,
  name: string
): Promise<ServiceBuildArtifactRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM service_build_artifacts WHERE build_id = $1 AND name = $2`,
    [buildId, name]
  );
  return rows.length === 0 ? undefined : mapArtifact(rows[0]);
}

// ── Permission groups + membership ────────────────────────────────────────

export interface PermissionGroupRow {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
}

function mapGroup(r: Record<string, unknown>): PermissionGroupRow {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    description: r.description == null ? "" : String(r.description),
    builtin: r.builtin === true,
    permissions: Array.isArray(r.permissions) ? (r.permissions as unknown[]).map(String) : []
  };
}

/** Effective permissions for a (tenant,user): union of their groups. */
export async function getEffectivePermissions(
  query: QueryFn,
  tenantId: string,
  userId: string
): Promise<string[]> {
  const { rows } = await query(
    `SELECT DISTINCT p.perm AS perm
       FROM user_groups ug
       JOIN permission_groups g ON g.id = ug.group_id
       CROSS JOIN LATERAL unnest(g.permissions) AS p(perm)
      WHERE ug.tenant_id = $1 AND ug.user_id = $2`,
    [tenantId, userId]
  );
  return rows.map((r) => String(r.perm));
}

export async function listGroups(query: QueryFn, tenantId: string): Promise<PermissionGroupRow[]> {
  const { rows } = await query(
    `SELECT * FROM permission_groups WHERE tenant_id = $1 ORDER BY builtin DESC, name`,
    [tenantId]
  );
  return rows.map(mapGroup);
}

export async function getGroup(
  query: QueryFn,
  tenantId: string,
  id: string
): Promise<PermissionGroupRow | undefined> {
  const { rows } = await query(
    `SELECT * FROM permission_groups WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return rows.length === 0 ? undefined : mapGroup(rows[0]);
}

export async function createGroup(
  query: QueryFn,
  tenantId: string,
  data: { name: string; description?: string; permissions: string[] }
): Promise<PermissionGroupRow> {
  const id = crypto.randomUUID();
  const { rows } = await query(
    `INSERT INTO permission_groups (id, tenant_id, name, description, builtin, permissions)
     VALUES ($1, $2, $3, $4, false, $5) RETURNING *`,
    [id, tenantId, data.name, data.description ?? "", data.permissions]
  );
  return mapGroup(rows[0]);
}

/** Update a NON-builtin group. Returns undefined if not found or builtin. */
export async function updateGroup(
  query: QueryFn,
  tenantId: string,
  id: string,
  data: { name?: string; description?: string; permissions?: string[] }
): Promise<PermissionGroupRow | undefined> {
  const { rows } = await query(
    `UPDATE permission_groups
        SET name = COALESCE($3, name),
            description = COALESCE($4, description),
            permissions = COALESCE($5, permissions)
      WHERE tenant_id = $1 AND id = $2 AND builtin = false
      RETURNING *`,
    [tenantId, id, data.name ?? null, data.description ?? null, data.permissions ?? null]
  );
  return rows.length === 0 ? undefined : mapGroup(rows[0]);
}

/** Delete a NON-builtin group. Returns false if not found / builtin. */
export async function deleteGroup(query: QueryFn, tenantId: string, id: string): Promise<boolean> {
  const { rows } = await query(
    `DELETE FROM permission_groups WHERE tenant_id = $1 AND id = $2 AND builtin = false RETURNING id`,
    [tenantId, id]
  );
  return rows.length > 0;
}

export interface TenantMemberRow {
  userId: string;
  email: string;
  role: string;
  groups: { id: string; name: string; builtin: boolean }[];
}

export async function listTenantMembers(
  query: QueryFn,
  tenantId: string
): Promise<TenantMemberRow[]> {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.email, m.role,
            COALESCE(json_agg(json_build_object('id', g.id, 'name', g.name, 'builtin', g.builtin))
                     FILTER (WHERE g.id IS NOT NULL), '[]') AS groups
       FROM tenant_memberships m
       JOIN users u ON u.id = m.user_id
  LEFT JOIN user_groups ug ON ug.tenant_id = m.tenant_id AND ug.user_id = m.user_id
  LEFT JOIN permission_groups g ON g.id = ug.group_id
      WHERE m.tenant_id = $1
   GROUP BY u.id, u.email, m.role
   ORDER BY u.email`,
    [tenantId]
  );
  return rows.map((r) => ({
    userId: String(r.user_id),
    email: String(r.email),
    role: String(r.role),
    groups: (typeof r.groups === "string" ? JSON.parse(r.groups) : (r.groups ?? [])) as {
      id: string;
      name: string;
      builtin: boolean;
    }[]
  }));
}

/** Replace a member's custom-group membership (built-in groups untouched). */
export async function setMemberCustomGroups(
  query: QueryFn,
  tenantId: string,
  userId: string,
  groupIds: string[]
): Promise<void> {
  await query(
    `DELETE FROM user_groups ug USING permission_groups g
      WHERE ug.group_id = g.id AND ug.tenant_id = $1 AND ug.user_id = $2 AND g.builtin = false`,
    [tenantId, userId]
  );
  for (const gid of groupIds) {
    await query(
      `INSERT INTO user_groups (tenant_id, user_id, group_id)
       SELECT $1, $2, $3 WHERE EXISTS
         (SELECT 1 FROM permission_groups WHERE id = $3 AND tenant_id = $1 AND builtin = false)
       ON CONFLICT DO NOTHING`,
      [tenantId, userId, gid]
    );
  }
}

/** Change a member's legacy role AND swap their built-in group accordingly. */
export async function setMemberRole(
  query: QueryFn,
  tenantId: string,
  userId: string,
  role: string
): Promise<boolean> {
  const { rows } = await query(
    `UPDATE tenant_memberships SET role = $3
      WHERE tenant_id = $1 AND user_id = $2 RETURNING user_id`,
    [tenantId, userId, role]
  );
  if (rows.length === 0) return false;
  await query(
    `DELETE FROM user_groups ug USING permission_groups g
      WHERE ug.group_id = g.id AND ug.tenant_id = $1 AND ug.user_id = $2
        AND g.builtin = true`,
    [tenantId, userId]
  );
  await query(
    `INSERT INTO user_groups (tenant_id, user_id, group_id)
     SELECT $1, $2, g.id FROM permission_groups g
      WHERE g.tenant_id = $1 AND g.name = 'builtin:' || $3
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, role]
  );
  return true;
}

export async function removeTenantMember(
  query: QueryFn,
  tenantId: string,
  userId: string
): Promise<boolean> {
  await query(`DELETE FROM user_groups WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  const { rows } = await query(
    `DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 RETURNING user_id`,
    [tenantId, userId]
  );
  return rows.length > 0;
}

/** Add an EXISTING user (by email) to a tenant with a role + built-in group. */
export async function addTenantMemberByEmail(
  query: QueryFn,
  tenantId: string,
  email: string,
  role: string
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const u = await query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
  if (u.rows.length === 0) {
    return { ok: false, reason: "No user with that email. They must sign in once first." };
  }
  const userId = String(u.rows[0].id);
  await query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [tenantId, userId, role]
  );
  await query(
    `INSERT INTO user_groups (tenant_id, user_id, group_id)
     SELECT $1, $2, g.id FROM permission_groups g
      WHERE g.tenant_id = $1 AND g.name = 'builtin:' || $3
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, role]
  );
  return { ok: true, userId };
}

// ---------------------------------------------------------------------------
// Registry retention policy + GC
// ---------------------------------------------------------------------------

export interface RegistryRetentionPolicy {
  keepLastNPerRepo: number;
  maxTotalBytes: number;
  keepForDays: number;
  updatedAt: string;
}

export interface RegistryGcStats {
  /** Repository tags dropped this sweep (latest-of-repo is never dropped). */
  tagsDeleted: number;
  /** Manifests with no tag remaining → deleted. */
  manifestsDeleted: number;
  /** Blobs no manifest references → deleted (+ their pg_largeobject content). */
  blobsDeleted: number;
  /** Bytes reclaimed (sum of size_bytes of deleted blobs). */
  bytesReclaimed: number;
  /** Total bytes still in the registry after this sweep. */
  totalBytesAfter: number;
}

export async function getRegistryRetentionPolicy(query: QueryFn): Promise<RegistryRetentionPolicy> {
  const { rows } = await query(
    `SELECT keep_last_n_per_repo, max_total_bytes, keep_for_days, updated_at
       FROM registry_retention_policy WHERE id = 1`,
    [],
  );
  if (rows.length === 0) {
    // ensureCoreSchema seeds row 1; this branch only fires in a half-migrated
    // setup. Fall back to the documented defaults.
    return {
      keepLastNPerRepo: 10,
      maxTotalBytes: 68_719_476_736,
      keepForDays: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  const r = rows[0];
  return {
    keepLastNPerRepo: Number(r.keep_last_n_per_repo),
    maxTotalBytes: Number(r.max_total_bytes),
    keepForDays: Number(r.keep_for_days),
    updatedAt:
      r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function updateRegistryRetentionPolicy(
  query: QueryFn,
  patch: Partial<Omit<RegistryRetentionPolicy, "updatedAt">>,
): Promise<RegistryRetentionPolicy> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.keepLastNPerRepo !== undefined) {
    vals.push(patch.keepLastNPerRepo);
    sets.push(`keep_last_n_per_repo = $${vals.length}`);
  }
  if (patch.maxTotalBytes !== undefined) {
    vals.push(patch.maxTotalBytes);
    sets.push(`max_total_bytes = $${vals.length}`);
  }
  if (patch.keepForDays !== undefined) {
    vals.push(patch.keepForDays);
    sets.push(`keep_for_days = $${vals.length}`);
  }
  if (sets.length > 0) {
    sets.push("updated_at = now()");
    await query(
      `UPDATE registry_retention_policy SET ${sets.join(", ")} WHERE id = 1`,
      vals,
    );
  }
  return getRegistryRetentionPolicy(query);
}

// Internal: drop manifests with no tag pointing at them, then drop blobs
// no manifest still references, and lo_unlink their content. Returns
// {manifestsDeleted, blobsDeleted, bytesReclaimed}.
async function gcOrphans(
  query: QueryFn,
): Promise<{ manifestsDeleted: number; blobsDeleted: number; bytesReclaimed: number }> {
  const { rows: mDel } = await query(
    `DELETE FROM registry_manifests
       WHERE digest NOT IN (SELECT manifest_digest FROM registry_tags)
     RETURNING digest`,
    [],
  );
  // Blobs that no remaining manifest references in any way (config /
  // layers / referenced_manifest_digests).
  const { rows: orphanBlobs } = await query(
    `WITH refd AS (
       SELECT digest AS d FROM registry_manifests
       UNION SELECT config_digest FROM registry_manifests WHERE config_digest IS NOT NULL
       UNION SELECT unnest(layer_digests) FROM registry_manifests
       UNION SELECT unnest(referenced_manifest_digests) FROM registry_manifests
     )
     SELECT digest, content_oid, size_bytes
       FROM registry_blobs
      WHERE digest NOT IN (SELECT d FROM refd WHERE d IS NOT NULL)`,
    [],
  );
  let bytesReclaimed = 0;
  for (const b of orphanBlobs) {
    await query(`SELECT lo_unlink($1)`, [b.content_oid]);
    bytesReclaimed += Number(b.size_bytes ?? 0);
  }
  if (orphanBlobs.length > 0) {
    await query(
      `DELETE FROM registry_blobs WHERE digest = ANY($1::text[])`,
      [orphanBlobs.map((b) => b.digest as string)],
    );
  }
  return {
    manifestsDeleted: mDel.length,
    blobsDeleted: orphanBlobs.length,
    bytesReclaimed,
  };
}

/** Apply the retention policy in one sweep. Safe to call repeatedly:
 *  (1) per-repo keep last N — older tags pruned (never the most-recent
 *      per repo, never a tag named `latest`, never a tag updated within
 *      keepForDays); (2) GC orphan manifests + blobs (+ their LOs);
 *  (3) size cap — while total bytes > maxTotalBytes, drop the next
 *      oldest tag (still respecting the per-repo "most recent" guard)
 *      and re-GC, capped to avoid pathological loops. */
export async function applyRegistryRetention(
  query: QueryFn,
  policy: Pick<RegistryRetentionPolicy, "keepLastNPerRepo" | "maxTotalBytes" | "keepForDays">,
): Promise<RegistryGcStats> {
  // Step 1: per-repo "keep last N".
  let tagsDeleted = 0;
  if (policy.keepLastNPerRepo > 0) {
    const { rows: toDrop } = await query(
      `WITH ranked AS (
         SELECT repo, tag, updated_at,
                row_number() OVER (PARTITION BY repo ORDER BY updated_at DESC, tag DESC) AS rn
           FROM registry_tags
          WHERE tag <> 'latest'
       )
       SELECT repo, tag FROM ranked
        WHERE rn > $1
          AND ($2 = 0 OR updated_at < now() - ($2 || ' days')::interval)`,
      [policy.keepLastNPerRepo, policy.keepForDays],
    );
    for (const r of toDrop) {
      const { rows } = await query(
        `DELETE FROM registry_tags WHERE repo = $1 AND tag = $2 RETURNING repo`,
        [r.repo, r.tag],
      );
      tagsDeleted += rows.length;
    }
  }

  // Step 2: orphan cleanup (manifests + blobs + LOs).
  let { manifestsDeleted, blobsDeleted, bytesReclaimed } = await gcOrphans(query);

  // Step 3: size cap loop. Drop oldest non-protected tag, GC, repeat.
  if (policy.maxTotalBytes > 0) {
    for (let i = 0; i < 100; i++) {
      const { rows: total } = await query(
        `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM registry_blobs`,
        [],
      );
      if (Number(total[0].bytes) <= policy.maxTotalBytes) break;
      const { rows: oldest } = await query(
        `WITH ranked AS (
           SELECT repo, tag, updated_at,
                  row_number() OVER (PARTITION BY repo ORDER BY updated_at DESC, tag DESC) AS rn
             FROM registry_tags
            WHERE tag <> 'latest'
         )
         SELECT repo, tag FROM ranked
          WHERE rn > 1
          ORDER BY updated_at ASC
          LIMIT 5`,
        [],
      );
      if (oldest.length === 0) break;
      for (const r of oldest) {
        const { rows } = await query(
          `DELETE FROM registry_tags WHERE repo = $1 AND tag = $2 RETURNING repo`,
          [r.repo, r.tag],
        );
        tagsDeleted += rows.length;
      }
      const step = await gcOrphans(query);
      manifestsDeleted += step.manifestsDeleted;
      blobsDeleted += step.blobsDeleted;
      bytesReclaimed += step.bytesReclaimed;
    }
  }

  const { rows: after } = await query(
    `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes FROM registry_blobs`,
    [],
  );
  return {
    tagsDeleted,
    manifestsDeleted,
    blobsDeleted,
    bytesReclaimed,
    totalBytesAfter: Number(after[0].bytes),
  };
}

/** Read-only stats for the Settings UI: total bytes + per-repo breakdown. */
export async function getRegistryStats(query: QueryFn): Promise<{
  totalBytes: number;
  totalBlobs: number;
  repos: { repo: string; tags: number; bytes: number }[];
}> {
  const { rows: blobs } = await query(
    `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS bytes, COUNT(*)::bigint AS n FROM registry_blobs`,
    [],
  );
  const { rows: repos } = await query(
    `WITH mb AS (
       SELECT m.repo, m.digest AS manifest_digest,
              unnest(coalesce(m.layer_digests, '{}') ||
                     CASE WHEN m.config_digest IS NOT NULL THEN ARRAY[m.config_digest] ELSE '{}' END) AS blob
         FROM registry_manifests m
     )
     SELECT mb.repo,
            (SELECT COUNT(*) FROM registry_tags t WHERE t.repo = mb.repo) AS tags,
            COALESCE(SUM(DISTINCT rb.size_bytes), 0)::bigint AS bytes
       FROM mb LEFT JOIN registry_blobs rb ON rb.digest = mb.blob
      GROUP BY mb.repo
      ORDER BY bytes DESC`,
    [],
  );
  return {
    totalBytes: Number(blobs[0].bytes),
    totalBlobs: Number(blobs[0].n),
    repos: repos.map((r) => ({
      repo: String(r.repo),
      tags: Number(r.tags),
      bytes: Number(r.bytes),
    })),
  };
}
