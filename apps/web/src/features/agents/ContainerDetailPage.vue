<script setup lang="ts">
// One page per running container: identity + live resource metrics +
// recent logs. Reached from the per-container rows on the service- and
// agent-detail pages (#container/<agentId>/<containerId>).
//
// Container telemetry comes from the same WS stream the other pages use
// (live.apps[agentId][containerId]); logs are fetched on demand via the
// container-logs endpoint (docker logs / kubectl logs on the agent).
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ArrowLeft, Box, Cpu, RefreshCw } from "lucide-vue-next";
import {
  api,
  type Agent,
  type AgentAppTelemetry,
  type MonitoredService
} from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import Badge from "../../components/Badge.vue";
import Button from "../../components/Button.vue";
import Card from "../../components/Card.vue";
import { useTelemetryStream } from "./useTelemetryStream.js";
import { formatBytes, formatBytesPerSec, formatPercent } from "./format.js";

const props = defineProps<{ agentId: string; containerId: string }>();

const auth = useAuth();
const canReadLogs = computed(() => !auth.value.isViewer);

const live = useTelemetryStream(() => true);

// Static snapshot from the agent's stored apps — fills the gap before
// the first live frame and survives a container that stopped reporting.
const agent = ref<Agent | null>(null);
const services = ref<MonitoredService[]>([]);
const snapshotApps = ref<AgentAppTelemetry[]>([]);
const loading = ref(true);

async function fetchMeta() {
  try {
    const [a, sr] = await Promise.all([
      api.getAgent(props.agentId).catch(() => null),
      api.listServices().catch(() => ({ services: [] as MonitoredService[] }))
    ]);
    agent.value = a;
    snapshotApps.value = a?.apps ?? [];
    services.value = sr.services;
  } finally {
    loading.value = false;
  }
}

// Live frame wins; otherwise fall back to the stored snapshot.
const container = computed<AgentAppTelemetry | null>(() => {
  const liveC = live.apps[props.agentId]?.[props.containerId];
  if (liveC) return liveC;
  return snapshotApps.value.find((c) => c.containerId === props.containerId) ?? null;
});

const containerName = computed(
  () => container.value?.name?.trim() || props.containerId.slice(0, 12)
);
const agentName = computed(() => agent.value?.name?.trim() || props.agentId);
const service = computed<MonitoredService | null>(() => {
  const sid = container.value?.serviceId;
  if (!sid) return null;
  return services.value.find((s) => s.id === sid) ?? null;
});
const running = computed(() => container.value?.state === "running");

function usageColor(pct: number | undefined): string {
  if (pct === undefined) return "var(--color-text)";
  if (pct >= 85) return "var(--color-danger)";
  if (pct >= 65) return "var(--color-warning)";
  return "var(--color-text)";
}

// ── Logs ──────────────────────────────────────────────────────────
const logs = ref<string>("");
const logsLoading = ref(false);
const logsError = ref<string | null>(null);
const tail = ref(200);
const autoRefresh = ref(true);
let logsTimer: ReturnType<typeof setInterval> | null = null;

async function loadLogs() {
  if (!canReadLogs.value) return;
  logsLoading.value = true;
  logsError.value = null;
  try {
    const r = await api.fetchContainerLogs(props.agentId, props.containerId, tail.value);
    logs.value = r.output?.length ? r.output : "(no output)";
  } catch (e: unknown) {
    logsError.value = (e as Error).message;
  } finally {
    logsLoading.value = false;
  }
}

onMounted(() => {
  void fetchMeta();
  void loadLogs();
  // Poll logs every 5s while auto-refresh is on. Each tick dispatches a
  // run_step to the agent, so keep it modest and let the user pause it.
  logsTimer = setInterval(() => {
    if (autoRefresh.value && !logsLoading.value) void loadLogs();
  }, 5000);
});
onUnmounted(() => {
  if (logsTimer) clearInterval(logsTimer);
});
</script>

