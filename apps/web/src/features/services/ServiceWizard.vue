<script setup lang="ts">
// Guided multi-step "Add service" flow. Used only for creation; editing
// keeps the inline form on the per-service detail page.
//
// New: after the Repository step we shallow-clone the repo, read its
// kaiad.yaml, and either confirm the single-pipeline shape or
// enumerate every pipeline in a multi-service repo. For multi, the
// name typed in step 1 becomes a PREFIX — each pipeline becomes its
// own MonitoredService named `<prefix>-<pipelineName>`. Emits the
// created services back to the parent so it can append them all to
// the list and navigate to the right place.
import { reactive, ref, computed } from "vue";
import { api, type Agent, type MonitoredService, type SshKey } from "../../lib/api.js";
import Card from "../../components/Card.vue";
import Button from "../../components/Button.vue";

const props = defineProps<{ agents: Agent[]; sshKeys: SshKey[] }>();
const emit = defineEmits<{ created: [svcs: MonitoredService[]]; cancel: [] }>();

const STEPS = ["Repository", "Pipeline", "Agents", "Review"] as const;
const step = ref(0);
const submitting = ref(false);
const error = ref<string | null>(null);

const form = reactive({
  name: "",
  gitRepoUrl: "",
  branch: "main",
  sshKeyId: "",
  // Where kaiad.yaml lives inside the repo. Default is the root; users
  // with a non-default layout (deploy/, infra/, etc.) override here.
  // The preview endpoint reads from this path, and it's persisted on
  // the MonitoredService row so the build worker uses it too.
  kaiadYamlPath: "kaiad.yaml",
  // Manual fallback pipeline name when preview fails / user overrides.
  pipelineName: "",
  dockerImage: "",
  composePath: "",
  agentIds: [] as string[]
});
const showAdvanced = ref(false);

// ─── Pipeline preview state ─────────────────────────────────────────
type Preview =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "single" }
  | { state: "multi"; pipelineNames: string[] }
  | { state: "failed"; reason: string };
const preview = ref<Preview>({ state: "idle" });
// For multi-pipeline repos, the user can opt out of individual entries
// — but by default every one we found is checked.
const selectedPipelines = ref<Set<string>>(new Set());

async function loadPreview(): Promise<void> {
  preview.value = { state: "loading" };
  try {
    const res = await api.previewPipeline({
      gitRepoUrl: form.gitRepoUrl.trim(),
      branch: form.branch.trim() || "main",
      sshKeyId: form.sshKeyId || null,
      kaiadYamlPath: form.kaiadYamlPath.trim() || undefined
    });
    if (!res.parse.ok) {
      preview.value = { state: "failed", reason: res.parse.reason };
      return;
    }
    if (res.parse.kind === "single") {
      preview.value = { state: "single" };
      return;
    }
    // multi: pre-select every pipeline; user can untick.
    selectedPipelines.value = new Set(res.parse.pipelineNames);
    preview.value = { state: "multi", pipelineNames: res.parse.pipelineNames };
  } catch (e) {
    // Network / 401 / 5xx — surface the message but let the user
    // proceed anyway (they can still type a pipeline name manually).
    preview.value = { state: "failed", reason: (e as Error).message };
  }
}

