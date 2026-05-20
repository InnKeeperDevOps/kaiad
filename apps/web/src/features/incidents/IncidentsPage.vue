<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { AlertTriangle, CheckCircle, Clock } from "lucide-vue-next";
import { api, type Incident } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

// Fix-progress step → display label + icon glyph + colour. The glyph is
// inline text (kept dep-free) so the timeline renders even without a
// fresh icon import. ok flag flips ✓/✗.
const fixStepLabel: Record<string, string> = {
  started: "Started",
  cloning: "Cloning repo",
  cli: "Running AI CLI",
  no_changes: "No changes proposed",
  committing: "Committing fix",
  pushing: "Pushing to branch",
  succeeded: "Fix pushed",
  failed: "Fix failed"
};
const fixStatusLabel: Record<string, string> = {
  running: "Running",
  cloning: "Cloning repo…",
  cli: "Running AI CLI…",
  committing: "Committing…",
  pushing: "Pushing…",
  succeeded: "Pushed ✓",
  no_changes: "AI made no changes",
  auth_failed: "Auth failed",
  clone_failed: "Clone failed",
  cli_failed: "AI CLI failed",
  push_failed: "Push failed",
  failed: "Failed"
};
const fixStatusColor: Record<string, string> = {
  running: "var(--color-info, var(--color-primary))",
  cloning: "var(--color-info, var(--color-primary))",
  cli: "var(--color-info, var(--color-primary))",
  committing: "var(--color-info, var(--color-primary))",
  pushing: "var(--color-info, var(--color-primary))",
  succeeded: "var(--color-success)",
  no_changes: "var(--color-warning)",
  auth_failed: "var(--color-danger)",
  clone_failed: "var(--color-danger)",
  cli_failed: "var(--color-danger)",
  push_failed: "var(--color-danger)",
  failed: "var(--color-danger)"
};
function fixGlyph(ev: { step: string; ok?: boolean }): string {
  if (ev.ok === true) return "✓";
  if (ev.ok === false) return "✗";
  return "•";
}
function fixGlyphColor(ev: { step: string; ok?: boolean }): string {
  if (ev.ok === true) return "var(--color-success)";
  if (ev.ok === false) return "var(--color-danger)";
  return "var(--color-text-secondary)";
}
const FIX_RUNNING_STATUSES = new Set(["running", "cloning", "cli", "committing", "pushing"]);

const statusIcon: Record<string, Component> = {
  open: AlertTriangle,
  acknowledged: Clock,
  resolved: CheckCircle,
  closed: CheckCircle
};

const statusColor: Record<string, string> = {
  open: "var(--color-danger)",
  acknowledged: "var(--color-warning)",
  resolved: "var(--color-success)",
  closed: "var(--color-text-secondary)"
};

const incidents = ref<Incident[]>([]);
const error = ref<string | null>(null);
const expandedId = ref<string | null>(null);
const auth = useAuth();
const isViewer = computed(() => auth.value.isViewer);

