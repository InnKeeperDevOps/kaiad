<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Box } from "lucide-vue-next";
import { api, type Agent, type AgentBinding, type MonitoredService, type SshKey } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import ServiceWizard from "./ServiceWizard.vue";

// Slim list page: name + repo + branch + agent count. Everything else
// (identity edit, builds, pipeline override, clone/delete, the agents
// that run a service plus their containers) lives on the per-service
// detail page (#service/<id>) — open by clicking a row.
const services = ref<MonitoredService[]>([]);
const sshKeys = ref<SshKey[]>([]);
const agents = ref<Agent[]>([]);
const error = ref<string | null>(null);
const showWizard = ref(false);

const auth = useAuth();
const canManage = computed(() => auth.value.isAdmin);

async function load() {
  try {
    const r = await api.listServices();
    services.value = r.services;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
  try {
    const r = await api.listSshKeys();
    sshKeys.value = r.keys;
  } catch {
    /* ignore */
  }
  try {
    const r = await api.listAgents();
    agents.value = r.agents;
  } catch {
    /* ignore */
  }
}
onMounted(load);

function onWizardCreated(svcs: MonitoredService[]) {
  if (svcs.length === 0) return;
  services.value = [...services.value, ...svcs];
  showWizard.value = false;
  // One service → land on its detail page (where post-create config
  // lives). Multiple → stay on the list so the user can see the whole
  // set at a glance; the new rows are already appended above.
  if (svcs.length === 1) {
    window.location.hash = `service/${encodeURIComponent(svcs[0].id)}`;
  }
}

function agentCount(svc: MonitoredService): number {
  return (svc.agents ?? []).length;
}
// Eagerly stringify bindings → names for tooltip + secondary text.
function agentNames(bindings: AgentBinding[] | undefined): string {
  if (!bindings?.length) return "";
  const byId = new Map(agents.value.map((a) => [a.id, a] as const));
  return bindings
    .map((b) => byId.get(b.agentId)?.name?.trim() || b.agentId)
    .join(", ");
}

const noKey = computed(() => services.value.some((s) => !s.sshKeyId));

const primaryBtn = {
  background: "var(--color-primary)",
  color: "var(--color-primary-foreground)",
  border: "none",
  borderRadius: "8px",
  padding: "0.4rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.85rem"
};
const linkRowStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  color: "var(--color-text-primary)",
  textDecoration: "none",
  fontWeight: 600
};
</script>

<template>
  <section>
    <div
      :style="{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1rem'
      }"
    >
      <h2 :style="{ margin: 0 }">Monitored Services</h2>
      <button
        v-if="canManage"
        :style="primaryBtn"
        @click="showWizard = !showWizard"
      >
        {{ showWizard ? "Cancel" : "Add Service" }}
      </button>
    </div>

    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.5rem' }">{{ error }}</div>

    <div
      v-if="noKey"
      role="status"
      :style="{
        background: 'color-mix(in srgb, var(--color-warning) 12%, var(--color-surface))',
        border: '1px solid var(--color-warning)',
        borderRadius: '8px',
        padding: '0.6rem 0.75rem',
        marginBottom: '1rem',
        fontSize: '0.85rem',
        color: 'var(--color-text-primary)'
      }"
    >
      <strong>Auto-fix is disabled for some services.</strong> Services without an SSH key can still be monitored,
      but Kaiad cannot push fix commits to their repos. Open the service and assign an SSH key to enable the
      automated error → fix loop.
    </div>

    <ServiceWizard
      v-if="canManage && showWizard"
      :agents="agents"
      :ssh-keys="sshKeys"
      @created="onWizardCreated"
      @cancel="showWizard = false"
    />

    <p
      v-if="services.length === 0 && !showWizard"
      :style="{ color: 'var(--color-text-secondary)' }"
    >
      No services configured yet.
    </p>

    <table v-else :style="{ width: '100%', borderCollapse: 'collapse' }">
      <thead>
        <tr>
          <th
            v-for="h in ['Name', 'Repository', 'Branch', 'Agents']"
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
        <tr
          v-for="svc in services"
          :key="svc.id"
          :style="{ borderTop: '1px solid var(--color-border)' }"
        >
          <td :style="{ padding: '0.5rem' }">
            <a :href="`#service/${encodeURIComponent(svc.id)}`" :style="linkRowStyle">
              <Box :size="14" /> {{ svc.name }}
            </a>
            <span
              v-if="svc.locked"
              :title="'Manual builds only — poller ignores new commits on ' + svc.branch"
              :style="{
                marginLeft: '0.4rem',
                fontSize: '0.7rem',
                padding: '0.05rem 0.4rem',
                borderRadius: '999px',
                background: 'color-mix(in srgb, var(--color-warning) 18%, var(--color-surface))',
                color: 'var(--color-warning)',
                border: '1px solid var(--color-warning)',
                verticalAlign: 'middle'
              }"
            >🔒 locked</span>
          </td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">{{ svc.gitRepoUrl }}</td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">{{ svc.branch }}</td>
          <td
            :style="{ padding: '0.5rem', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }"
            :title="agentNames(svc.agents)"
          >
            {{ agentCount(svc) }}
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
