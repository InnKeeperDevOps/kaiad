<script setup lang="ts">
// Guided multi-step "Add service" flow. Used only for creation; editing
// keeps the inline form on ServicesPage. Emits the created service so
// the parent can append it to the list.
import { reactive, ref, computed } from "vue";
import { api, type Agent, type MonitoredService, type SshKey } from "../../lib/api.js";
import Card from "../../components/Card.vue";
import Button from "../../components/Button.vue";

const props = defineProps<{ agents: Agent[]; sshKeys: SshKey[] }>();
const emit = defineEmits<{ created: [svc: MonitoredService]; cancel: [] }>();

const STEPS = ["Repository", "Pipeline", "Agents", "Review"] as const;
const step = ref(0);
const submitting = ref(false);
const error = ref<string | null>(null);

const form = reactive({
  name: "",
  gitRepoUrl: "",
  branch: "main",
  sshKeyId: "",
  pipelineName: "",
  dockerImage: "",
  composePath: "",
  agentIds: [] as string[]
});
const showAdvanced = ref(false);

const step1Valid = computed(
  () => form.name.trim() !== "" && form.gitRepoUrl.trim() !== "" && form.branch.trim() !== ""
);
const canNext = computed(() => (step.value === 0 ? step1Valid.value : true));

function toggleAgent(id: string) {
  form.agentIds = form.agentIds.includes(id)
    ? form.agentIds.filter((a) => a !== id)
    : [...form.agentIds, id];
}
function next() {
  if (step.value < STEPS.length - 1 && canNext.value) step.value++;
}
function back() {
  if (step.value > 0) step.value--;
}

async function create() {
  submitting.value = true;
  error.value = null;
  try {
    const svc = await api.createService({
      name: form.name.trim(),
      gitRepoUrl: form.gitRepoUrl.trim(),
      sshKeyId: form.sshKeyId || undefined,
      branch: form.branch.trim(),
      dockerImage: form.dockerImage.trim() || undefined,
      composePath: form.composePath.trim() || undefined,
      pipelineName: form.pipelineName.trim() || undefined,
      agentIds: form.agentIds
    });
    emit("created", svc);
  } catch (e) {
    error.value = (e as Error).message;
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
        <label class="sm-input-label">Service name</label>
        <input class="sm-input" v-model="form.name" placeholder="e.g. mcbans-php" />
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
    </div>

    <!-- Step 2: Pipeline -->
    <div v-show="step === 1" class="wz-body">
      <p class="wz-muted">
        Kaiad builds &amp; deploys from the repo's <code>kaiad.yaml</code>. You can edit or
        override it later from the service's <strong>Pipeline</strong> panel.
      </p>
      <div class="sm-input-wrapper">
        <label class="sm-input-label">
          Pipeline name <span class="wz-hint">only if kaiad.yaml is multi-service</span>
        </label>
        <input class="sm-input" v-model="form.pipelineName" placeholder="e.g. php — matches services.&lt;name&gt;" />
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
      <p class="wz-muted">Bind zero or more agents now — you can change this any time.</p>
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
        <div><dt>Name</dt><dd>{{ form.name }}</dd></div>
        <div><dt>Repository</dt><dd>{{ form.gitRepoUrl }}</dd></div>
        <div><dt>Branch</dt><dd>{{ form.branch }}</dd></div>
        <div><dt>SSH key</dt><dd>{{ props.sshKeys.find(k => k.id === form.sshKeyId)?.name || 'none (public HTTPS)' }}</dd></div>
        <div><dt>Pipeline</dt><dd>{{ form.pipelineName || '(single-pipeline kaiad.yaml)' }}</dd></div>
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
          :disabled="!step1Valid"
          @click="create"
        >Create service</Button>
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
