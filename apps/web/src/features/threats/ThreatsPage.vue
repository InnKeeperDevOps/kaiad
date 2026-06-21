<script setup lang="ts">
// Threat list: source IPs the log sniffer has flagged, with the
// highest severity each one has ever earned, total event count, and
// first/last seen. Click a row to expand into its event timeline
// (drill-down to /api/v1/threat-events?sourceIp=<ip>).
//
// Filters: severity (single select) + IP prefix (typeahead with a
// 300ms debounce). Refresh polls every 15s while the page is open so
// new detections appear without a manual reload.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-vue-next";
import { api, type ThreatEvent, type ThreatIp, type ThreatSeverity } from "../../lib/api.js";
import Card from "../../components/Card.vue";
import Badge from "../../components/Badge.vue";
import Button from "../../components/Button.vue";

type SeverityFilter = ThreatSeverity | "all";
const severityFilter = ref<SeverityFilter>("all");
const ipPrefix = ref("");
const ipPrefixDebounced = ref("");
let prefixTimer: ReturnType<typeof setTimeout> | undefined;
watch(ipPrefix, (v) => {
  if (prefixTimer) clearTimeout(prefixTimer);
  prefixTimer = setTimeout(() => (ipPrefixDebounced.value = v.trim()), 300);
});

const ips = ref<ThreatIp[]>([]);
const total = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const refreshing = ref(false);
const lastLoadedAt = ref<Date | null>(null);

const expandedIp = ref<string | null>(null);
const eventsByIp = ref<Map<string, ThreatEvent[]>>(new Map());
const eventsLoadingIp = ref<string | null>(null);
const eventsErrorIp = ref<string | null>(null);

const PAGE_SIZE = 100;
const offset = ref(0);

