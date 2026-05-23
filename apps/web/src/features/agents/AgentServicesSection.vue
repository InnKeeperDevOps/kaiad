<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type CSSProperties } from "vue";
import { api, type AgentAppTelemetry, type MonitoredService } from "../../lib/api.js";
import Badge from "../../components/Badge.vue";
import { formatBytes, formatBytesPerSec, formatPercent } from "./format.js";

// Service-centric view of one agent. Merges three sources the old page
// kept in separate cards:
//   • bound MonitoredService records (attach/detach + repo/branch)
//   • getAgentDetail().services — the per-(service, env) running rollup
//     the agent reports via lb_status (version, instances, usage)
//   • app telemetry — per-container Docker stats, keyed back to a
//     service by AgentAppTelemetry.serviceId
// Each bound service becomes one panel; its containers nest underneath.
const props = defineProps<{
  agentId: string;
  allServices: MonitoredService[];
  apps: AgentAppTelemetry[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ change: [] }>();

type AgentDetail = Awaited<ReturnType<typeof api.getAgentDetail>>;
type DetailService = AgentDetail["services"][number];

const detail = ref<AgentDetail | null>(null);
const detailErr = ref<string | null>(null);
const detailLoading = ref(false);

const pickerValue = ref("");
const busy = ref<string | null>(null); // serviceId mid attach/detach
const error = ref<string | null>(null);

// Logs render in a modal overlay (Teleport'd to <body>); we track the
// service id, the display name for the modal header, and the fetched
// text. closeLogs() is wired to Escape + backdrop click below.
const logsForSvc = ref<string | null>(null);
const logsForSvcName = ref<string>("");
const logsText = ref("");
const logsLoading = ref(false);

function closeLogs() {
  logsForSvc.value = null;
  logsForSvcName.value = "";
  logsText.value = "";
}
function onEscape(e: KeyboardEvent) {
  if (e.key === "Escape" && logsForSvc.value !== null) closeLogs();
}
onMounted(() => window.addEventListener("keydown", onEscape));
onUnmounted(() => window.removeEventListener("keydown", onEscape));

async function loadDetail() {
  detailLoading.value = true;
  detailErr.value = null;
  try {
    detail.value = await api.getAgentDetail(props.agentId);
  } catch (e: unknown) {
    // Non-fatal — panels still render from the bound list + app telemetry.
    detailErr.value = (e as Error).message;
  } finally {
    detailLoading.value = false;
  }
}

onMounted(() => void loadDetail());
watch(
  () => props.agentId,
  () => {
    detail.value = null;
    closeLogs();
    void loadDetail();
  }
);
// Pull a fresh rollup when the parent reports the agent record changed
// (e.g. after a redeploy completes elsewhere).
defineExpose({ refresh: loadDetail });

// Sorted alphabetically by display name so panels keep a stable order
// across refetches (the API's natural order is insertion / id-based and
// reshuffles rows when an agent rebinds).
const byName = (a: MonitoredService, b: MonitoredService) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const bound = computed(() =>
  props.allServices.filter((s) => s.agents?.some((a) => a.agentId === props.agentId)).sort(byName)
);
const unbound = computed(() =>
  props.allServices.filter((s) => !s.agents?.some((a) => a.agentId === props.agentId)).sort(byName)
);
const boundIds = computed(() => new Set(bound.value.map((s) => s.id)));

function runningFor(serviceId: string): DetailService[] {
  return detail.value?.services.filter((s) => s.serviceId === serviceId) ?? [];
}
function appsFor(serviceId: string): AgentAppTelemetry[] {
  return [...props.apps]
    .filter((a) => a.serviceId === serviceId)
    .sort((x, y) => (x.name ?? x.containerId).localeCompare(y.name ?? y.containerId));
}
// Containers the agent reports that we can't attribute to a bound
// service — either no serviceId or a service that isn't bound here.
const orphanApps = computed(() =>
  [...props.apps]
    .filter((a) => !a.serviceId || !boundIds.value.has(a.serviceId))
    .sort((x, y) => (x.name ?? x.containerId).localeCompare(y.name ?? y.containerId))
);
const queuedActions = computed(() => detail.value?.queuedActions ?? []);

function shortSha(ref: string | null): string {
  if (!ref) return "—";
  const colon = ref.lastIndexOf(":");
  const tag = colon >= 0 ? ref.slice(colon + 1) : ref;
  return tag.length > 12 ? tag.slice(0, 12) : tag;
}

async function handleAttach() {
  if (!pickerValue.value) return;
  error.value = null;
  busy.value = pickerValue.value;
  try {
    await api.attachServiceToAgent(props.agentId, pickerValue.value);
    pickerValue.value = "";
    emit("change");
    await loadDetail();
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}
async function handleDetach(serviceId: string) {
  error.value = null;
  busy.value = serviceId;
  try {
    await api.detachServiceFromAgent(props.agentId, serviceId);
    if (logsForSvc.value === serviceId) closeLogs();
    emit("change");
    await loadDetail();
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}
async function openLogs(serviceId: string, serviceName: string) {
  logsForSvc.value = serviceId;
  logsForSvcName.value = serviceName;
  logsText.value = "";
  logsLoading.value = true;
  try {
    const r = await api.fetchServiceLogs(props.agentId, serviceId, 300);
    logsText.value = r.output || "(no output)";
  } catch (e: unknown) {
    logsText.value = `Error: ${(e as Error).message}`;
  } finally {
    logsLoading.value = false;
  }
}

const muted = "var(--color-text-secondary)";
const panelStyle: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  marginBottom: "0.75rem"
};
const panelHeadStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  flexWrap: "wrap",
  padding: "0.55rem 0.7rem",
  borderBottom: "1px solid var(--color-border)"
};
const subhead: CSSProperties = {
  margin: "1rem 0 0.5rem",
  fontSize: "0.85rem",
  color: muted
};
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.35rem 0.5rem",
  borderBottom: "1px solid var(--color-border)",
  color: muted,
  fontSize: "0.72rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em"
};
const tdStyle: CSSProperties = { padding: "0.35rem 0.5rem", fontSize: "0.8rem" };
const monoStyle: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)" };
function btn(variant: "primary" | "muted" | "danger" = "muted"): CSSProperties {
  const base: CSSProperties = {
    border: "1px solid var(--color-border)",
    borderRadius: "4px",
    padding: "0.2rem 0.55rem",
    cursor: "pointer",
    fontSize: "0.78rem"
  };
  if (variant === "primary") {
    return {
      ...base,
      background: "var(--color-primary)",
      color: "var(--color-primary-foreground)",
      borderColor: "var(--color-primary)"
    };
  }
  if (variant === "danger") {
    return { ...base, background: "var(--color-bg)", color: "var(--color-danger)" };
  }
  return { ...base, background: "var(--color-bg)", color: "var(--color-text-primary)" };
}
</script>

