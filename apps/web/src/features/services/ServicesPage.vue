<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Box, ChevronRight, Cpu, GitBranch, Lock, KeyRound } from "lucide-vue-next";
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
  padding: "0.45rem 0.85rem",
  cursor: "pointer",
  fontSize: "0.85rem",
  fontWeight: 600
};

// Strip a git URL down to "host/owner/repo" for a compact, scannable
// secondary line (full URL stays in the title tooltip).
function shortRepo(url: string): string {
  return url
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/:/, "/")
    .replace(/\.git$/, "");
}
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
      <h2 :style="{ margin: 0, display: 'flex', alignItems: 'baseline', gap: '0.5rem' }">
        Monitored Services
        <span
          v-if="services.length"
          :style="{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--color-text-muted)' }"
        >{{ services.length }}</span>
      </h2>
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
      <strong>Some services have no SSH key.</strong> Services without an SSH key can still be monitored,
      but Kaiad cannot access private repos for them. Open the service and assign an SSH key.
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

    <div v-else :style="{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }">
      <a
        v-for="svc in services"
        :key="svc.id"
        :href="`#service/${encodeURIComponent(svc.id)}`"
        class="svc-row"
      >
        <span class="svc-row__icon"><Box :size="18" /></span>

        <span class="svc-row__main">
          <span class="svc-row__title">
            {{ svc.name }}
            <span v-if="svc.locked" class="svc-chip svc-chip--warn" :title="'Manual builds only — poller ignores new commits on ' + svc.branch">
              <Lock :size="11" /> locked
            </span>
            <span v-if="!svc.sshKeyId" class="svc-chip svc-chip--warn" title="No SSH key assigned — private repos are unreachable">
              <KeyRound :size="11" /> no SSH key
            </span>
          </span>
          <span class="svc-row__sub">
            <span class="svc-mono" :title="svc.gitRepoUrl">{{ shortRepo(svc.gitRepoUrl) }}</span>
            <span class="svc-chip"><GitBranch :size="11" /> {{ svc.branch }}</span>
            <span v-if="svc.pipelineName" class="svc-chip">pipeline: {{ svc.pipelineName }}</span>
          </span>
        </span>

        <span class="svc-row__agents" :title="agentNames(svc.agents) || 'No agents bound'">
          <Cpu :size="13" />
          {{ agentCount(svc) }} agent{{ agentCount(svc) === 1 ? "" : "s" }}
        </span>
        <ChevronRight :size="16" class="svc-row__chev" />
      </a>
    </div>
  </section>
</template>

<style scoped>
.svc-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.7rem 0.85rem;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  text-decoration: none;
  color: var(--color-text);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.05s;
}
.svc-row:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-md);
}
.svc-row:active {
  transform: translateY(1px);
}
.svc-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.1rem;
  height: 2.1rem;
  flex-shrink: 0;
  border-radius: 9px;
  background: var(--color-primary-subtle);
  color: var(--color-primary);
}
.svc-row__main {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
  flex: 1;
}
.svc-row__title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
  font-size: 0.95rem;
}
.svc-row__sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  color: var(--color-text-muted);
  font-size: 0.8rem;
  min-width: 0;
}
.svc-mono {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 22rem;
}
.svc-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 0.72rem;
  font-weight: 500;
  white-space: nowrap;
}
.svc-chip--warn {
  background: var(--color-warning-bg);
  border-color: color-mix(in srgb, var(--color-warning) 35%, transparent);
  color: var(--color-warning);
}
.svc-row__agents {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: 0.82rem;
}
.svc-row__chev {
  flex-shrink: 0;
  color: var(--color-text-muted);
}
</style>
