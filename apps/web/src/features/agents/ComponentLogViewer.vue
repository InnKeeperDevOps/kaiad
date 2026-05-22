<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Pause, Play } from "lucide-vue-next";
import { api, type ComponentLogLine } from "../../lib/api.js";

// Live-tailing viewer for a kaiad agent's or operator's OWN process logs.
// Loads a tail on mount, then polls for newer lines by id.
const props = defineProps<{
  kind: "agent" | "operator";
  agentId?: string;
}>();

const POLL_MS = 4000;
const MAX_LINES = 2000;

const lines = ref<ComponentLogLine[]>([]);
const lastId = ref<string | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const paused = ref(false);
const box = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

function fetchPage(afterId?: string): Promise<{ logs: ComponentLogLine[] }> {
  if (props.kind === "agent") {
    if (!props.agentId) return Promise.resolve({ logs: [] });
    return api.fetchAgentLogs(props.agentId, afterId);
  }
  return api.fetchOperatorLogs(afterId);
}

function atBottom(): boolean {
  const el = box.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  if (box.value) box.value.scrollTop = box.value.scrollHeight;
}

async function loadInitial(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const r = await fetchPage();
    lines.value = r.logs;
    lastId.value = r.logs.length ? r.logs[r.logs.length - 1].id : null;
    await scrollToBottom();
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function poll(): Promise<void> {
  if (paused.value) return;
  try {
    const r = await fetchPage(lastId.value ?? undefined);
    if (r.logs.length > 0) {
      const stick = atBottom();
      lines.value = [...lines.value, ...r.logs].slice(-MAX_LINES);
      lastId.value = r.logs[r.logs.length - 1].id;
      if (stick) await scrollToBottom();
    }
  } catch {
    // Transient fetch failure — keep polling; the next tick recovers.
  }
}

onMounted(() => {
  void loadInitial();
  timer = setInterval(() => void poll(), POLL_MS);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
watch(
  () => [props.kind, props.agentId],
  () => {
    lines.value = [];
    lastId.value = null;
    void loadInitial();
  }
);

function levelColor(level: string): string {
  const l = level.toLowerCase();
  if (l === "fatal" || l === "error") return "var(--color-danger)";
  if (l === "warn" || l === "warning") return "var(--color-warning, #b8860b)";
  return "var(--color-text-secondary)";
}
function fmtTs(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}
</script>

<template>
  <div>
    <div
      :style="{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '0.4rem'
      }"
    >
      <span :style="{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }">
        {{ lines.length }} line{{ lines.length === 1 ? "" : "s" }}{{ paused ? " · paused" : " · live" }}
      </span>
      <button
        type="button"
        :style="{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          fontSize: '0.75rem',
          padding: '0.2rem 0.5rem',
          background: 'var(--color-bg, transparent)',
          color: 'var(--color-text-secondary)',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          cursor: 'pointer'
        }"
        @click="paused = !paused"
      >
        <component :is="paused ? Play : Pause" :size="12" />
        {{ paused ? "Resume" : "Pause" }}
      </button>
    </div>

    <p v-if="loading" :style="{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">
      Loading logs…
    </p>
    <p v-else-if="error" :style="{ margin: 0, color: 'var(--color-danger)', fontSize: '0.8rem' }">{{ error }}</p>
    <p
      v-else-if="lines.length === 0"
      :style="{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }"
    >
      No logs yet. The {{ kind }} ships its own process logs here as it runs.
    </p>
    <div
      v-else
      ref="box"
      :style="{
        maxHeight: '420px',
        overflowY: 'auto',
        background: 'var(--color-bg-subtle, #1112)',
        border: '1px solid var(--color-border)',
        borderRadius: '6px',
        padding: '0.5rem 0.6rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.76rem',
        lineHeight: '1.5'
      }"
    >
      <div
        v-for="line in lines"
        :key="line.id"
        :style="{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: 'flex', gap: '0.6rem' }"
      >
        <span :style="{ color: 'var(--color-text-secondary)', flexShrink: 0 }">{{ fmtTs(line.ts) }}</span>
        <span
          :style="{ color: levelColor(line.level), flexShrink: 0, textTransform: 'uppercase', width: '3.2rem' }"
        >{{ line.level }}</span>
        <span :style="{ flex: 1 }">{{ line.message }}</span>
      </div>
    </div>
  </div>
</template>