async function load(opts: { silent?: boolean } = {}) {
  if (opts.silent) refreshing.value = true;
  else loading.value = true;
  error.value = null;
  try {
    const r = await api.listThreatIps({
      severity: severityFilter.value === "all" ? undefined : severityFilter.value,
      ipPrefix: ipPrefixDebounced.value || undefined,
      limit: PAGE_SIZE,
      offset: offset.value
    });
    ips.value = r.ips;
    total.value = r.total;
    lastLoadedAt.value = new Date();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

onMounted(() => {
  void load();
});
let pollTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  pollTimer = setInterval(() => void load({ silent: true }), 15_000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

watch([severityFilter, ipPrefixDebounced], () => {
  offset.value = 0;
  void load();
});

async function toggleExpand(ip: string) {
  if (expandedIp.value === ip) {
    expandedIp.value = null;
    return;
  }
  expandedIp.value = ip;
  if (!eventsByIp.value.has(ip)) {
    eventsLoadingIp.value = ip;
    eventsErrorIp.value = null;
    try {
      const r = await api.listThreatEvents({ sourceIp: ip, limit: 100 });
      const next = new Map(eventsByIp.value);
      next.set(ip, r.events);
      eventsByIp.value = next;
    } catch (e) {
      eventsErrorIp.value = (e as Error).message;
    } finally {
      eventsLoadingIp.value = null;
    }
  }
}

function nextPage() {
  if (offset.value + PAGE_SIZE >= total.value) return;
  offset.value += PAGE_SIZE;
  void load();
}
function prevPage() {
  if (offset.value === 0) return;
  offset.value = Math.max(0, offset.value - PAGE_SIZE);
  void load();
}

function fmtTs(ts: string | undefined | null): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function relative(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return ts;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const severityVariant: Record<ThreatSeverity, "danger" | "warning" | "info" | "muted"> = {
  critical: "danger",
  high: "danger",
  medium: "warning",
  low: "muted"
};

const hasFilters = computed(
  () => severityFilter.value !== "all" || ipPrefixDebounced.value.length > 0
);
function clearFilters() {
  severityFilter.value = "all";
  ipPrefix.value = "";
  ipPrefixDebounced.value = "";
}
</script>

<template>
  <Card title="Threats" :style="{ marginBottom: '1rem' }">
    <template #actions>
      <div :style="{ display: 'flex', alignItems: 'center', gap: '0.5rem' }">
        <span v-if="lastLoadedAt" class="th-muted" :title="lastLoadedAt.toISOString()">
          updated {{ relative(lastLoadedAt.toISOString()) }}
        </span>
        <Button variant="ghost" size="sm" :loading="refreshing" @click="load({ silent: true })">Refresh</Button>
      </div>
    </template>

    <p class="th-help">
      Source IPs the log sniffer has flagged in service logs. Severity is monotonic per IP — an
      address that ever earned a higher rating keeps it. Click a row for the per-event drill-down.
    </p>

    <div class="th-filters">
      <label class="th-filter">
        <span>Severity</span>
        <select v-model="severityFilter" class="sm-input th-filter__sel">
          <option value="all">All</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </label>
      <label class="th-filter">
        <span>IP prefix</span>
        <input
          v-model="ipPrefix"
          class="sm-input th-filter__sel"
          placeholder="e.g. 192.168."
          spellcheck="false"
        />
      </label>
      <Button v-if="hasFilters" variant="ghost" size="sm" @click="clearFilters">Clear filters</Button>
    </div>

    <p v-if="loading" class="th-muted">Loading…</p>
    <p v-else-if="error" class="th-error">Couldn't load threats: {{ error }}</p>
    <p v-else-if="ips.length === 0" class="th-muted">
      <template v-if="hasFilters">No IPs match the current filter.</template>
      <template v-else>No flagged IPs yet. The sniffer activates as soon as services emit logs containing attack patterns.</template>
    </p>

    <table v-else class="th-table">
      <thead>
        <tr>
          <th></th>
          <th>Source IP</th>
          <th>Severity</th>
          <th>Events</th>
          <th>First seen</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="ip in ips" :key="ip.ipAddress">
          <tr class="th-row" :class="{ 'th-row--open': expandedIp === ip.ipAddress }" @click="toggleExpand(ip.ipAddress)">
            <td class="th-row__chev">
              <component :is="expandedIp === ip.ipAddress ? ChevronDown : ChevronRight" :size="14" />
            </td>
            <td class="th-row__ip">
              <span class="th-ip"><ShieldAlert :size="13" /> {{ ip.ipAddress }}</span>
            </td>
            <td>
              <Badge :variant="severityVariant[ip.severity]">{{ ip.severity }}</Badge>
            </td>
            <td class="th-row__num">{{ ip.eventCount.toLocaleString() }}</td>
            <td :title="ip.firstSeenAt">{{ relative(ip.firstSeenAt) }}</td>
            <td :title="ip.lastSeenAt">{{ relative(ip.lastSeenAt) }}</td>
          </tr>
          <tr v-if="expandedIp === ip.ipAddress" class="th-detail-row">
            <td colspan="6">
              <div class="th-detail">
                <p v-if="eventsLoadingIp === ip.ipAddress" class="th-muted">Loading events…</p>
                <p v-else-if="eventsErrorIp === ip.ipAddress" class="th-error">Couldn't load events.</p>
                <template v-else>
                  <ul class="th-events">
                    <li
                      v-for="ev in (eventsByIp.get(ip.ipAddress) ?? [])"
                      :key="ev.id"
                      class="th-event"
                    >
                      <div class="th-event__head">
                        <Badge :variant="severityVariant[ev.severity]">{{ ev.severity }}</Badge>
                        <code class="th-event__type">{{ ev.attackType }}</code>
                        <span class="th-muted">{{ ev.reason }}</span>
                        <span class="th-muted" :title="ev.ts">{{ relative(ev.ts) }}</span>
                      </div>
                      <pre v-if="ev.message" class="th-event__msg">{{ ev.message }}</pre>
                    </li>
                    <li v-if="(eventsByIp.get(ip.ipAddress) ?? []).length === 0" class="th-muted">
                      No event records for this IP.
                    </li>
                  </ul>
                </template>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div v-if="!loading && !error && total > PAGE_SIZE" class="th-pager">
      <Button variant="ghost" size="sm" :disabled="offset === 0" @click="prevPage">← Prev</Button>
      <span class="th-muted">
        {{ offset + 1 }}–{{ Math.min(offset + ips.length, total) }} of {{ total.toLocaleString() }}
      </span>
      <Button variant="ghost" size="sm" :disabled="offset + PAGE_SIZE >= total" @click="nextPage">Next →</Button>
    </div>
  </Card>
</template>

<style scoped>
.th-help {
  margin: 0 0 0.75rem;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}
.th-muted {
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}
.th-error {
  color: var(--color-danger);
  font-size: 0.88rem;
}
.th-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.85rem;
  margin: 0 0 0.85rem;
}
.th-filter {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}
.th-filter__sel {
  min-width: 9rem;
  font-size: 0.85rem;
  padding: 0.3rem 0.5rem;
}
.th-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.th-table thead th {
  text-align: left;
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
}
.th-row {
  border-top: 1px solid var(--color-border);
  cursor: pointer;
}
.th-row:hover {
  background: var(--color-surface-muted);
}
.th-row--open {
  background: var(--color-surface-muted);
}
.th-row td {
  padding: 0.6rem 0.5rem;
  vertical-align: middle;
}
.th-row__chev {
  width: 1.4rem;
  color: var(--color-text-muted);
  line-height: 0;
}
.th-row__ip {
  font-family: var(--font-mono);
}
.th-ip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  color: var(--color-text);
}
.th-ip > svg {
  color: var(--color-text-muted);
  flex-shrink: 0;
}
.th-row__num {
  font-variant-numeric: tabular-nums;
}
.th-detail-row td {
  padding: 0;
  border-bottom: 1px solid var(--color-border);
}
.th-detail {
  padding: 0.65rem 1rem 0.85rem 2.3rem;
  background: var(--color-surface);
}
.th-events {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.th-event {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px dashed var(--color-border);
}
.th-event:last-child {
  border-bottom: none;
}
.th-event__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  font-size: 0.8rem;
}
.th-event__type {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--color-primary);
}
.th-event__msg {
  margin: 0;
  padding: 0.45rem 0.6rem;
  font-family: var(--font-mono);
  font-size: 0.74rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  max-height: 16rem;
  overflow: auto;
}
.th-pager {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  margin-top: 0.85rem;
  justify-content: flex-end;
}
</style>
