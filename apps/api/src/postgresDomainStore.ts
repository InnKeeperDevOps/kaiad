import crypto from "node:crypto";
import type { Pool } from "pg";
import type { DomainStore } from "./domainStore.js";
import * as queries from "@sm/db";

function getEncryptionKey(): Buffer {
  const rawKey = process.env.KAIAD_ENCRYPTION_KEY;
  if (!rawKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("KAIAD_ENCRYPTION_KEY is required in production");
    }
    return crypto.createHash("sha256").update("dev-fallback-key").digest();
  }
  if (rawKey.length === 64) {
    return Buffer.from(rawKey, "hex");
  }
  return crypto.createHash("sha256").update(rawKey).digest();
}

function encryptSshKey(plaintext: string): string {
  const keyBytes = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${encrypted.toString("base64")}:${tag.toString("base64")}`;
}

function decryptSshKey(stored: string): string | null {
  const parts = stored.split(":");
  if (parts.length !== 3) return null;
  try {
    const keyBytes = getEncryptionKey();
    const iv = Buffer.from(parts[0], "base64");
    const encrypted = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function createPostgresDomainStore(pool: Pool): DomainStore {
  const queryFn = async (sql: string, params: unknown[]) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };

  return {
    listIncidents: (tenantId) => queries.listIncidents(queryFn, tenantId),
    getIncident: (tenantId, id) => queries.getIncident(queryFn, tenantId, id),
    upsertIncident: (tenantId, data) => queries.upsertIncident(queryFn, tenantId, data),
    updateIncidentStatus: (tenantId, id, status) =>
      queries.updateIncidentStatus(queryFn, tenantId, id, status),
    deleteIncident: (tenantId, id) => queries.deleteIncident(queryFn, tenantId, id),
    resolveIncidentByFingerprint: (tenantId, serviceId, fingerprint) =>
      queries.resolveIncidentByFingerprint(queryFn, tenantId, serviceId, fingerprint),
    resolveStaleIncidents: (cutoff) => queries.resolveStaleIncidents(queryFn, cutoff),
    recordFixProgress: (tenantId, serviceId, fingerprint, patch) =>
      queries.recordFixProgress(queryFn, tenantId, serviceId, fingerprint, patch),
    getCurrentIncidentId: (tenantId, serviceId, fingerprint) =>
      queries.getCurrentIncidentId(queryFn, tenantId, serviceId, fingerprint),

    listSshKeys: async (tenantId) => {
      const rows = await queries.listSshKeys(queryFn, tenantId);
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        name: r.name,
        type: r.type as "uploaded" | "local_path",
        localPath: r.localPath ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }));
    },
    createSshKey: async (tenantId, data) => {
      let privateKeyEncrypted: string | undefined = undefined;
      if (data.privateKey) {
        privateKeyEncrypted = encryptSshKey(data.privateKey);
      }
      const row = await queries.createSshKey(queryFn, tenantId, {
        name: data.name,
        type: data.type,
        localPath: data.localPath,
        privateKeyEncrypted
      });
      return {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        type: row.type as "uploaded" | "local_path",
        localPath: row.localPath ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      };
    },
    deleteSshKey: (tenantId, id) => queries.deleteSshKey(queryFn, tenantId, id),
    getSshKeyMaterial: async (tenantId, id) => {
      const row = await queries.getSshKey(queryFn, tenantId, id);
      if (!row) return null;
      const type = row.type as "uploaded" | "local_path";
      if (type === "uploaded") {
        const enc = (row as unknown as { privateKeyEncrypted: string | null }).privateKeyEncrypted;
        if (!enc) return { type: "uploaded", privateKey: null, localPath: null };
        return { type: "uploaded", privateKey: decryptSshKey(enc), localPath: null };
      }
      return { type: "local_path", privateKey: null, localPath: row.localPath ?? null };
    },

    listAgents: (tenantId) => queries.listAgents(queryFn, tenantId),
    getAgent: (tenantId, id) => queries.getAgent(queryFn, tenantId, id),
    recordAgentHeartbeat: (tenantId, data) =>
      queries.recordAgentHeartbeat(queryFn, tenantId, data),
    markAgentOffline: (tenantId, agentId) => queries.markAgentOffline(queryFn, tenantId, agentId),
    updateAgent: (tenantId, agentId, data) => queries.updateAgent(queryFn, tenantId, agentId, data),
    deleteAgent: (tenantId, agentId) => queries.deleteAgent(queryFn, tenantId, agentId),
    listServices: async (tenantId) => {
      const rows = await queries.listServices(queryFn, tenantId);
      return Promise.all(
        rows.map(async (svc) => ({
          ...svc,
          agents: await queries.listAgentsForService(queryFn, tenantId, svc.id)
        }))
      );
    },
    getService: async (tenantId, id) => {
      const row = await queries.getService(queryFn, tenantId, id);
      if (!row) return undefined;
      const agents = await queries.listAgentsForService(queryFn, tenantId, id);
      return { ...row, agents };
    },
    createService: async (tenantId, data) => {
      const row = await queries.createService(queryFn, tenantId, {
        name: data.name,
        gitRepoUrl: data.gitRepoUrl,
        sshKeyId: data.sshKeyId,
        branch: data.branch,
        dockerImage: data.dockerImage,
        composePath: data.composePath,
        pipelineName: data.pipelineName,
        fixExecutor: data.fixExecutor,
        healthcheck: data.healthcheck ?? null,
        securityContext: data.securityContext ?? null
      });
      if (data.agentIds && data.agentIds.length > 0) {
        await queries.setAgentBindings(queryFn, tenantId, row.id, data.agentIds);
      }
      const agents = await queries.listAgentsForService(queryFn, tenantId, row.id);
      return { ...row, agents };
    },
    updateService: async (tenantId, id, patch) => {
      const assignments: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      };
      if (patch.name !== undefined) push("name", patch.name);
      if (patch.gitRepoUrl !== undefined) push("git_repo_url", patch.gitRepoUrl);
      if (patch.sshKeyId !== undefined) push("ssh_key_id", patch.sshKeyId);
      if (patch.branch !== undefined) push("branch", patch.branch);
      if (patch.dockerImage !== undefined) push("docker_image", patch.dockerImage);
      if (patch.composePath !== undefined) push("compose_path", patch.composePath);
      if (patch.pipelineName !== undefined) push("pipeline_name", patch.pipelineName);
      if (patch.fixExecutor !== undefined) push("fix_executor", patch.fixExecutor);
      // Healthcheck patch: null clears every column (back to "no probe");
      // an object replaces all seven fields atomically. Undefined leaves
      // them alone. We don't allow per-field patches — the form sends a
      // whole healthcheck or nothing, which keeps the wire schema tidy.
      if (patch.healthcheck !== undefined) {
        const hc = patch.healthcheck;
        push("healthcheck_path", hc?.path ?? null);
        push("healthcheck_port", hc?.port ?? null);
        push("healthcheck_initial_delay_seconds", hc?.initialDelaySeconds ?? null);
        push("healthcheck_period_seconds", hc?.periodSeconds ?? null);
        push("healthcheck_timeout_seconds", hc?.timeoutSeconds ?? null);
        push("healthcheck_failure_threshold", hc?.failureThreshold ?? null);
        push("healthcheck_success_threshold", hc?.successThreshold ?? null);
      }
      // securityContext patch: null clears every column (back to "no
      // securityContext block on the Pod"); an object replaces all
      // three fields atomically. Same atomic-replace shape as
      // healthcheck above.
      if (patch.securityContext !== undefined) {
        const sc = patch.securityContext;
        push("security_run_as_user", sc?.runAsUser ?? null);
        push("security_run_as_group", sc?.runAsGroup ?? null);
        push("security_fs_group", sc?.fsGroup ?? null);
      }
      if (assignments.length > 0) {
        values.push(id, tenantId);
        const { rows } = await queryFn(
          `UPDATE monitored_services SET ${assignments.join(", ")} WHERE id = $${values.length - 1} AND tenant_id = $${values.length} RETURNING id`,
          values
        );
        if (rows.length === 0) return undefined;
      } else {
        // No column changes, but we still want a 404 if the row is missing
        // before touching bindings — protects against cross-tenant writes.
        const existing = await queries.getService(queryFn, tenantId, id);
        if (!existing) return undefined;
      }
      if (patch.agentIds !== undefined) {
        await queries.setAgentBindings(queryFn, tenantId, id, patch.agentIds);
      }
      const fresh = await queries.getService(queryFn, tenantId, id);
      if (!fresh) return undefined;
      const agents = await queries.listAgentsForService(queryFn, tenantId, id);
      return { ...fresh, agents };
    },
    deleteService: async (tenantId, id) => {
      // FK cascade on agent_services takes care of binding cleanup.
      const { rows } = await queryFn(
        "DELETE FROM monitored_services WHERE id = $1 AND tenant_id = $2 RETURNING id",
        [id, tenantId]
      );
      return rows.length > 0;
    },

    attachServiceToAgent: async (tenantId, agentId, serviceId) => {
      // Tenant scoping: confirm both exist in this tenant before attaching.
      // (The DB FK only enforces existence, not tenant boundaries.)
      const svc = await queries.getService(queryFn, tenantId, serviceId);
      if (!svc) return false;
      const agent = await queries.getAgent(queryFn, tenantId, agentId);
      if (!agent) return false;
      return queries.attachServiceToAgent(queryFn, tenantId, agentId, serviceId);
    },
    detachServiceFromAgent: async (tenantId, agentId, serviceId) => {
      return queries.detachServiceFromAgent(queryFn, tenantId, agentId, serviceId);
    },
    listServicesForAgent: async (tenantId, agentId) => {
      const rows = await queries.listServicesForAgent(queryFn, tenantId, agentId);
      return Promise.all(
        rows.map(async (svc) => ({
          ...svc,
          agents: await queries.listAgentsForService(queryFn, tenantId, svc.id)
        }))
      );
    },
    appendComponentLogs: (tenantId, entries) =>
      queries.appendComponentLogs(queryFn, tenantId, entries),
    listComponentLogs: (tenantId, filter, opts) =>
      queries.listComponentLogs(queryFn, tenantId, filter, opts),
    pruneComponentLogs: (cutoff) => queries.pruneComponentLogs(queryFn, cutoff)
  } as DomainStore;
}
