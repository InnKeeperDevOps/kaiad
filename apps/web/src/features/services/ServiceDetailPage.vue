<script setup lang="ts">
import { computed, onMounted, ref, watch, type CSSProperties } from "vue";
import {
  ArrowLeft,
  Box,
  Check,
  Copy,
  Cpu,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from "lucide-vue-next";
import {
  api,
  type Agent,
  type AgentAppTelemetry,
  type MonitoredService,
  type SshKey
} from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import Badge from "../../components/Badge.vue";
import Button from "../../components/Button.vue";
import Card from "../../components/Card.vue";
import { useTelemetryStream } from "../agents/useTelemetryStream.js";
import {
  badgeVariantForStatus,
  formatBytes,
  formatBytesPerSec,
  formatPercent,
  formatRelativeTime,
  formatRuntimeBackend
} from "../agents/format.js";
import BuildsForServiceSection from "./BuildsForServiceSection.vue";
import PipelineOverrideEditor from "./PipelineOverrideEditor.vue";

// One page per service: identity + agents running it (with their live
// container telemetry) + builds + pipeline override + admin actions.
// Replaces the inline expansions that used to live on ServicesPage.
const props = defineProps<{ serviceId: string }>();

const auth = useAuth();
const canManage = computed(() => auth.value.isAdmin);
const isViewer = computed(() => auth.value.isViewer);

const service = ref<MonitoredService | null>(null);
const allServices = ref<MonitoredService[]>([]); // for unique-name validation on clone
const agents = ref<Agent[]>([]);
const sshKeys = ref<SshKey[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);

const live = useTelemetryStream(() => true);

async function fetchAll() {
  error.value = null;
  try {
    const [svcRes, agentRes, keyRes] = await Promise.all([
      api.listServices(),
      api.listAgents().catch(() => ({ agents: [] as Agent[] })),
      api.listSshKeys().catch(() => ({ keys: [] as SshKey[] }))
    ]);
    allServices.value = svcRes.services;
    service.value = svcRes.services.find((s) => s.id === props.serviceId) ?? null;
    agents.value = agentRes.agents;
    sshKeys.value = keyRes.keys;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => void fetchAll());
watch(
  () => props.serviceId,
  () => {
    service.value = null;
    loading.value = true;
    void fetchAll();
  }
);

// ─── Bound agents + their containers ───────────────────────────────
// `service.agents` is the binding list (agentId → "this agent is
// observing this service"). We hydrate each binding with the live
// Agent row from listAgents and the live per-container telemetry from
// the WS stream — both are reactive, so changes appear without a
// refetch.
type BoundAgentRow = {
  agent: Agent | null;
  agentId: string;
  websocketConnected: boolean;
  containers: AgentAppTelemetry[];
};
const boundAgents = computed<BoundAgentRow[]>(() => {
  const svc = service.value;
  if (!svc) return [];
  const byId = new Map(agents.value.map((a) => [a.id, a] as const));
  return (svc.agents ?? [])
    .map((b) => {
      const agent = byId.get(b.agentId) ?? null;
      const livePresence = live.presence[b.agentId];
      const websocketConnected =
        livePresence !== undefined ? livePresence : agent?.websocketConnected ?? false;
      // Live apps override the stored snapshot for the current frame.
      // Containers belong to this service iff their serviceId matches.
      const liveApps = live.apps[b.agentId];
      const liveContainers: AgentAppTelemetry[] = liveApps
        ? Object.values(liveApps).filter((c) => c.serviceId === props.serviceId)
        : (agent?.apps ?? []).filter((c) => c.serviceId === props.serviceId);
      return {
        agent,
        agentId: b.agentId,
        websocketConnected,
        containers: liveContainers.sort((x, y) =>
          (x.name ?? x.containerId).localeCompare(y.name ?? y.containerId)
        )
      };
    })
    .sort((a, b) => {
      const an = (a.agent?.name?.trim() || a.agentId).toLowerCase();
      const bn = (b.agent?.name?.trim() || b.agentId).toLowerCase();
      return an.localeCompare(bn);
    });
});
const totalContainers = computed(() =>
  boundAgents.value.reduce((n, b) => n + b.containers.length, 0)
);

// ─── Edit mode ─────────────────────────────────────────────────────
const editing = ref(false);
// Healthcheck inputs are kept as strings in the form so an empty field
// (= "don't set") is distinguishable from `0`. We coerce to numbers at
// submit time and null out the whole probe when path or port is blank.
const form = ref({
  name: "",
  gitRepoUrl: "",
  sshKeyId: "",
  branch: "main",
  dockerImage: "",
  composePath: "",
  pipelineName: "",
  locked: false,
  agentIds: [] as string[],
  healthcheckPath: "",
  healthcheckPort: "",
  healthcheckInitialDelaySeconds: "",
  healthcheckPeriodSeconds: "",
  healthcheckTimeoutSeconds: "",
  healthcheckFailureThreshold: "",
  healthcheckSuccessThreshold: "",
  // securityContext — same strings-not-numbers convention as
  // healthcheck so an empty input means "leave this column null"
  // (vs. 0, which is a valid UID).
  runAsUser: "",
  runAsGroup: "",
  fsGroup: ""
});
const saving = ref(false);

function startEdit() {
  const svc = service.value;
  if (!svc) return;
  const hc = svc.healthcheck;
  form.value = {
    name: svc.name,
    gitRepoUrl: svc.gitRepoUrl,
    sshKeyId: svc.sshKeyId ?? "",
    branch: svc.branch,
    dockerImage: svc.dockerImage ?? "",
    composePath: svc.composePath ?? "",
    pipelineName: svc.pipelineName ?? "",
    locked: svc.locked === true,
    agentIds: (svc.agents ?? []).map((b) => b.agentId),
    healthcheckPath: hc?.path ?? "",
    healthcheckPort: hc?.port != null ? String(hc.port) : "",
    healthcheckInitialDelaySeconds:
      hc?.initialDelaySeconds != null ? String(hc.initialDelaySeconds) : "",
    healthcheckPeriodSeconds: hc?.periodSeconds != null ? String(hc.periodSeconds) : "",
    healthcheckTimeoutSeconds: hc?.timeoutSeconds != null ? String(hc.timeoutSeconds) : "",
    healthcheckFailureThreshold:
      hc?.failureThreshold != null ? String(hc.failureThreshold) : "",
    healthcheckSuccessThreshold:
      hc?.successThreshold != null ? String(hc.successThreshold) : "",
    runAsUser: svc.securityContext?.runAsUser != null ? String(svc.securityContext.runAsUser) : "",
    runAsGroup: svc.securityContext?.runAsGroup != null ? String(svc.securityContext.runAsGroup) : "",
    fsGroup: svc.securityContext?.fsGroup != null ? String(svc.securityContext.fsGroup) : ""
  };
  editing.value = true;
  actionError.value = null;
}
function cancelEdit() {
  editing.value = false;
  actionError.value = null;
}
function toggleAgentBinding(agentId: string) {
  form.value.agentIds = form.value.agentIds.includes(agentId)
    ? form.value.agentIds.filter((a) => a !== agentId)
    : [...form.value.agentIds, agentId];
}
function buildSecurityContextPatch(): NonNullable<MonitoredService["securityContext"]> | null {
  const num = (s: string): number | undefined => {
    const t = s.trim();
    if (!t) return undefined;
    const n = parseInt(t, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const runAsUser = num(form.value.runAsUser);
  const runAsGroup = num(form.value.runAsGroup);
  const fsGroup = num(form.value.fsGroup);
  // All-empty form ⇒ null (drop every column). Otherwise emit only
  // the fields the user filled in.
  if (runAsUser === undefined && runAsGroup === undefined && fsGroup === undefined) {
    return null;
  }
  const out: NonNullable<MonitoredService["securityContext"]> = {};
  if (runAsUser !== undefined) out.runAsUser = runAsUser;
  if (runAsGroup !== undefined) out.runAsGroup = runAsGroup;
  if (fsGroup !== undefined) out.fsGroup = fsGroup;
  return out;
}
function buildHealthcheckPatch(): NonNullable<MonitoredService["healthcheck"]> | null {
  const path = form.value.healthcheckPath.trim();
  const port = parseInt(form.value.healthcheckPort, 10);
  // Healthcheck is on iff BOTH path and a valid port are supplied. An
  // explicit clear (blank path or port) sends null so the server drops
  // every column.
  if (!path || !Number.isFinite(port) || port <= 0) return null;
  const numOrUndef = (s: string): number | undefined => {
    const t = s.trim();
    if (!t) return undefined;
    const n = parseInt(t, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  return {
    path,
    port,
    initialDelaySeconds: numOrUndef(form.value.healthcheckInitialDelaySeconds),
    periodSeconds: numOrUndef(form.value.healthcheckPeriodSeconds),
    timeoutSeconds: numOrUndef(form.value.healthcheckTimeoutSeconds),
    failureThreshold: numOrUndef(form.value.healthcheckFailureThreshold),
    successThreshold: numOrUndef(form.value.healthcheckSuccessThreshold)
  };
}
async function saveEdit() {
  if (!service.value) return;
  saving.value = true;
  actionError.value = null;
  try {
    const pipelineTrim = form.value.pipelineName.trim();
    const updated = await api.updateService(service.value.id, {
      name: form.value.name,
      gitRepoUrl: form.value.gitRepoUrl,
      sshKeyId: form.value.sshKeyId || null,
      branch: form.value.branch,
      dockerImage: form.value.dockerImage.trim() || undefined,
      composePath: form.value.composePath.trim() || undefined,
      // empty string → null clears (revert to single-pipeline default)
      pipelineName: pipelineTrim || null,
      locked: form.value.locked,
      agentIds: form.value.agentIds,
      healthcheck: buildHealthcheckPatch(),
      securityContext: buildSecurityContextPatch()
    });
    service.value = updated;
    editing.value = false;
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

// ─── Clone ────────────────────────────────────────────────────────
function uniqueCopyName(base: string): string {
  const existing = new Set(allServices.value.map((s) => s.name));
  const c = `${base} (copy)`;
  if (!existing.has(c)) return c;
  for (let n = 2; n < 1000; n += 1) {
    const cn = `${base} (copy ${n})`;
    if (!existing.has(cn)) return cn;
  }
  return `${base} (copy ${Date.now()})`;
}
async function handleClone() {
  const svc = service.value;
  if (!svc) return;
  const newName = uniqueCopyName(svc.name);
  if (!window.confirm(`Clone "${svc.name}" as "${newName}"?`)) return;
  actionError.value = null;
  try {
    const clone = await api.createService({
      name: newName,
      gitRepoUrl: svc.gitRepoUrl,
      sshKeyId: svc.sshKeyId ?? undefined,
      branch: svc.branch,
      dockerImage: svc.dockerImage ?? undefined,
      composePath: svc.composePath ?? undefined,
      pipelineName: svc.pipelineName ?? undefined
    });
    // Navigate to the new service's detail page so the user lands on
    // their clone instead of staring at the original they just copied.
    window.location.hash = `service/${encodeURIComponent(clone.id)}`;
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
  }
}

// ─── Delete ───────────────────────────────────────────────────────
async function handleDelete() {
  const svc = service.value;
  if (!svc) return;
  if (
    !window.confirm(
      `Delete service "${svc.name}"? This will also remove its runs and incidents.`
    )
  )
    return;
  actionError.value = null;
  try {
    await api.deleteService(svc.id);
    window.location.hash = "services";
  } catch (e: unknown) {
    actionError.value = (e as Error).message;
  }
}

// ─── Style helpers ────────────────────────────────────────────────
const muted = "var(--color-text-secondary)";
const cellTitle: CSSProperties = {
  fontSize: "0.75rem",
  color: muted,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: "0.2rem"
};
const cellValue: CSSProperties = { fontSize: "1.05rem", fontWeight: 600 };
const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  marginTop: "0.2rem",
  boxSizing: "border-box"
};
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--color-border)",
  color: muted,
  fontSize: "0.72rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em"
};
const tdStyle: CSSProperties = { padding: "0.4rem 0.5rem", fontSize: "0.82rem" };
const monoStyle: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

function sshKeyName(id: string | null | undefined): string {
  if (!id) return "— None —";
  const k = sshKeys.value.find((x) => x.id === id);
  return k?.name ?? id;
}
</script>

<template>
  <section :style="{ width: '100%' }">
    <a
      href="#services"
      :style="{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        color: muted,
        textDecoration: 'none',
        fontSize: '0.85rem',
        marginBottom: '0.75rem'
      }"
    >
      <ArrowLeft :size="14" /> Back to Services
    </a>

    <p v-if="loading" :style="{ color: muted }">Loading…</p>

    <Card v-if="error" :style="{ borderColor: 'var(--color-danger)', marginBottom: '1rem' }">
      <p :style="{ color: 'var(--color-danger)', margin: 0 }">{{ error }}</p>
    </Card>

    <Card v-if="!loading && !service">
      <p :style="{ color: muted, margin: 0 }">
        Service <code>{{ serviceId }}</code> wasn't found in this tenant.
      </p>
    </Card>

    <template v-if="service">
      <header
        :style="{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
          marginBottom: '1rem',
          flexWrap: 'wrap'
        }"
      >
        <Box :size="22" :style="{ marginTop: '0.4rem' }" />
        <div :style="{ flex: 1, minWidth: '300px' }">
          <h2 :style="{ margin: 0 }">{{ service.name }}</h2>
          <div
            :style="{
              fontSize: '0.85rem',
              color: muted,
              marginTop: '0.2rem',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.6rem',
              alignItems: 'center'
            }"
          >
            <span>{{ service.gitRepoUrl }}</span>
            <span aria-hidden="true">·</span>
            <span>branch {{ service.branch }}</span>
            <span aria-hidden="true">·</span>
            <Badge variant="muted">{{ boundAgents.length }} agent{{ boundAgents.length === 1 ? "" : "s" }}</Badge>
            <Badge :variant="totalContainers > 0 ? 'success' : 'muted'">
              {{ totalContainers }} container{{ totalContainers === 1 ? "" : "s" }} running
            </Badge>
            <Badge
              v-if="service.locked"
              variant="warning"
              :title="'New commits on ' + service.branch + ' do NOT auto-build this service. Use Start build to release.'"
            >🔒 manual-only</Badge>
          </div>
        </div>
        <div v-if="canManage" :style="{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }">
          <Button v-if="!editing" size="sm" variant="ghost" @click="startEdit">
            <Pencil :size="14" /> Edit
          </Button>
          <Button size="sm" variant="ghost" :disabled="saving" @click="fetchAll">
            <RefreshCw :size="14" /> Refresh
          </Button>
          <Button size="sm" variant="ghost" :disabled="editing || saving" @click="handleClone">
            <Copy :size="14" /> Clone
          </Button>
          <Button size="sm" variant="ghost" :disabled="editing || saving" @click="handleDelete">
            <Trash2 :size="14" /> Delete
          </Button>
        </div>
      </header>

      <p
        v-if="actionError"
        :style="{ color: 'var(--color-danger)', marginBottom: '0.75rem', fontSize: '0.85rem' }"
        role="alert"
      >{{ actionError }}</p>

      <!-- Identity / config — read-only summary, or full edit form -->
      <Card title="Identity" :style="{ marginBottom: '1rem' }">
        <form
          v-if="editing"
          :style="{ display: 'grid', gap: '0.5rem' }"
          @submit.prevent="saveEdit"
        >
          <label>
            Name
            <input v-model="form.name" required :style="inputStyle" />
          </label>
          <label>
            Git Repository URL
            <input
              v-model="form.gitRepoUrl"
              required
              placeholder="e.g. git@github.com:acme/app.git"
              :style="inputStyle"
            />
          </label>
          <label>
            SSH Key <span :style="{ color: muted, fontSize: '0.8rem' }">(required if SSH URL)</span>
            <select
              v-model="form.sshKeyId"
              :style="{ ...inputStyle, background: 'var(--color-surface)' }"
            >
              <option value="">— None (HTTPS public) —</option>
              <option v-for="k in sshKeys" :key="k.id" :value="k.id">{{ k.name }}</option>
            </select>
          </label>
          <label>
            Branch
            <input v-model="form.branch" required :style="inputStyle" />
          </label>
          <label>
            Docker Image <span :style="{ color: muted, fontSize: '0.8rem' }">(optional)</span>
            <input
              v-model="form.dockerImage"
              placeholder="e.g. myorg/myapp:latest"
              :style="inputStyle"
            />
          </label>
          <label>
            Compose Path <span :style="{ color: muted, fontSize: '0.8rem' }">(optional)</span>
            <input
              v-model="form.composePath"
              placeholder="e.g. docker-compose.yml"
              :style="inputStyle"
            />
          </label>
          <label>
            Pipeline Name
            <span :style="{ color: muted, fontSize: '0.8rem' }">
              (only when kaiad.yaml is multi-pipeline)
            </span>
            <input
              v-model="form.pipelineName"
              placeholder="e.g. php (matches services.<name> in kaiad.yaml)"
              :style="inputStyle"
            />
          </label>
          <!-- Lock = "manual builds only". The build poller skips
               locked services, so a `git push` to the watched branch
               doesn't auto-enqueue a build. The Start build button
               still works; reconcile still replays the last
               successful build on agent reconnect. -->
          <label
            :style="{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.55rem',
              fontSize: '0.85rem',
              padding: '0.45rem 0.6rem',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              background: 'var(--color-surface)'
            }"
          >
            <input
              type="checkbox"
              v-model="form.locked"
              :style="{ marginTop: '0.15rem' }"
            />
            <span>
              <strong>Lock from auto-build</strong>
              <div :style="{ color: muted, fontSize: '0.78rem', marginTop: '0.1rem' }">
                When on, the build poller ignores new commits on
                <code>{{ form.branch }}</code> for this service.
                Builds only fire when you click <strong>Start build</strong>.
              </div>
            </span>
          </label>
          <fieldset
            :style="{
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.5rem 0.75rem'
            }"
          >
            <legend :style="{ padding: '0 0.4rem', fontSize: '0.8rem', color: muted }">
              Healthcheck <span>(optional; blank path or port = no probe)</span>
            </legend>
            <p :style="{ margin: '0 0 0.4rem', fontSize: '0.78rem', color: muted }">
              When set, the rolling deploy holds the old replica until the new one
              answers <code>GET /&lt;path&gt;:&lt;port&gt;</code> with 2xx — and Service
              traffic only routes to Ready pods. Defaults are reasonable for most
              HTTP services; tune for slow-starting JVM/Python apps.
            </p>
            <div
              :style="{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: '0.5rem 0.75rem',
                fontSize: '0.85rem'
              }"
            >
              <label>
                Path
                <input
                  v-model="form.healthcheckPath"
                  placeholder="/healthz"
                  :style="inputStyle"
                />
              </label>
              <label>
                Port
                <input
                  v-model="form.healthcheckPort"
                  type="number"
                  min="1"
                  max="65535"
                  placeholder="8080"
                  :style="inputStyle"
                />
              </label>
              <label>
                Initial delay (s)
                <input
                  v-model="form.healthcheckInitialDelaySeconds"
                  type="number"
                  min="0"
                  max="600"
                  placeholder="0"
                  :style="inputStyle"
                />
              </label>
              <label>
                Period (s)
                <input
                  v-model="form.healthcheckPeriodSeconds"
                  type="number"
                  min="1"
                  max="600"
                  placeholder="10"
                  :style="inputStyle"
                />
              </label>
              <label>
                Timeout (s)
                <input
                  v-model="form.healthcheckTimeoutSeconds"
                  type="number"
                  min="1"
                  max="120"
                  placeholder="3"
                  :style="inputStyle"
                />
              </label>
              <label>
                Failure threshold
                <input
                  v-model="form.healthcheckFailureThreshold"
                  type="number"
                  min="1"
                  max="60"
                  placeholder="3"
                  :style="inputStyle"
                />
              </label>
              <label>
                Success threshold
                <input
                  v-model="form.healthcheckSuccessThreshold"
                  type="number"
                  min="1"
                  max="10"
                  placeholder="1"
                  :style="inputStyle"
                />
              </label>
            </div>
          </fieldset>

          <fieldset
            :style="{
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.5rem 0.75rem'
            }"
          >
            <legend :style="{ padding: '0 0.4rem', fontSize: '0.8rem', color: muted }">
              Pod securityContext <span>(optional; most common: runAsUser to skip an image's entrypoint chown — fixes the NFS root_squash crash for postgres / mysql / …)</span>
            </legend>
            <div
              :style="{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                gap: '0.5rem 0.75rem',
                fontSize: '0.85rem'
              }"
            >
              <label>
                runAsUser
                <input
                  v-model="form.runAsUser"
                  type="number"
                  min="0"
                  placeholder="e.g. 999 for postgres"
                  :style="inputStyle"
                />
              </label>
              <label>
                runAsGroup
                <input
                  v-model="form.runAsGroup"
                  type="number"
                  min="0"
                  placeholder="(blank = inherit)"
                  :style="inputStyle"
                />
              </label>
              <label>
                fsGroup
                <input
                  v-model="form.fsGroup"
                  type="number"
                  min="0"
                  placeholder="(blank = inherit)"
                  :style="inputStyle"
                />
              </label>
            </div>
          </fieldset>

          <fieldset
            :style="{
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.5rem 0.75rem'
            }"
          >
            <legend :style="{ padding: '0 0.4rem', fontSize: '0.8rem', color: muted }">
              Bound agents <span>(many-to-many; pick zero or more)</span>
            </legend>
            <p
              v-if="agents.length === 0"
              :style="{ margin: 0, color: muted, fontSize: '0.82rem' }"
            >
              No agents enrolled yet. Bind agents after they appear on the Agents page.
            </p>
            <div v-else :style="{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1rem' }">
              <label
                v-for="a in agents"
                :key="a.id"
                :style="{
                  display: 'inline-flex',
                  gap: '0.3rem',
                  alignItems: 'center',
                  fontSize: '0.85rem'
                }"
              >
                <input
                  type="checkbox"
                  :checked="form.agentIds.includes(a.id)"
                  @change="toggleAgentBinding(a.id)"
                />
                {{ a.name?.trim() || a.id }}
              </label>
            </div>
          </fieldset>
          <div :style="{ display: 'flex', gap: '0.4rem' }">
            <Button type="submit" variant="primary" size="sm" :disabled="saving">
              <Check :size="14" /> Save changes
            </Button>
            <Button type="button" variant="ghost" size="sm" :disabled="saving" @click="cancelEdit">
              <X :size="14" /> Cancel
            </Button>
          </div>
        </form>

        <div
          v-else
          :style="{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
            fontSize: '0.85rem'
          }"
        >
          <div>
            <div :style="cellTitle">Branch</div>
            <div :style="cellValue">{{ service.branch }}</div>
          </div>
          <div>
            <div :style="cellTitle">SSH key</div>
            <div :style="cellValue">{{ sshKeyName(service.sshKeyId) }}</div>
          </div>
          <div>
            <div :style="cellTitle">Pipeline name</div>
            <div :style="cellValue">{{ service.pipelineName ?? "default" }}</div>
          </div>
          <div v-if="service.dockerImage">
            <div :style="cellTitle">Docker image</div>
            <div :style="{ ...cellValue, ...monoStyle, fontSize: '0.85rem' }">
              {{ service.dockerImage }}
            </div>
          </div>
          <div v-if="service.composePath">
            <div :style="cellTitle">Compose path</div>
            <div :style="{ ...cellValue, ...monoStyle, fontSize: '0.85rem' }">
              {{ service.composePath }}
            </div>
          </div>
        </div>
      </Card>

      <!-- Healthcheck — explicit so the rolling-deploy behaviour is visible -->
      <Card title="Healthcheck" :style="{ marginBottom: '1rem' }">
        <p
          v-if="!service.healthcheck"
          :style="{ margin: 0, fontSize: '0.85rem', color: muted }"
        >
          No probe configured. The agent still uses a strict rolling
          update (<code>maxUnavailable: 0, maxSurge: 1</code>), but
          without a readiness check the Service starts routing to a
          new pod as soon as the container reports Started — set a
          path + port below to gate on
          <code>GET /&lt;path&gt;:&lt;port&gt;</code> returning 2xx.
        </p>
        <div
          v-else
          :style="{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '1rem',
            fontSize: '0.85rem'
          }"
        >
          <div>
            <div :style="cellTitle">Path</div>
            <div :style="{ ...cellValue, ...monoStyle, fontSize: '0.9rem' }">{{ service.healthcheck.path }}</div>
          </div>
          <div>
            <div :style="cellTitle">Port</div>
            <div :style="cellValue">{{ service.healthcheck.port }}</div>
          </div>
          <div>
            <div :style="cellTitle">Initial delay</div>
            <div :style="cellValue">{{ service.healthcheck.initialDelaySeconds ?? 0 }}s</div>
          </div>
          <div>
            <div :style="cellTitle">Period</div>
            <div :style="cellValue">{{ service.healthcheck.periodSeconds ?? 10 }}s</div>
          </div>
          <div>
            <div :style="cellTitle">Timeout</div>
            <div :style="cellValue">{{ service.healthcheck.timeoutSeconds ?? 3 }}s</div>
          </div>
          <div>
            <div :style="cellTitle">Failure threshold</div>
            <div :style="cellValue">{{ service.healthcheck.failureThreshold ?? 3 }}</div>
          </div>
          <div>
            <div :style="cellTitle">Success threshold</div>
            <div :style="cellValue">{{ service.healthcheck.successThreshold ?? 1 }}</div>
          </div>
        </div>
      </Card>

      <!-- Pod securityContext (explicit visibility — chiefly used to
           skip an entrypoint's chown branch on NFS root_squash mounts) -->
      <Card title="Pod securityContext" :style="{ marginBottom: '1rem' }">
        <p
          v-if="!service.securityContext"
          :style="{ margin: 0, fontSize: '0.85rem', color: muted }"
        >
          No securityContext block rendered. The Pod runs as whatever
          the image's <code>USER</code> directive (or k8s default = root)
          specifies. If your image's entrypoint <code>chown -R</code>s
          its data volume and the volume sits on an NFS export with
          <code>root_squash</code> on, set <code>runAsUser</code> to
          the image's non-root data UID (postgres: <code>999</code>,
          mysql: <code>999</code>) below via <strong>Edit</strong>.
        </p>
        <div
          v-else
          :style="{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '1rem',
            fontSize: '0.85rem'
          }"
        >
          <div v-if="service.securityContext.runAsUser !== undefined">
            <div :style="cellTitle">runAsUser</div>
            <div :style="cellValue">{{ service.securityContext.runAsUser }}</div>
          </div>
          <div v-if="service.securityContext.runAsGroup !== undefined">
            <div :style="cellTitle">runAsGroup</div>
            <div :style="cellValue">{{ service.securityContext.runAsGroup }}</div>
          </div>
          <div v-if="service.securityContext.fsGroup !== undefined">
            <div :style="cellTitle">fsGroup</div>
            <div :style="cellValue">{{ service.securityContext.fsGroup }}</div>
          </div>
        </div>
      </Card>

      <!-- Agents running this service (with their containers) -->
      <Card title="Agents running this service" :style="{ marginBottom: '1rem' }">
        <p
          v-if="boundAgents.length === 0"
          :style="{ margin: 0, fontSize: '0.85rem', color: muted }"
        >
          No agents are bound to this service yet.
          <template v-if="canManage">Use <strong>Edit</strong> above to attach one.</template>
          <template v-else>An administrator needs to bind an agent.</template>
        </p>

        <div
          v-for="row in boundAgents"
          :key="row.agentId"
          :style="{
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            background: 'var(--color-surface)',
            marginBottom: '0.75rem'
          }"
        >
          <div
            :style="{
              display: 'flex',
              alignItems: 'center',
              gap: '0.6rem',
              flexWrap: 'wrap',
              padding: '0.55rem 0.7rem',
              borderBottom: '1px solid var(--color-border)'
            }"
          >
            <Cpu :size="14" :style="{ flexShrink: 0 }" />
            <a
              :href="`#agent/${encodeURIComponent(row.agentId)}`"
              :style="{
                color: 'var(--color-text-primary)',
                textDecoration: 'none',
                fontWeight: 600
              }"
            >{{ row.agent?.name?.trim() || row.agentId }}</a>
            <span v-if="row.agent?.name?.trim()" :style="{ ...monoStyle, color: muted, fontSize: '0.72rem' }">
              {{ row.agentId }}
            </span>
            <Badge :variant="row.websocketConnected ? 'success' : 'muted'">
              {{ row.websocketConnected ? "live" : "offline" }}
            </Badge>
            <Badge
              v-if="row.agent"
              :variant="badgeVariantForStatus(row.agent.status)"
            >{{ row.agent.status }}</Badge>
            <Badge v-if="row.agent" variant="muted">
              runtime: {{ formatRuntimeBackend(row.agent.runtimeBackend) }}
            </Badge>
            <Badge v-if="row.agent" variant="muted">{{ row.agent.environment }}</Badge>
            <span
              v-if="row.agent?.lastSeenAt"
              :style="{ marginLeft: 'auto', fontSize: '0.78rem', color: muted }"
              :title="row.agent.lastSeenAt"
            >
              last seen {{ formatRelativeTime(row.agent.lastSeenAt) }}
            </span>
          </div>

          <div :style="{ padding: '0.6rem 0.7rem' }">
            <p
              v-if="row.containers.length === 0"
              :style="{ margin: 0, fontSize: '0.8rem', color: muted, fontStyle: 'italic' }"
            >
              No containers running for this service on this agent.
            </p>
            <div v-else :style="{ overflowX: 'auto' }">
              <table
                :style="{ width: '100%', borderCollapse: 'collapse', minWidth: '640px' }"
              >
                <thead>
                  <tr>
                    <th :style="thStyle">Container</th>
                    <th :style="thStyle">Image</th>
                    <th :style="thStyle">State</th>
                    <th :style="thStyle">CPU</th>
                    <th :style="thStyle">Memory</th>
                    <th :style="thStyle">Net rx / tx</th>
                    <th :style="thStyle">Sampled</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="app in row.containers" :key="app.containerId">
                    <td :style="tdStyle">
                      <div :style="{ fontWeight: 600 }">
                        {{ app.name ?? app.containerId.slice(0, 12) }}
                      </div>
                      <div :style="{ ...monoStyle, fontSize: '0.7rem', color: muted }">
                        {{ app.containerId.slice(0, 12) }}
                      </div>
                    </td>
                    <td :style="{ ...tdStyle, fontSize: '0.76rem' }" :title="app.image">
                      {{ app.image ? app.image.split("@")[0] : "—" }}
                    </td>
                    <td :style="tdStyle">
                      <Badge :variant="app.state === 'running' ? 'success' : 'muted'">
                        {{ app.state ?? "—" }}
                      </Badge>
                    </td>
                    <td :style="tdStyle">{{ formatPercent(app.cpuPercent) }}</td>
                    <td :style="tdStyle">
                      <template v-if="app.memPercent !== undefined">
                        <div>{{ formatPercent(app.memPercent) }}</div>
                        <div
                          v-if="app.memUsedBytes !== undefined && app.memLimitBytes !== undefined"
                          :style="{ fontSize: '0.7rem', color: muted }"
                        >
                          {{ formatBytes(app.memUsedBytes) }} / {{ formatBytes(app.memLimitBytes) }}
                        </div>
                      </template>
                      <template v-else-if="app.memUsedBytes !== undefined">
                        {{ formatBytes(app.memUsedBytes) }}
                      </template>
                      <template v-else>—</template>
                    </td>
                    <td :style="tdStyle">
                      {{ formatBytesPerSec(app.netRxBytesPerSec) }} /
                      {{ formatBytesPerSec(app.netTxBytesPerSec) }}
                    </td>
                    <td :style="{ ...tdStyle, fontSize: '0.7rem', color: muted }">
                      {{ new Date(app.ts).toLocaleTimeString() }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Card>

      <!-- Builds — full history + manual trigger -->
      <Card title="Builds" :style="{ marginBottom: '1rem' }">
        <BuildsForServiceSection :service-id="service.id" :service-name="service.name" />
      </Card>

      <!-- Pipeline override editor -->
      <Card title="Pipeline" :style="{ marginBottom: '1rem' }">
        <PipelineOverrideEditor :service-id="service.id" :service-name="service.name" />
      </Card>
    </template>
  </section>
</template>
