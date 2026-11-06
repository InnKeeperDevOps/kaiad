<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ChevronDown, ChevronRight, Hammer, RefreshCw } from "lucide-vue-next";
import {
  api,
  type BuildSummary,
  type MonitoredService,
  type ServiceBuild,
  type ServiceBuildArtifact
} from "../../lib/api.js";
import Badge from "../../components/Badge.vue";
import Button from "../../components/Button.vue";
import Card from "../../components/Card.vue";
import BuildDetail from "../services/BuildDetail.vue";
import ServiceCombobox from "./ServiceCombobox.vue";
import { formatRelativeTime } from "../agents/format.js";
import {
  BUILD_STATUS_FILTERS,
  BUILD_TRIGGER_FILTERS,
  EMPTY_BUILD_FILTERS,
  badgeVariantForBuildStatus,
  buildFiltersToHash,
  buildFiltersToQuery,
  buildStatusLabel,
  formatBuildDuration,
  hasActiveBuildFilters,
  isBuildInFlight,
  parseBuildFiltersFromHash,
  sameBuildFilters,
  shortImageRef,
  shortSha,
  type BuildsPageFilters
} from "./buildFilters.js";

// Tenant-wide build history across every service. Filters live in the
// hash query string (#builds?serviceId=…&status=…) so a filtered view is
// a shareable link and survives reload; the page re-reads them on
// hashchange so back/forward works too. Mirrors the per-service
// BuildsForServiceSection: expand a row for log + artifacts, 5s silent
// refresh while anything is queued/running.
const PAGE_SIZE = 50;
const MAX_REFRESH_ROWS = 200;

type RowState = {
  build: BuildSummary;
  expanded: boolean;
  detail: { build: ServiceBuild; artifacts: ServiceBuildArtifact[] } | null;
  detailLoading: boolean;
};