async function refreshIncidents() {
  try {
    const r = await api.listIncidents();
    incidents.value = r.incidents;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}
onMounted(refreshIncidents);

// While an expanded incident's fix is in-flight, poll every 3s so the
// timeline animates without the user clicking refresh. Stops as soon
// as the fix terminates or the row collapses.
let pollTimer: ReturnType<typeof setInterval> | null = null;
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
watch(expandedId, (id) => {
  stopPoll();
  if (!id) return;
  const tick = () => {
    const inc = incidents.value.find((i) => i.id === id);
    if (inc && (!inc.lastFixStatus || !FIX_RUNNING_STATUSES.has(inc.lastFixStatus))) return;
    void refreshIncidents();
  };
  pollTimer = setInterval(tick, 3000);
});
onUnmounted(stopPoll);

async function handleStatusChange(id: string, status: string) {
  try {
    const updated = await api.updateIncidentStatus(id, status);
    incidents.value = incidents.value.map((i) => (i.id === updated.id ? updated : i));
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

async function handleDelete(id: string) {
  if (!window.confirm("Delete this incident permanently? This cannot be undone.")) return;
  try {
    await api.deleteIncident(id);
    incidents.value = incidents.value.filter((i) => i.id !== id);
    if (expandedId.value === id) expandedId.value = null;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

const headers = computed(() =>
  isViewer.value
    ? ["Status", "Message", "Fingerprint", "Service", "First Seen", "Events"]
    : ["Status", "Message", "Fingerprint", "Service", "First Seen", "Events", "Actions"]
);

function colSpan() {
  return isViewer.value ? 6 : 7;
}

const btnStyle = {
  background: "var(--color-primary)",
  color: "var(--color-primary-foreground)",
  border: "none",
  borderRadius: "6px",
  padding: "0.25rem 0.5rem",
  fontSize: "0.8rem",
  cursor: "pointer"
};
</script>

<template>
  <section>
    <h2 :style="{ margin: '0 0 1rem' }">Incidents</h2>
    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.5rem' }">{{ error }}</div>

    <p v-if="incidents.length === 0" :style="{ color: 'var(--color-text-secondary)' }">
      No incidents recorded yet.
    </p>

    <table v-else :style="{ width: '100%', borderCollapse: 'collapse' }">
      <thead>
        <tr>
          <th
            v-for="h in headers"
            :key="h"
            :style="{
              textAlign: 'left',
              padding: '0.5rem',
              borderBottom: '2px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
              fontSize: '0.8rem'
            }"
          >
            {{ h }}
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="inc in incidents" :key="inc.id">
          <tr :style="{ cursor: 'pointer' }" @click="expandedId = expandedId === inc.id ? null : inc.id">
            <td :style="{ padding: '0.5rem' }">
              <span
                :style="{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  color: statusColor[inc.status]
                }"
              >
                <component :is="statusIcon[inc.status] ?? AlertTriangle" :size="14" />
                {{ inc.status }}
              </span>
            </td>
            <td
              :style="{
                padding: '0.5rem',
                maxWidth: '300px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }"
            >
              {{ inc.message ?? inc.fingerprint.slice(0, 16) }}
            </td>
            <td
              :style="{
                padding: '0.5rem',
                fontSize: '0.8rem',
                fontFamily: 'monospace',
                color: 'var(--color-text-secondary)'
              }"
            >
              {{ inc.fingerprint.slice(0, 12) }}…
            </td>
            <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">{{ inc.serviceId }}</td>
            <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">
              {{ new Date(inc.firstSeenAt).toLocaleString() }}
            </td>
            <td :style="{ padding: '0.5rem', textAlign: 'center' }">{{ inc.eventCount }}</td>
            <td v-if="!isViewer" :style="{ padding: '0.5rem' }" @click.stop>
              <button
                v-if="inc.status === 'open'"
                :style="btnStyle"
                @click="handleStatusChange(inc.id, 'acknowledged')"
              >
                Acknowledge
              </button>
              <button
                v-if="inc.status === 'open' || inc.status === 'acknowledged'"
                :style="{ ...btnStyle, marginLeft: '0.25rem' }"
                @click="handleStatusChange(inc.id, 'resolved')"
              >
                Resolve
              </button>
              <button
                :style="{
                  ...btnStyle,
                  marginLeft: '0.25rem',
                  background: 'transparent',
                  color: 'var(--color-danger)',
                  border: '1px solid var(--color-danger)'
                }"
                title="Delete this incident permanently"
                @click="handleDelete(inc.id)"
              >
                Delete
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === inc.id">
            <td
              :colspan="colSpan()"
              :style="{
                padding: '0.75rem 1rem',
                background: 'var(--color-surface-muted)',
                borderBottom: '2px solid var(--color-border)'
              }"
            >
              <div :style="{ display: 'grid', gap: '0.5rem', fontSize: '0.85rem' }">
                <div>
                  <strong>Fingerprint:</strong>
                  <code :style="{ fontSize: '0.8rem', wordBreak: 'break-all' }">{{ inc.fingerprint }}</code>
                </div>
                <div>
                  <strong>Timeline:</strong>
                  First seen {{ new Date(inc.firstSeenAt).toLocaleString() }} ·
                  Last seen {{ new Date(inc.lastSeenAt).toLocaleString() }} ·
                  {{ inc.eventCount }} event{{ inc.eventCount !== 1 ? "s" : "" }}
                </div>
                <div>
                  <div :style="{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }">
                    <strong>Fix progress:</strong>
                    <span
                      v-if="inc.lastFixStatus"
                      :style="{
                        padding: '0.05rem 0.45rem',
                        borderRadius: '999px',
                        fontSize: '0.72rem',
                        background: fixStatusColor[inc.lastFixStatus] || 'var(--color-text-secondary)',
                        color: '#fff'
                      }"
                    >{{ fixStatusLabel[inc.lastFixStatus] || inc.lastFixStatus }}</span>
                    <span
                      v-if="inc.lastFixExecutor"
                      :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }"
                    >via {{ inc.lastFixExecutor }}</span>
                    <span
                      v-if="inc.lastFixStartedAt"
                      :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }"
                    >started {{ new Date(inc.lastFixStartedAt).toLocaleTimeString() }}</span>
                    <span
                      v-if="inc.lastFixFinishedAt"
                      :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }"
                    >· finished {{ new Date(inc.lastFixFinishedAt).toLocaleTimeString() }}</span>
                    <button
                      :style="{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: '6px', padding: '0.1rem 0.55rem', fontSize: '0.75rem', cursor: 'pointer' }"
                      @click="refreshIncidents"
                    >Refresh</button>
                  </div>
                  <ol
                    v-if="inc.lastFixEvents && inc.lastFixEvents.length"
                    :style="{
                      marginTop: '0.4rem',
                      paddingLeft: 0,
                      listStyle: 'none',
                      display: 'grid',
                      gap: '0.15rem',
                      fontSize: '0.8rem',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
                    }"
                  >
                    <li
                      v-for="(ev, idx) in inc.lastFixEvents"
                      :key="idx"
                      :style="{ display: 'grid', gridTemplateColumns: 'auto auto auto 1fr', columnGap: '0.5rem', rowGap: '0.1rem', alignItems: 'baseline' }"
                    >
                      <span :style="{ color: fixGlyphColor(ev), width: '1ch', textAlign: 'center' }">{{ fixGlyph(ev) }}</span>
                      <span :style="{ color: 'var(--color-text-secondary)', minWidth: '8ch' }">{{ new Date(ev.at).toLocaleTimeString() }}</span>
                      <span :style="{ minWidth: '14ch' }">
                        {{ fixStepLabel[ev.step] || ev.step }}
                        <span
                          v-if="typeof ev.code === 'number'"
                          :style="{ marginLeft: '0.35rem', fontSize: '0.7rem', color: ev.ok === false ? 'var(--color-danger)' : 'var(--color-text-secondary)' }"
                        >exit {{ ev.code }}</span>
                      </span>
                      <span v-if="ev.message" :style="{ color: ev.ok === false ? 'var(--color-danger)' : 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }">— {{ ev.message }}</span>
                      <!-- The actual command + its output, spanning all 4 cols -->
                      <div
                        v-if="ev.cmd || ev.output"
                        :style="{ gridColumn: '2 / span 3', marginTop: '0.05rem' }"
                      >
                        <code
                          v-if="ev.cmd"
                          :style="{ display: 'block', fontSize: '0.72rem', color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }"
                        >$ {{ ev.cmd }}</code>
                        <details v-if="ev.output" :style="{ marginTop: '0.1rem' }">
                          <summary :style="{ cursor: 'pointer', fontSize: '0.72rem', color: 'var(--color-text-secondary)' }">output ({{ ev.output.length }} chars)</summary>
                          <pre
                            :style="{
                              marginTop: '0.2rem',
                              maxHeight: '10rem',
                              overflow: 'auto',
                              background: 'var(--color-bg)',
                              border: '1px solid var(--color-border)',
                              borderRadius: '6px',
                              padding: '0.4rem 0.55rem',
                              fontSize: '0.7rem',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word'
                            }"
                          >{{ ev.output }}</pre>
                        </details>
                      </div>
                    </li>
                  </ol>
                  <p
                    v-else
                    :style="{ color: 'var(--color-text-secondary)', marginTop: '0.3rem', fontSize: '0.8rem' }"
                  >No autonomous fix attempts yet for this incident.</p>
                  <p v-if="inc.lastFixCommitSha" :style="{ marginTop: '0.35rem', fontSize: '0.82rem' }">
                    <strong>Commit:</strong>
                    <code :style="{ marginLeft: '0.4rem' }">{{ inc.lastFixCommitSha.slice(0, 12) }}</code>
                  </p>
                  <details v-if="inc.lastFixOutput" :style="{ marginTop: '0.35rem' }">
                    <summary :style="{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">CLI output (latest)</summary>
                    <pre
                      :style="{
                        marginTop: '0.3rem',
                        maxHeight: '14rem',
                        overflow: 'auto',
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)',
                        borderRadius: '6px',
                        padding: '0.5rem 0.65rem',
                        fontSize: '0.75rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word'
                      }"
                    >{{ inc.lastFixOutput }}</pre>
                  </details>
                </div>
                <div>
                  <strong>Full log:</strong>
                  <pre
                    v-if="inc.fullLog"
                    :style="{
                      marginTop: '0.35rem',
                      maxHeight: '22rem',
                      overflow: 'auto',
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      borderRadius: '6px',
                      padding: '0.6rem 0.75rem',
                      fontSize: '0.78rem',
                      lineHeight: '1.35',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }"
                  >{{ inc.fullLog }}</pre>
                  <span
                    v-else
                    :style="{ color: 'var(--color-text-secondary)', marginLeft: '0.35rem' }"
                  >not captured</span>
                </div>
                <div :style="{ display: 'flex', gap: '1rem' }">
                  <a
                    href="#agents"
                    :style="{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }"
                  >View Agents →</a>
                  <a
                    href="#settings"
                    :style="{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }"
                  >Review GitHub Policy →</a>
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </section>
</template>