function togglePipelineSelection(name: string): void {
  const next = new Set(selectedPipelines.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selectedPipelines.value = next;
}

// Names the wizard will actually create. Drives the Review step and
// the create() loop. For single pipeline → just the prefix. For multi
// → `<prefix>-<pipelineName>` per selected pipeline. The manual
// `pipelineName` field is the escape hatch for parse failures.
const servicesToCreate = computed<{ name: string; pipelineName: string | null }[]>(() => {
  const prefix = form.name.trim();
  if (preview.value.state === "multi") {
    return preview.value.pipelineNames
      .filter((p) => selectedPipelines.value.has(p))
      .map((p) => ({ name: `${prefix}-${p}`, pipelineName: p }));
  }
  // Single pipeline → one service, optional manual pipeline name.
  return [
    {
      name: prefix,
      pipelineName: form.pipelineName.trim() || null
    }
  ];
});

const step1Valid = computed(
  () => form.name.trim() !== "" && form.gitRepoUrl.trim() !== "" && form.branch.trim() !== ""
);
const canNext = computed(() => {
  if (step.value === 0) return step1Valid.value;
  // Pipeline step: at least one service must be selected (for multi),
  // or single-pipeline result, or user proceeding past a parse failure.
  if (step.value === 1) {
    if (preview.value.state === "loading") return false;
    if (preview.value.state === "multi") return selectedPipelines.value.size > 0;
    return true;
  }
  return true;
});

function toggleAgent(id: string) {
  form.agentIds = form.agentIds.includes(id)
    ? form.agentIds.filter((a) => a !== id)
    : [...form.agentIds, id];
}
async function next() {
  if (step.value < STEPS.length - 1 && canNext.value) {
    // Kick the preview off the moment the user leaves the Repository
    // step. Step 2 reads from `preview.value` and renders accordingly.
    if (step.value === 0 && preview.value.state === "idle") {
      step.value++;
      await loadPreview();
      return;
    }
    step.value++;
  }
}
function back() {
  if (step.value > 0) step.value--;
}

async function create() {
  submitting.value = true;
  error.value = null;
  const created: MonitoredService[] = [];
  try {
    // Sequential create — keeps the error story simple if one fails
    // (the user sees the partial set in the parent's list and can
    // retry just the missing ones). Same agentIds on each: a multi-
    // service repo's pipelines almost always co-deploy on the same
    // agents; user can detach later per-service if needed.
    for (const s of servicesToCreate.value) {
      const svc = await api.createService({
        name: s.name,
        gitRepoUrl: form.gitRepoUrl.trim(),
        sshKeyId: form.sshKeyId || undefined,
        branch: form.branch.trim(),
        dockerImage: form.dockerImage.trim() || undefined,
        composePath: form.composePath.trim() || undefined,
        pipelineName: s.pipelineName ?? undefined,
        kaiadYamlPath: form.kaiadYamlPath.trim() || undefined,
        agentIds: form.agentIds
      });
      created.push(svc);
    }
    emit("created", created);
  } catch (e) {
    error.value = (e as Error).message;
    // If we got partway through, still tell the parent what landed.
    if (created.length > 0) emit("created", created);
  } finally {
    submitting.value = false;
  }
}

const agentName = (a: Agent) => a.name?.trim() || a.id;
</script>

<template>
  <Card title="Add a service" :style="{ marginBottom: '1rem' }">
    <template #actions>
      <Button variant="ghost" size="sm" @click="emit('cancel')">Cancel</Button>
    </template>

    <!-- Stepper -->
    <ol class="wz-steps">
      <li
        v-for="(s, i) in STEPS"
        :key="s"
        class="wz-step"
        :class="{ 'wz-step--active': i === step, 'wz-step--done': i < step }"
      >
        <span class="wz-step__dot">{{ i < step ? '✓' : i + 1 }}</span>
        <span class="wz-step__label">{{ s }}</span>
      </li>
    </ol>

    <p v-if="error" class="sm-input-error wz-error">{{ error }}</p>

    <!-- Step 1: Repository -->
    <div v-show="step === 0" class="wz-body">
      <div class="sm-input-wrapper">
        <label class="sm-input-label">
          Service name <span class="wz-hint">becomes a prefix when kaiad.yaml is multi-service</span>
        </label>
        <input class="sm-input" v-model="form.name" placeholder="e.g. mcbans" />
      </div>
      <div class="sm-input-wrapper">
        <label class="sm-input-label">Git repository URL</label>
        <input class="sm-input" v-model="form.gitRepoUrl" placeholder="git@github.com:acme/app.git" />
      </div>
      <div class="wz-grid">
        <div class="sm-input-wrapper">
          <label class="sm-input-label">Branch</label>
          <input class="sm-input" v-model="form.branch" placeholder="main" />
        </div>
        <div class="sm-input-wrapper">
          <label class="sm-input-label">
            SSH key <span class="wz-hint">required for private / SSH URLs</span>
          </label>
          <select class="sm-input" v-model="form.sshKeyId">
            <option value="">— None (public HTTPS) —</option>
            <option v-for="k in props.sshKeys" :key="k.id" :value="k.id">{{ k.name }}</option>
          </select>
        </div>
      </div>
      <div class="sm-input-wrapper">
        <label class="sm-input-label">
          Kaiad config path
          <span class="wz-hint">repo-relative; default is <code>kaiad.yaml</code> at the root</span>
        </label>
        <input
          class="sm-input"
          v-model="form.kaiadYamlPath"
          list="wz-kaiad-paths"
          placeholder="kaiad.yaml"
          spellcheck="false"
        />
        <datalist id="wz-kaiad-paths">
          <option value="kaiad.yaml" />
          <option value="deploy/kaiad.yaml" />
          <option value="infra/kaiad.yaml" />
          <option value=".kaiad/kaiad.yaml" />
        </datalist>
      </div>
    </div>

    <!-- Step 2: Pipeline -->
    <div v-show="step === 1" class="wz-body">
      <p class="wz-muted">
        Kaiad builds &amp; deploys from the repo's <code>kaiad.yaml</code>. You can edit or
        override it later from each service's <strong>Pipeline</strong> panel.
      </p>

      <div v-if="preview.state === 'loading'" class="wz-preview wz-preview--loading">
        Reading <code>{{ form.kaiadYamlPath.trim() || 'kaiad.yaml' }}</code> from <code>{{ form.branch }}</code>…
      </div>

      <div v-else-if="preview.state === 'single'" class="wz-preview wz-preview--ok">
        <strong>Detected:</strong> single-pipeline <code>kaiad.yaml</code>.
        Will create one service named <code>{{ form.name }}</code>.
        <div class="sm-input-wrapper wz-preview__sub">
          <label class="sm-input-label">
            Pipeline name <span class="wz-hint">optional; only set if your kaiad.yaml's pipeline isn't named for the default</span>
          </label>
          <input class="sm-input" v-model="form.pipelineName" placeholder="(blank — single-pipeline default)" />
        </div>
      </div>

      <div v-else-if="preview.state === 'multi'" class="wz-preview wz-preview--ok">
        <strong>Detected:</strong> multi-service <code>kaiad.yaml</code> with
        {{ preview.pipelineNames.length }} pipeline{{ preview.pipelineNames.length === 1 ? '' : 's' }}.
        Tick the ones you want; each becomes its own monitored service
        named <code>&lt;prefix&gt;-&lt;pipeline&gt;</code>.
        <ul class="wz-pipelines">
          <li v-for="p in preview.pipelineNames" :key="p">
            <label class="wz-pipeline">
              <input
                type="checkbox"
                :checked="selectedPipelines.has(p)"
                @change="togglePipelineSelection(p)"
              />
              <span class="wz-pipeline__src">{{ p }}</span>
              <span class="wz-pipeline__arrow">→</span>
              <code class="wz-pipeline__name">{{ form.name }}-{{ p }}</code>
            </label>
          </li>
        </ul>
      </div>

      <div v-else-if="preview.state === 'failed'" class="wz-preview wz-preview--warn">
        <strong>Couldn't read kaiad.yaml:</strong> {{ preview.reason }}.
        You can still proceed — kaiad will pick the pipeline up on the next build.
        <div class="sm-input-wrapper wz-preview__sub">
          <label class="sm-input-label">
            Pipeline name <span class="wz-hint">only if kaiad.yaml is multi-service</span>
          </label>
          <input class="sm-input" v-model="form.pipelineName" placeholder="e.g. php — matches services.&lt;name&gt;" />
        </div>
        <Button variant="ghost" size="sm" @click="loadPreview">Retry preview</Button>
      </div>

      <Button variant="ghost" size="sm" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? '− Hide advanced' : '+ Advanced (legacy image / compose)' }}
      </Button>
      <div v-show="showAdvanced" class="wz-grid">
        <div class="sm-input-wrapper">
          <label class="sm-input-label">Docker image <span class="wz-hint">optional</span></label>
          <input class="sm-input" v-model="form.dockerImage" placeholder="myorg/myapp:latest" />
        </div>
        <div class="sm-input-wrapper">
          <label class="sm-input-label">Compose path <span class="wz-hint">optional</span></label>
          <input class="sm-input" v-model="form.composePath" placeholder="docker-compose.yml" />
        </div>
      </div>
    </div>

    <!-- Step 3: Agents -->
    <div v-show="step === 2" class="wz-body">
      <p class="wz-muted">Bind zero or more agents now — the same set is applied to every service this wizard creates. You can change bindings any time.</p>
      <p v-if="props.agents.length === 0" class="wz-muted">
        No agents enrolled yet. Enroll one from the Agents page; you can bind it later.
      </p>
      <div v-else class="wz-agents">
        <label v-for="a in props.agents" :key="a.id" class="wz-agent">
          <input type="checkbox" :checked="form.agentIds.includes(a.id)" @change="toggleAgent(a.id)" />
          {{ agentName(a) }}
        </label>
      </div>
    </div>

    <!-- Step 4: Review -->
    <div v-show="step === 3" class="wz-body">
      <dl class="wz-review">
        <div><dt>Repository</dt><dd>{{ form.gitRepoUrl }}</dd></div>
        <div><dt>Branch</dt><dd>{{ form.branch }}</dd></div>
        <div><dt>SSH key</dt><dd>{{ props.sshKeys.find(k => k.id === form.sshKeyId)?.name || 'none (public HTTPS)' }}</dd></div>
        <div v-if="form.kaiadYamlPath.trim() && form.kaiadYamlPath.trim() !== 'kaiad.yaml'">
          <dt>Kaiad config path</dt><dd><code>{{ form.kaiadYamlPath.trim() }}</code></dd>
        </div>
        <div>
          <dt>Services to create</dt>
          <dd>
            <ul class="wz-review__list">
              <li v-for="s in servicesToCreate" :key="s.name">
                <code>{{ s.name }}</code>
                <span v-if="s.pipelineName" class="wz-hint"> · pipeline {{ s.pipelineName }}</span>
              </li>
            </ul>
          </dd>
        </div>
        <div v-if="form.dockerImage"><dt>Docker image</dt><dd>{{ form.dockerImage }}</dd></div>
        <div v-if="form.composePath"><dt>Compose path</dt><dd>{{ form.composePath }}</dd></div>
        <div><dt>Agents</dt><dd>{{ form.agentIds.length ? form.agentIds.length + ' bound' : 'none' }}</dd></div>
      </dl>
    </div>

    <!-- Footer nav -->
    <div class="wz-nav">
      <Button variant="secondary" size="md" :disabled="step === 0 || submitting" @click="back">Back</Button>
      <div class="wz-nav__right">
        <Button
          v-if="step < STEPS.length - 1"
          variant="primary"
          size="md"
          :disabled="!canNext"
          @click="next"
        >Next</Button>
        <Button
          v-else
          variant="primary"
          size="md"
          :loading="submitting"
          :disabled="!step1Valid || servicesToCreate.length === 0"
          @click="create"
        >{{ servicesToCreate.length > 1 ? `Create ${servicesToCreate.length} services` : 'Create service' }}</Button>
      </div>
    </div>
  </Card>