<template>
  <section>
    <div
      v-if="error"
      role="alert"
      :style="{ color: 'var(--color-danger)', fontSize: '0.82rem', marginBottom: '0.5rem' }"
    >{{ error }}</div>

    <div
      v-if="queuedActions.length > 0"
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        flexWrap: 'wrap',
        marginBottom: '0.6rem',
        fontSize: '0.8rem'
      }"
    >
      <span :style="{ color: muted }">Queued for delivery:</span>
      <Badge v-for="(qa, i) in queuedActions" :key="i" variant="warning">{{ qa.type }}</Badge>
    </div>

    <p
      v-if="bound.length === 0"
      :style="{ color: muted, fontSize: '0.85rem', margin: '0 0 0.5rem' }"
    >No services bound to this agent. Pick one below to attach.</p>

    <!-- One panel per bound service: rollup + nested containers. -->
    <div v-for="svc in bound" :key="svc.id" :style="panelStyle">
      <div :style="panelHeadStyle">
        <span :style="{ fontWeight: 600, fontSize: '0.92rem' }">{{ svc.name }}</span>
        <span
          :style="{ ...monoStyle, color: muted, fontSize: '0.75rem' }"
          :title="svc.gitRepoUrl"
        >{{ svc.gitRepoUrl }} · {{ svc.branch }}</span>
        <span :style="{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }">
          <button
            type="button"
            :disabled="disabled || logsLoading"
            :title="disabled ? 'Admin/owner only' : 'Fetch recent service logs'"
            :style="{ ...btn(), opacity: disabled ? 0.5 : 1 }"
            @click="openLogs(svc.id, svc.name)"
          >Logs</button>
          <button
            v-if="!disabled"
            type="button"
            :disabled="busy === svc.id"
            :style="btn('danger')"
            @click="handleDetach(svc.id)"
          >{{ busy === svc.id ? "Detaching…" : "Detach" }}</button>
        </span>
      </div>

      <div :style="{ padding: '0.6rem 0.7rem' }">
        <p
          v-if="runningFor(svc.id).length === 0 && appsFor(svc.id).length === 0"
          :style="{ margin: 0, fontSize: '0.8rem', color: muted, fontStyle: 'italic' }"
        >Not running on this agent yet · trigger a build to deploy.</p>

        <!-- Running rollup: one block per (service, environment). -->
        <div
          v-for="r in runningFor(svc.id)"
          :key="`${r.serviceId}-${r.environment}`"
          :style="{ marginBottom: '0.5rem' }"
        >
          <div :style="{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }">
            <Badge variant="muted">{{ r.environment }}</Badge>
            <Badge v-if="r.namespace" variant="muted">ns: {{ r.namespace }}</Badge>
            <Badge variant="info">{{ r.lbType }}</Badge>
            <span v-if="r.externalIp" :style="{ ...monoStyle, fontSize: '0.76rem', color: muted }">
              {{ r.externalIp }}
            </span>
            <span
              :style="{ ...monoStyle, fontSize: '0.76rem' }"
              :title="r.imageRef ?? ''"
            >
              {{ r.gitSha ? r.gitSha.slice(0, 12) : shortSha(r.imageRef) }}
            </span>
            <span v-if="r.buildStatus" :style="{ fontSize: '0.74rem', color: muted }">
              · {{ r.buildStatus }}
            </span>
          </div>
          <div
            :style="{
              display: 'flex',
              gap: '1.1rem',
              flexWrap: 'wrap',
              marginTop: '0.3rem',
              fontSize: '0.78rem'
            }"
          >
            <span><span :style="{ color: muted }">instances</span> {{ r.runningInstances }}</span>
            <span><span :style="{ color: muted }">cpu</span> {{ formatPercent(r.cpuPercent ?? undefined) }}</span>
            <span>
              <span :style="{ color: muted }">mem</span>
              {{ formatBytes(r.memUsedBytes ?? undefined) }}
              <template v-if="r.memPercent != null">({{ formatPercent(r.memPercent) }})</template>
            </span>
            <span>
              <span :style="{ color: muted }">net</span>
              {{ formatBytesPerSec(r.netRxBytesPerSec ?? undefined) }} /
              {{ formatBytesPerSec(r.netTxBytesPerSec ?? undefined) }}
            </span>
          </div>
        </div>

        <!-- Containers attributed to this service (merged Apps view). -->
        <table
          v-if="appsFor(svc.id).length > 0"
          :style="{ width: '100%', borderCollapse: 'collapse', marginTop: '0.4rem' }"
        >
          <thead>
            <tr>
              <th :style="thStyle">Container</th>
              <th :style="thStyle">Image</th>
              <th :style="thStyle">State</th>
              <th :style="thStyle">CPU</th>
              <th :style="thStyle">Memory</th>
              <th :style="thStyle">Net rx / tx</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="app in appsFor(svc.id)" :key="app.containerId">
              <td :style="tdStyle">
                <div :style="{ fontWeight: 600 }">{{ app.name ?? app.containerId.slice(0, 12) }}</div>
                <div :style="{ ...monoStyle, fontSize: '0.68rem', color: muted }">
                  {{ app.containerId.slice(0, 12) }}
                </div>
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.74rem' }" :title="app.image">
                {{ app.image ? app.image.split("@")[0] : "—" }}
              </td>
              <td :style="tdStyle">
                <Badge :variant="app.state === 'running' ? 'success' : 'muted'">
                  {{ app.state ?? "—" }}
                </Badge>
              </td>
              <td :style="tdStyle">{{ formatPercent(app.cpuPercent) }}</td>
              <td :style="tdStyle">
                <template v-if="app.memPercent !== undefined">{{ formatPercent(app.memPercent) }}</template>
                <template v-else-if="app.memUsedBytes !== undefined">{{ formatBytes(app.memUsedBytes) }}</template>
                <template v-else>—</template>
              </td>
              <td :style="tdStyle">
                {{ formatBytesPerSec(app.netRxBytesPerSec) }} / {{ formatBytesPerSec(app.netTxBytesPerSec) }}
              </td>
            </tr>
          </tbody>
        </table>

      </div>
    </div>

    <!-- Attach picker for services not yet bound here. -->
    <div
      v-if="!disabled"
      :style="{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }"
    >
      <select
        v-model="pickerValue"
        aria-label="Pick a service to bind to this agent"
        :disabled="unbound.length === 0"
        :style="{
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          color: 'var(--color-text-primary)',
          borderRadius: '4px',
          padding: '0.25rem 0.45rem',
          fontSize: '0.82rem',
          minWidth: '220px'
        }"
      >
        <option value="">
          {{ unbound.length === 0 ? "All services already bound" : "— bind a service —" }}
        </option>
        <option v-for="svc in unbound" :key="svc.id" :value="svc.id">{{ svc.name }}</option>
      </select>
      <button
        type="button"
        :disabled="!pickerValue || busy !== null"
        :style="btn('primary')"
        @click="handleAttach"
      >+ Bind service</button>
    </div>

    <!-- Containers the agent runs that don't map to a bound service. -->
    <template v-if="orphanApps.length > 0">
      <h4 :style="subhead">Other containers</h4>
      <p :style="{ margin: '0 0 0.4rem', fontSize: '0.78rem', color: muted }">
        Running on this agent but not attributed to a bound service.
      </p>
      <div :style="{ overflowX: 'auto' }">
        <table :style="{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }">
          <thead>
            <tr>
              <th :style="thStyle">Container</th>
              <th :style="thStyle">Image</th>
              <th :style="thStyle">State</th>
              <th :style="thStyle">CPU</th>
              <th :style="thStyle">Memory</th>
              <th :style="thStyle">Net rx / tx</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="app in orphanApps" :key="app.containerId">
              <td :style="tdStyle">
                <div :style="{ fontWeight: 600 }">{{ app.name ?? app.containerId.slice(0, 12) }}</div>
                <div :style="{ ...monoStyle, fontSize: '0.68rem', color: muted }">
                  {{ app.containerId.slice(0, 12) }}
                </div>
              </td>
              <td :style="{ ...tdStyle, fontSize: '0.74rem' }" :title="app.image">
                {{ app.image ? app.image.split("@")[0] : "—" }}
              </td>
              <td :style="tdStyle">
                <Badge :variant="app.state === 'running' ? 'success' : 'muted'">
                  {{ app.state ?? "—" }}
                </Badge>
              </td>
              <td :style="tdStyle">{{ formatPercent(app.cpuPercent) }}</td>
              <td :style="tdStyle">
                <template v-if="app.memPercent !== undefined">{{ formatPercent(app.memPercent) }}</template>
                <template v-else-if="app.memUsedBytes !== undefined">{{ formatBytes(app.memUsedBytes) }}</template>
                <template v-else>—</template>
              </td>
              <td :style="tdStyle">
                {{ formatBytesPerSec(app.netRxBytesPerSec) }} / {{ formatBytesPerSec(app.netTxBytesPerSec) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <p
      v-if="detailErr"
      :style="{ marginTop: '0.5rem', fontSize: '0.76rem', color: muted }"
    >Rollup unavailable ({{ detailErr }}) — versions and usage may be missing.</p>

    <!--
      Logs modal. Teleport'd to <body> so the overlay sits above the
      sidebar and isn't clipped by parent overflow. Backdrop click and
      Escape (wired in setup) both close it. .self stops clicks inside
      the modal box from bubbling to the backdrop handler.
    -->
    <Teleport to="body">
      <div
        v-if="logsForSvc !== null"
        role="dialog"
        aria-modal="true"
        :aria-label="`Logs for ${logsForSvcName}`"
        :style="{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.55)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          zIndex: 1000
        }"
        @click.self="closeLogs"
      >
        <div
          :style="{
            background: 'var(--color-surface)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
            borderRadius: '8px',
            width: 'min(960px, 100%)',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.4)'
          }"
        >
          <header
            :style="{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.7rem 0.9rem',
              borderBottom: '1px solid var(--color-border)'
            }"
          >
            <strong :style="{ fontSize: '0.95rem' }">Logs · {{ logsForSvcName }}</strong>
            <span :style="{ marginLeft: 'auto' }">
              <button
                type="button"
                :style="btn()"
                aria-label="Close logs"
                @click="closeLogs"
              >Close</button>
            </span>
          </header>
          <div v-if="logsLoading" :style="{ padding: '1rem', fontSize: '0.85rem', color: muted }">
            Fetching logs…
          </div>
          <pre
            v-else
            :style="{
              margin: 0,
              flex: 1,
              overflow: 'auto',
              padding: '0.8rem 0.9rem',
              background: 'var(--color-bg)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.78rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: 'var(--color-text)'
            }"
          >{{ logsText }}</pre>
        </div>
      </div>
    </Teleport>
  </section>
</template>