<template>
  <section :style="{ width: '100%' }">
    <a :href="`#agent/${encodeURIComponent(props.agentId)}`" class="cd-back">
      <ArrowLeft :size="14" /> Back to {{ agentName }}
    </a>

    <header class="cd-head">
      <span class="cd-tile"><Box :size="22" /></span>
      <div :style="{ flex: 1, minWidth: '240px' }">
        <h2 :style="{ margin: 0, fontSize: '1.3rem' }">{{ containerName }}</h2>
        <div class="cd-head__meta">
          <span class="cd-mono" :title="props.containerId">{{ props.containerId.slice(0, 20) }}</span>
          <Badge :variant="running ? 'success' : 'muted'">{{ container?.state ?? "not reported" }}</Badge>
        </div>
      </div>
      <Button v-if="canReadLogs" size="sm" variant="ghost" :disabled="logsLoading" @click="loadLogs">
        <RefreshCw :size="14" /> Refresh logs
      </Button>
    </header>

    <!-- Details -->
    <Card title="Details" :style="{ marginBottom: '1rem' }">
      <div class="cd-grid">
        <div>
          <div class="cd-label">Agent</div>
          <a :href="`#agent/${encodeURIComponent(props.agentId)}`" class="cd-link">
            <Cpu :size="13" /> {{ agentName }}
          </a>
        </div>
        <div>
          <div class="cd-label">Service</div>
          <a
            v-if="service"
            :href="`#service/${encodeURIComponent(service.id)}`"
            class="cd-link"
          ><Box :size="13" /> {{ service.name }}</a>
          <span v-else class="cd-value cd-muted">{{ container?.serviceId ?? "—" }}</span>
        </div>
        <div :style="{ gridColumn: '1 / -1' }">
          <div class="cd-label">Image</div>
          <div class="cd-value cd-mono" :title="container?.image">{{ container?.image ?? "—" }}</div>
        </div>
      </div>
    </Card>

    <!-- Live metrics -->
    <Card title="Resource usage" :style="{ marginBottom: '1rem' }">
      <p v-if="!container" class="cd-muted" :style="{ margin: 0, fontSize: '0.85rem' }">
        No live telemetry for this container right now. It may have stopped or the agent is offline.
      </p>
      <div v-else class="cd-metrics">
        <div>
          <div class="cd-label">CPU</div>
          <div class="cd-metric" :style="{ color: usageColor(container.cpuPercent) }">
            {{ formatPercent(container.cpuPercent) }}
          </div>
        </div>
        <div>
          <div class="cd-label">Memory</div>
          <div class="cd-metric" :style="{ color: usageColor(container.memPercent) }">
            {{ formatPercent(container.memPercent) }}
          </div>
          <div
            v-if="container.memUsedBytes !== undefined && container.memLimitBytes !== undefined"
            class="cd-sub"
          >
            {{ formatBytes(container.memUsedBytes) }} / {{ formatBytes(container.memLimitBytes) }}
          </div>
        </div>
        <div>
          <div class="cd-label">Net RX</div>
          <div class="cd-metric">{{ formatBytesPerSec(container.netRxBytesPerSec) }}</div>
        </div>
        <div>
          <div class="cd-label">Net TX</div>
          <div class="cd-metric">{{ formatBytesPerSec(container.netTxBytesPerSec) }}</div>
        </div>
      </div>
    </Card>

    <!-- Logs -->
    <Card title="Logs">
      <template #actions>
        <div :style="{ display: 'flex', alignItems: 'center', gap: '0.6rem' }">
          <label class="cd-toggle">
            <input v-model="autoRefresh" type="checkbox" :disabled="!canReadLogs" /> auto-refresh
          </label>
          <label class="cd-toggle">
            tail
            <select v-model.number="tail" class="cd-select" :disabled="!canReadLogs" @change="loadLogs">
              <option :value="100">100</option>
              <option :value="200">200</option>
              <option :value="500">500</option>
              <option :value="1000">1000</option>
            </select>
          </label>
        </div>
      </template>

      <p v-if="!canReadLogs" class="cd-muted" :style="{ margin: 0, fontSize: '0.85rem' }">
        Reading container logs requires an owner or admin session.
      </p>
      <template v-else>
        <p v-if="logsError" :style="{ color: 'var(--color-danger)', margin: '0 0 0.5rem', fontSize: '0.85rem' }">
          {{ logsError }}
        </p>
        <p v-if="logsLoading && !logs" class="cd-muted" :style="{ margin: 0, fontSize: '0.85rem' }">
          Fetching logs…
        </p>
        <pre v-else class="cd-logs">{{ logs || "(no output yet)" }}</pre>
      </template>
    </Card>
  </section>
</template>

<style scoped>
.cd-back {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: var(--color-text-secondary);
  text-decoration: none;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}
.cd-back:hover {
  color: var(--color-primary);
}
.cd-head {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}
.cd-tile {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.6rem;
  height: 2.6rem;
  flex-shrink: 0;
  border-radius: 11px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}
.cd-head__meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.45rem;
}
.cd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
}
.cd-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 1rem;
}
.cd-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  color: var(--color-text-muted);
  margin-bottom: 0.3rem;
}
.cd-value {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-text);
  word-break: break-word;
}
.cd-metric {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-text);
}
.cd-sub {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-top: 0.15rem;
}
.cd-muted {
  color: var(--color-text-secondary);
}
.cd-mono {
  font-family: var(--font-mono);
}
.cd-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--color-primary);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.95rem;
}
.cd-link:hover {
  text-decoration: underline;
}
.cd-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}
.cd-select {
  font-size: 0.78rem;
  padding: 0.15rem 0.3rem;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
}
.cd-logs {
  margin: 0;
  padding: 0.6rem 0.75rem;
  background: #0c0c0c;
  color: #e6e6e6;
  border-radius: 8px;
  max-height: 28rem;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 0.76rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