</template>

<style scoped>
.wz-steps {
  display: flex;
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
  gap: 0.25rem;
}
.wz-step {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex: 1;
  font-size: 0.8rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
.wz-step:not(:last-child)::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--color-border);
  margin-left: 0.25rem;
}
.wz-step__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface);
  font-size: 0.75rem;
  font-weight: 600;
  flex: 0 0 auto;
}
.wz-step--active {
  color: var(--color-text);
  font-weight: 600;
}
.wz-step--active .wz-step__dot {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: var(--color-primary-foreground);
}
.wz-step--done {
  color: var(--color-text-secondary);
}
.wz-step--done .wz-step__dot {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.wz-body {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  min-height: 11rem;
}
.wz-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}
.wz-muted {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-text-secondary);
}
.wz-hint {
  font-weight: 400;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}
.wz-error {
  margin: 0 0 0.5rem;
}
.wz-agents {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
}
.wz-agent {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}

/* Pipeline-preview card */
.wz-preview {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  font-size: 0.88rem;
  background: var(--color-surface);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.wz-preview--loading {
  color: var(--color-text-secondary);
  font-style: italic;
}
.wz-preview--ok {
  border-color: var(--color-success, var(--color-border));
}
.wz-preview--warn {
  border-color: var(--color-warning, var(--color-border));
  background: color-mix(in srgb, var(--color-warning, var(--color-surface)) 10%, var(--color-surface));
}
.wz-preview__sub {
  margin-top: 0.2rem;
}
.wz-pipelines {
  margin: 0.3rem 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.wz-pipeline {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.wz-pipeline__src {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--color-text-secondary);
  min-width: 8rem;
}
.wz-pipeline__arrow {
  color: var(--color-text-muted);
}
.wz-pipeline__name {
  color: var(--color-text-primary);
}

.wz-review {
  margin: 0;
  display: grid;
  gap: 0.5rem;
}
.wz-review > div {
  display: grid;
  grid-template-columns: 9rem 1fr;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.wz-review dt {
  margin: 0;
  color: var(--color-text-secondary);
}
.wz-review dd {
  margin: 0;
  word-break: break-all;
}
.wz-review__list {
  margin: 0;
  padding-left: 1rem;
}
.wz-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--color-border);
}
.wz-nav__right {
  display: flex;
  gap: 0.5rem;
}
</style>