const filters = ref<BuildsPageFilters>(parseBuildFiltersFromHash(window.location.hash));
const services = ref<MonitoredService[]>([]);
const rows = ref<RowState[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const refreshing = ref(false);
const error = ref<string | null>(null);
const autoRefresh = ref(true);
// Bumped by the refresh tick so "Xs ago" / running durations re-render
// without each cell owning a timer.
const now = ref(Date.now());

let refreshTimer: ReturnType<typeof setInterval> | null = null;

const hasInFlight = computed(() => rows.value.some((r) => isBuildInFlight(r.build)));
const activeFilters = computed(() => hasActiveBuildFilters(filters.value));

async function loadServices() {
  try {
    const r = await api.listServices();
    services.value = r.services;
  } catch (e: unknown) {
    console.error("[builds] listServices failed", e);
    error.value = (e as Error).message;
  }
}

function freshRow(b: BuildSummary, prev?: RowState): RowState {
  return {
    build: b,
    expanded: prev?.expanded ?? false,
    detail: prev?.detail ?? null,
    detailLoading: false
  };
}

/** (Re)load the first page. A silent refresh re-fetches everything currently visible. */
async function load(opts: { silent?: boolean } = {}) {
  if (opts.silent) refreshing.value = true;
  else loading.value = true;
  error.value = null;
  const limit = opts.silent
    ? Math.min(Math.max(rows.value.length, PAGE_SIZE), MAX_REFRESH_ROWS)
    : PAGE_SIZE;
  try {
    const r = await api.listBuilds({ ...buildFiltersToQuery(filters.value), limit });
    const prev = new Map(rows.value.map((row) => [row.build.id, row] as const));
    rows.value = r.builds.map((b) => freshRow(b, prev.get(b.id)));
    nextCursor.value = r.nextCursor;
    now.value = Date.now();
    // Expanded rows whose build is still running have growing logs;
    // re-fetch them so the log pane stays live.
    for (const row of rows.value) {
      if (row.expanded && (row.detail === null || isBuildInFlight(row.build))) {
        void loadDetail(row);
      }
    }
  } catch (e: unknown) {
    console.error("[builds] listBuilds failed", { filters: filters.value, err: e });
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function loadMore() {
  const cursor = nextCursor.value;
  if (!cursor || loadingMore.value) return;
  loadingMore.value = true;
  error.value = null;
  try {
    const r = await api.listBuilds({ ...buildFiltersToQuery(filters.value), limit: PAGE_SIZE, cursor });
    const seen = new Set(rows.value.map((row) => row.build.id));
    rows.value = [...rows.value, ...r.builds.filter((b) => !seen.has(b.id)).map((b) => freshRow(b))];
    nextCursor.value = r.nextCursor;
  } catch (e: unknown) {
    console.error("[builds] listBuilds (load more) failed", { cursor, err: e });
    error.value = (e as Error).message;
  } finally {
    loadingMore.value = false;
  }
}

async function loadDetail(row: RowState) {
  row.detailLoading = true;
  try {
    const r = await api.getServiceBuild(row.build.serviceId, row.build.id);
    row.detail = r;
    // Keep the summary row in sync with the fresher detail (status,
    // finishedAt, imageRef) without dropping the joined serviceName.
    const { log: _log, pipelineYaml: _pipelineYaml, ...summary } = r.build;
    row.build = { ...summary, serviceName: row.build.serviceName };
  } catch (e: unknown) {
    console.error("[builds] getServiceBuild failed", { serviceId: row.build.serviceId, buildId: row.build.id, err: e });
    error.value = (e as Error).message;
  } finally {
    row.detailLoading = false;
  }
}

function toggle(row: RowState) {
  row.expanded = !row.expanded;
  if (row.expanded && row.detail === null) void loadDetail(row);
}

function applyFilters(patch: Partial<BuildsPageFilters>) {
  const next = { ...filters.value, ...patch };
  if (sameBuildFilters(next, filters.value)) return;
  filters.value = next;
  const hash = buildFiltersToHash(next);
  if (window.location.hash.replace(/^#/, "") !== hash) {
    // Triggers onHashChange, which sees identical filters and does not reload.
    window.location.hash = hash;
  }
  void load();
}

function clearFilters() {
  applyFilters({ ...EMPTY_BUILD_FILTERS });
}

function onHashChange() {
  const parsed = parseBuildFiltersFromHash(window.location.hash);
  if (sameBuildFilters(parsed, filters.value)) return;
  filters.value = parsed;
  void load();
}

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function serviceHref(serviceId: string): string {
  return `#service/${encodeURIComponent(serviceId)}`;
}

onMounted(() => {
  void loadServices();
  void load();
  window.addEventListener("hashchange", onHashChange);
  refreshTimer = setInterval(() => {
    now.value = Date.now();
    if (!autoRefresh.value) return;
    if (hasInFlight.value) void load({ silent: true });
  }, 5000);
});

onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <section>
    <div class="builds-head">
      <h2 class="builds-title">
        <Hammer :size="18" />
        Builds
        <span v-if="!loading && rows.length" class="builds-count">{{ rows.length }}{{ nextCursor ? "+" : "" }}</span>
      </h2>
      <div class="builds-head__actions">
        <label class="builds-auto" :title="'Re-fetch every 5s while a build is queued or running'">
          <input v-model="autoRefresh" type="checkbox" />
          Auto-refresh
          <span v-if="autoRefresh && hasInFlight" class="builds-live" aria-label="live" />
        </label>
        <Button variant="secondary" size="sm" :disabled="refreshing || loading" @click="load({ silent: true })">
          <RefreshCw :size="12" :class="refreshing ? 'spin' : ''" /> Refresh
        </Button>
      </div>
    </div>

    <Card :style="{ marginBottom: '1rem' }">
      <div class="builds-filters">
        <div class="builds-filter">
          <label for="builds-filter-service" class="builds-filter__label">Service</label>
          <ServiceCombobox
            input-id="builds-filter-service"
            :services="services"
            :model-value="filters.serviceId"
            @update:model-value="(v: string) => applyFilters({ serviceId: v })"
          />
        </div>
        <div class="builds-filter">
          <label for="builds-filter-status" class="builds-filter__label">Status</label>
          <select
            id="builds-filter-status"
            class="builds-select"
            :value="filters.status"
            @change="applyFilters({ status: ($event.target as HTMLSelectElement).value as BuildsPageFilters['status'] })"
          >
            <option value="">Any status</option>
            <option v-for="s in BUILD_STATUS_FILTERS" :key="s" :value="s">{{ buildStatusLabel(s) }}</option>
          </select>
        </div>
        <div class="builds-filter">
          <label for="builds-filter-trigger" class="builds-filter__label">Trigger</label>
          <select
            id="builds-filter-trigger"
            class="builds-select"
            :value="filters.triggeredBy"
            @change="applyFilters({ triggeredBy: ($event.target as HTMLSelectElement).value as BuildsPageFilters['triggeredBy'] })"
          >
            <option value="">Any trigger</option>
            <option v-for="t in BUILD_TRIGGER_FILTERS" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <Button v-if="activeFilters" variant="ghost" size="sm" @click="clearFilters">Clear filters</Button>
      </div>
    </Card>

    <p v-if="error" role="alert" class="builds-error">{{ error }}</p>

    <Card>
      <p v-if="loading" class="builds-muted">Loading…</p>
      <p v-else-if="rows.length === 0" class="builds-muted">
        <template v-if="activeFilters">No builds match these filters.</template>
        <template v-else>
          No builds yet. The poller checks each service's watched branch every 60s and queues a build when
          the SHA changes; you can also start one from a service page.
        </template>
      </p>

      <table v-else class="sm-table builds-table">
        <thead>
          <tr>
            <th></th>
            <th>Status</th>
            <th>Service</th>
            <th>SHA</th>
            <th>Branch</th>
            <th>Trigger</th>
            <th>Created</th>
            <th>Duration</th>
            <th>Image</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.build.id">
            <tr
              class="build-row"
              :aria-expanded="row.expanded"
              @click="toggle(row)"
            >
              <td class="build-row__chev">
                <component :is="row.expanded ? ChevronDown : ChevronRight" :size="13" />
              </td>
              <td>
                <Badge :variant="badgeVariantForBuildStatus(row.build.status)">
                  {{ buildStatusLabel(row.build.status) }}
                </Badge>
              </td>
              <td>
                <a
                  :href="serviceHref(row.build.serviceId)"
                  class="build-row__service"
                  :title="`Open ${row.build.serviceName}`"
                  @click.stop
                >{{ row.build.serviceName }}</a>
              </td>
              <td class="mono" :title="row.build.gitSha">{{ shortSha(row.build.gitSha) }}</td>
              <td>{{ row.build.branch }}</td>
              <td>
                <span
                  v-if="row.build.triggeredBy === 'manual'"
                  class="build-chip"
                  title="Triggered manually from the panel"
                >manual</span>
                <span v-else class="build-row__muted" title="Queued by the commit poller">poll</span>
              </td>
              <td class="build-row__muted" :title="absoluteTime(row.build.createdAt)">
                {{ formatRelativeTime(row.build.createdAt) }}
              </td>
              <td>{{ formatBuildDuration(row.build, now) }}</td>
              <td class="mono build-row__muted" :title="row.build.imageRef ?? ''">
                {{ shortImageRef(row.build.imageRef) }}
              </td>
            </tr>
            <tr v-if="row.expanded" class="build-row__detail">
              <td colspan="9" :style="{ padding: '0.5rem 0.5rem 0.75rem 1.5rem' }">
                <BuildDetail
                  :service-id="row.build.serviceId"
                  :detail="row.detail"
                  :loading="row.detailLoading"
                  @error="(m: string) => (error = m)"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <div v-if="!loading && rows.length > 0" class="builds-foot">
        <span class="builds-muted">Showing {{ rows.length }} build{{ rows.length === 1 ? "" : "s" }}</span>
        <Button v-if="nextCursor" variant="secondary" size="sm" :loading="loadingMore" @click="loadMore">
          Load more
        </Button>
      </div>
    </Card>
  </section>
</template>

<style scoped>
.builds-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.builds-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.builds-count {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--color-text-muted);
}
.builds-head__actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.builds-auto {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.82rem;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.builds-live {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-info);
  animation: pulse 1.2s ease-in-out infinite;
}
.builds-filters {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.builds-filter {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.builds-filter__label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--color-text-secondary);
}
.builds-select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border-strong);
  border-radius: 8px;
  font-size: 0.85rem;
  background: var(--color-surface);
  color: var(--color-text);
  font-family: inherit;
.builds-table {
  font-size: 0.85rem;
}
.builds-table td,
.builds-table th {
  white-space: nowrap;
}
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-subtle);
  outline: none;
}
.builds-error {
  margin: 0 0 0.75rem;
  color: var(--color-danger);
  font-size: 0.85rem;
}
.builds-muted {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}
.builds-table {
  font-size: 0.85rem;
}
.builds-table th:first-child,
.build-row__chev {
  width: 1.5rem;
}
.build-row {
  cursor: pointer;
  transition: background 0.1s;
}
.build-row:hover {
  background: var(--color-surface-muted);
}
.build-row__chev {
  color: var(--color-text-muted);
}
.build-row__service {
  color: var(--color-link);
  font-weight: 600;
  text-decoration: none;
}
.build-row__service:hover {
  text-decoration: underline;
}
.build-row__muted {
  color: var(--color-text-secondary);
}
.build-row__detail > td {
  border-bottom: 1px solid var(--color-border);
}
.mono {
  font-family: var(--font-mono);
}
.build-chip {
  font-size: 0.68rem;
  padding: 0.05rem 0.4rem;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-secondary);
}
.builds-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 0.75rem;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
