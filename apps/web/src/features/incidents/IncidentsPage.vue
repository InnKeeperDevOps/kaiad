<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from "vue";
import { AlertTriangle, CheckCircle, Clock } from "lucide-vue-next";
import { api, type Incident } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

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

// "Advanced" view — surfaces every field the Incident schema carries
// instead of the curated summary view: full incident IDs and
// fingerprints, exact ISO timestamps.
// Persisted across visits in localStorage so power users don't
// re-toggle every time they open the page.
const ADV_KEY = "kaiad.incidents.advanced";
const showAdvanced = ref<boolean>(
  (() => {
    try {
      return localStorage.getItem(ADV_KEY) === "1";
    } catch {
      return false;
    }
  })()
);
watch(showAdvanced, (v) => {
  try {
    localStorage.setItem(ADV_KEY, v ? "1" : "0");
  } catch {
    /* private mode etc. — best-effort */
  }
});

async function refreshIncidents() {
  try {
    const r = await api.listIncidents();
    incidents.value = r.incidents;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  void refreshIncidents();
});

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
    <div
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        margin: '0 0 1rem'
      }"
    >
      <h2 :style="{ margin: 0 }">Incidents</h2>
      <button
        type="button"
        :title="showAdvanced
          ? 'Hide internal IDs, exact timestamps, raw outputs'
          : 'Show full incident + fingerprint IDs, exact ISO timestamps, auto-opened command output, full commit SHAs'"
        :style="{
          marginLeft: 'auto',
          background: showAdvanced ? 'var(--color-primary)' : 'transparent',
          color: showAdvanced ? 'var(--color-primary-foreground)' : 'var(--color-text-secondary)',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          padding: '0.25rem 0.6rem',
          fontSize: '0.78rem',
          cursor: 'pointer',
          fontFamily: 'inherit'
        }"
        @click="showAdvanced = !showAdvanced"
      >
        {{ showAdvanced ? 'Advanced ✓' : 'Advanced' }}
      </button>
    </div>
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
              :title="showAdvanced ? undefined : inc.fingerprint"
            >
              {{ showAdvanced ? inc.fingerprint : inc.fingerprint.slice(0, 12) + '…' }}
            </td>
            <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">{{ inc.serviceId }}</td>
            <td
              :style="{ padding: '0.5rem', fontSize: '0.85rem' }"
              :title="showAdvanced ? undefined : inc.firstSeenAt"
            >
              {{ showAdvanced ? inc.firstSeenAt : new Date(inc.firstSeenAt).toLocaleString() }}
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
                    <button
                      :style="{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: '6px', padding: '0.1rem 0.55rem', fontSize: '0.75rem', cursor: 'pointer' }"
                      @click="refreshIncidents"
                    >Refresh</button>
                  </div>

                  <!-- Advanced-only metadata strip: raw IDs + ISO
                       timestamps the curated view abbreviates or
                       hides. Lets a power user copy the incident id
                       straight into a curl, paste a fingerprint into
                       SQL, or correlate timing with agent logs. -->
                  <dl
                    v-if="showAdvanced"
                    :style="{
                      marginTop: '0.45rem',
                      marginBottom: '0.2rem',
                      display: 'grid',
                      gridTemplateColumns: 'max-content 1fr',
                      columnGap: '0.6rem',
                      rowGap: '0.15rem',
                      fontSize: '0.74rem',
                      color: 'var(--color-text-secondary)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
                    }"
                  >
                    <dt>incident.id</dt>
                    <dd :style="{ margin: 0, wordBreak: 'break-all' }">{{ inc.id }}</dd>
                    <dt>fingerprint</dt>
                    <dd :style="{ margin: 0, wordBreak: 'break-all' }">{{ inc.fingerprint }}</dd>
                    <dt>firstSeenAt</dt>
                    <dd :style="{ margin: 0 }">{{ inc.firstSeenAt }}</dd>
                    <dt>lastSeenAt</dt>
                    <dd :style="{ margin: 0 }">{{ inc.lastSeenAt }}</dd>
                    <dt>eventCount</dt>
                    <dd :style="{ margin: 0 }">{{ inc.eventCount }}</dd>
                  </dl>
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
