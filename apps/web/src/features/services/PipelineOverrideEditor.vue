<script setup lang="ts">
// Panel editor for a service's kaiad.yaml override. Two tabs:
//  - Raw YAML: the canonical stored text, live-validated against the
//    Kaiad contracts schema (parsePipelineYaml).
//  - Form: guided controls for the common deploy knobs (load balancer +
//    pinned IPs, domains, env, secret-ref env, volumes, per-environment
//    namespace, multi-service add/remove). The form edits the parsed
//    object and re-serialises to the YAML text, which stays the single
//    source of truth that gets saved.
import { ref, computed, watch, onMounted } from "vue";
import { api } from "../../lib/api.js";
import { parsePipelineYaml, yamlParse, yamlStringify } from "@sm/contracts";
import Card from "../../components/Card.vue";
import Button from "../../components/Button.vue";

const props = defineProps<{ serviceId: string; serviceName: string }>();

const loading = ref(true);
const saving = ref(false);
const tab = ref<"raw" | "form">("form");
const yamlText = ref("");
const hadOverride = ref(false);
const loadedFrom = ref<"service" | "repo" | "repofile" | "template">("template");
const message = ref<string | null>(null);
const messageOk = ref(false);

// kaiad.yaml is a repo file → default scope is the whole repo. 'service'
// is the explicit per-service opt-out.
const scope = ref<"repo" | "service">("repo");
const gitRepoUrl = ref("");
const branch = ref("");
const repoServices = ref<{ id: string; name: string; pipelineName: string | null; hasServiceOverride: boolean }[]>([]);

const repoScopeHint = computed(() => {
  const n = repoServices.value.length;
  const repo = gitRepoUrl.value ? ` from ${gitRepoUrl.value}@${branch.value}` : "";
  return `default — ${n} service${n === 1 ? "" : "s"}${repo}`;
});

const STARTER = `version: 1
runtime:
  image: nginx:alpine
  command: ["nginx", "-g", "daemon off;"]
  env: {}
ports:
  - port: 80
    name: http
loadBalancer:
  type: none
`;

const validation = computed(() => {
  const text = yamlText.value.trim();
  if (!text) return { ok: false, reason: "empty — nothing to save" };
  const r = parsePipelineYaml(text);
  if (!r.ok) return { ok: false, reason: r.reason };
  return {
    ok: true,
    reason:
      r.kind === "multi"
        ? `valid — multi-service (${Object.keys(r.pipelines).join(", ")})`
        : "valid — single pipeline"
  };
});

onMounted(async () => {
  try {
    const r = await api.getPipelineOverride(props.serviceId);
    gitRepoUrl.value = r.gitRepoUrl;
    branch.value = r.branch;
    repoServices.value = r.repoServices;
    hadOverride.value = r.serviceOverride != null || r.repoOverride != null;
    if (r.serviceOverride != null) {
      yamlText.value = r.serviceOverride;
      loadedFrom.value = "service";
      scope.value = "service";
    } else if (r.repoOverride != null) {
      yamlText.value = r.repoOverride;
      loadedFrom.value = "repo";
      scope.value = "repo";
    } else if (r.repoYaml != null && r.repoYaml.trim()) {
      // No override anywhere — preload the repo's kaiad.yaml (the latest
      // build's captured pipeline_yaml) so the user edits the real
      // current config rather than a blank template.
      yamlText.value = r.repoYaml;
      loadedFrom.value = "repofile";
      scope.value = "repo";
    } else {
      yamlText.value = STARTER;
      loadedFrom.value = "template";
      scope.value = "repo";
    }
    // Form is the default tab — populate the parsed model now (the
    // tab watcher won't fire since tab doesn't change on load).
    loadFormFromYaml();
  } catch (e) {
    message.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
});

// ---- Form model (parsed object <-> yamlText) ---------------------------
type AnyObj = Record<string, any>;
const doc = ref<AnyObj>({});
const formError = ref<string | null>(null);

function loadFormFromYaml() {
  try {
    const parsed = yamlParse(yamlText.value);
    doc.value = parsed && typeof parsed === "object" ? (parsed as AnyObj) : {};
    formError.value = null;
  } catch (e) {
    formError.value = `Can't open form — YAML invalid: ${(e as Error).message}`;
  }
}
function syncYamlFromForm() {
  try {
    yamlText.value = yamlStringify(doc.value);
  } catch (e) {
    formError.value = (e as Error).message;
  }
}
watch(tab, (t) => {
  if (t === "form") loadFormFromYaml();
});

// Multi-service doc has `services: {name:{...}}`; single doc is the
// pipeline itself. Normalise to a list the form edits in place.
const pipelines = computed<{ name: string; p: AnyObj }[]>(() => {
  const d = doc.value;
  if (d && d.services && typeof d.services === "object") {
    return Object.keys(d.services).map((n) => ({ name: n, p: d.services[n] }));
  }
  return [{ name: "", p: d }];
});

function ensure(p: AnyObj, key: string, init: any) {
  if (p[key] == null) p[key] = init;
  return p[key];
}
function lb(p: AnyObj) {
  return ensure(p, "loadBalancer", { type: "none" });
}
// `dockerfile:` is mutually exclusive with build/artifacts/runtime
// (the parser rejects them together). The form picks one image source
// and prunes the other so it can never emit an invalid kaiad.yaml.
function dfMode(p: AnyObj): boolean {
  return !!p.dockerfile;
}
function setImageMode(p: AnyObj, mode: "build" | "dockerfile") {
  if (mode === "dockerfile") {
    delete p.build;
    delete p.artifacts;
    delete p.runtime;
    if (!p.dockerfile) p.dockerfile = { path: "Dockerfile", context: "." };
  } else {
    delete p.dockerfile;
    ensure(p, "runtime", { image: "scratch", command: [] });
  }
  syncYamlFromForm();
}
function arr(p: AnyObj, parentKey: string | null, key: string): AnyObj[] {
  const parent = parentKey ? ensure(p, parentKey, {}) : p;
  if (!Array.isArray(parent[key])) parent[key] = [];
  return parent[key];
}
// String-array (argv / steps / artifacts / layers / dependsOn) row edit.
function strArr(p: AnyObj, parentKey: string | null, key: string): string[] {
  const parent = parentKey ? ensure(p, parentKey, {}) : p;
  if (!Array.isArray(parent[key])) parent[key] = [];
  return parent[key] as string[];
}
function setStr(list: string[], i: number, ev: Event) {
  list[i] = (ev.target as HTMLInputElement).value;
  syncYamlFromForm();
}
// Generic key/value map editing (build.env, dockerfile.args).
function kvObj(p: AnyObj, parentKey: string, key: string): AnyObj {
  return ensure(ensure(p, parentKey, {}), key, {});
}
function addKv(obj: AnyObj, ev: Event) {
  const el = ev.target as HTMLInputElement;
  const k = el.value.trim();
  if (k) {
    obj[k] = "";
    el.value = "";
    syncYamlFromForm();
  }
}
function envObj(p: AnyObj): AnyObj {
  return ensure(ensure(p, "runtime", {}), "env", {});
}
function envKeys(p: AnyObj): string[] {
  return Object.keys(envObj(p));
}
function addEnvKey(p: AnyObj, ev: Event) {
  const el = ev.target as HTMLInputElement;
  const k = el.value.trim();
  if (k) {
    envObj(p)[k] = "";
    el.value = "";
    syncYamlFromForm();
  }
}
function removeEnvKey(p: AnyObj, k: string) {
  delete envObj(p)[k];
  syncYamlFromForm();
}
function addEnvName(p: AnyObj, name: string) {
  const n = name.trim();
  if (n) {
    ensure(p, "environments", {})[n] = { namespace: "" };
    syncYamlFromForm();
  }
}
function volKind(v: AnyObj): string {
  return v.nfs ? "nfs" : v.hostPath ? "hostPath" : v.persistentVolumeClaim ? "pvc" : "emptyDir";
}
function setVolKind(v: AnyObj, kind: string) {
  delete v.nfs;
  delete v.hostPath;
  delete v.persistentVolumeClaim;
  delete v.emptyDir;
  if (kind === "nfs") v.nfs = { server: "", path: "/" };
  else if (kind === "hostPath") v.hostPath = { path: "/" };
  else if (kind === "pvc") v.persistentVolumeClaim = { claimName: "" };
  else v.emptyDir = true;
  syncYamlFromForm();
}

function addMulti() {
  if (!doc.value.services) {
    const single = { ...doc.value };
    const ver = single.version ?? 1;
    delete single.version;
    doc.value = { version: ver, services: { [props.serviceName || "svc"]: single } };
  } else {
    doc.value.services[`service-${Object.keys(doc.value.services).length + 1}`] = {
      runtime: { image: "nginx:alpine", command: ["nginx", "-g", "daemon off;"], env: {} },
      ports: [{ port: 80, name: "http" }],
      loadBalancer: { type: "none" }
    };
  }
  syncYamlFromForm();
}
function removeService(name: string) {
  if (doc.value.services) {
    delete doc.value.services[name];
    syncYamlFromForm();
  }
}

async function save() {
  if (!validation.value.ok) {
    messageOk.value = false;
    message.value = `Fix errors first: ${validation.value.reason}`;
    return;
  }
  saving.value = true;
  message.value = null;
  try {
    const r = await api.savePipelineOverride(props.serviceId, yamlText.value, scope.value);
    hadOverride.value = true;
    loadedFrom.value = scope.value === "service" ? "service" : "repo";
    messageOk.value = true;
    message.value =
      scope.value === "service"
        ? "Saved for this service only. Applies on its next build."
        : `Saved for the repo — ${r.affectedServices.length} service(s) will use it. Applies on their next build.`;
  } catch (e) {
    messageOk.value = false;
    message.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
async function saveAndDeploy() {
  if (!validation.value.ok) {
    messageOk.value = false;
    message.value = `Fix errors first: ${validation.value.reason}`;
    return;
  }
  saving.value = true;
  message.value = null;
  try {
    const r = await api.savePipelineOverride(props.serviceId, yamlText.value, scope.value);
    hadOverride.value = true;
    loadedFrom.value = scope.value === "service" ? "service" : "repo";
    // Queue a build for every service the override actually affects so
    // the new config builds + auto-deploys now, not on the next poll.
    const targets = r.affectedServices.length ? r.affectedServices : [{ id: props.serviceId, name: props.serviceName }];
    const results = await Promise.allSettled(targets.map((t) => api.triggerServiceBuild(t.id)));
    const ok = results.filter((x) => x.status === "fulfilled").length;
    messageOk.value = true;
    message.value =
      scope.value === "service"
        ? `Saved (this service only) — build queued; it auto-deploys to bound agents.`
        : `Saved for the repo — ${ok}/${targets.length} service build(s) queued; each auto-deploys to its bound agents.`;
  } catch (e) {
    messageOk.value = false;
    message.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function clearOverride() {
  const what =
    scope.value === "service"
      ? "Remove this service's per-service override? It will fall back to the repo override (or repo kaiad.yaml)."
      : "Remove the repo-wide override? All services from this repo revert to the repo kaiad.yaml.";
  if (!window.confirm(what)) return;
  saving.value = true;
  try {
    await api.clearPipelineOverride(props.serviceId, scope.value);
    hadOverride.value = false;
    messageOk.value = true;
    message.value =
      scope.value === "service"
        ? "Per-service override cleared."
        : "Repo override cleared — reverting to the repo kaiad.yaml.";
  } catch (e) {
    messageOk.value = false;
    message.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Card title="Pipeline override — kaiad.yaml" :style="{ margin: '0.25rem 0' }">
    <template #actions>
      <span
        class="sm-badge"
        :class="loadedFrom === 'service' ? 'sm-badge--info' : loadedFrom === 'repo' ? 'sm-badge--info' : 'sm-badge--muted'"
      >
        {{
          loadedFrom === 'service'
            ? 'Per-service override active'
            : loadedFrom === 'repo'
              ? 'Repo override active'
              : loadedFrom === 'repofile'
                ? 'No override — loaded from repo kaiad.yaml'
                : 'No override — starter template (repo has no builds yet)'
        }}
      </span>
    </template>

    <p v-if="loading" class="pl-muted">Loading…</p>
    <template v-else>
      <!-- Scope: kaiad.yaml is a repo file → default is repo-wide -->
      <fieldset class="pl-scope">
        <legend class="pl-scope__legend">Apply to</legend>
        <label class="pl-scope__opt">
          <input type="radio" value="repo" v-model="scope" />
          <span class="pl-scope__text">
            <strong>All services in this repo</strong>
            <span class="pl-hint">{{ repoScopeHint }}</span>
          </span>
        </label>
        <label class="pl-scope__opt">
          <input type="radio" value="service" v-model="scope" />
          <span class="pl-scope__text">
            <strong>This service only</strong>
            <span class="pl-hint">explicit per-service override — takes precedence over the repo one</span>
          </span>
        </label>
        <div v-if="scope === 'repo' && repoServices.length" class="pl-scope__svcs">
          <span
            v-for="s in repoServices"
            :key="s.id"
            class="sm-badge"
            :class="s.hasServiceOverride ? 'sm-badge--warning' : 'sm-badge--muted'"
            :title="s.hasServiceOverride ? 'has its own per-service override — shadows the repo one' : ''"
          >
            {{ s.name }}{{ s.hasServiceOverride ? ' (own override)' : '' }}
          </span>
        </div>
      </fieldset>
      <div class="pl-tabs" role="tablist">
        <button
          type="button"
          class="pl-tab"
          :class="{ 'pl-tab--active': tab === 'form' }"
          @click="tab = 'form'"
        >Form</button>
        <button
          type="button"
          class="pl-tab"
          :class="{ 'pl-tab--active': tab === 'raw' }"
          @click="tab = 'raw'"
        >Raw YAML</button>
      </div>

      <!-- RAW -->
      <div v-show="tab === 'raw'">
        <textarea
          v-model="yamlText"
          spellcheck="false"
          class="pl-yaml"
          aria-label="kaiad.yaml override"
        ></textarea>
      </div>

      <!-- FORM -->
      <div v-show="tab === 'form'" class="pl-form">
        <p v-if="formError" class="sm-input-error">{{ formError }}</p>

        <div class="pl-form__bar">
          <Button variant="secondary" size="sm" @click="addMulti">+ Add service (multi)</Button>
        </div>

        <div v-for="entry in pipelines" :key="entry.name || '<single>'" class="pl-pipeline">
          <div class="pl-pipeline__head">
            <span class="pl-pipeline__name">{{ entry.name || 'single pipeline' }}</span>
            <Button v-if="entry.name" variant="ghost" size="sm" @click="removeService(entry.name)">Remove</Button>
          </div>

          <section class="pl-section">
            <h4 class="pl-section__title">
              Image source <span class="pl-hint">build &amp; runtime, or a Dockerfile — not both</span>
            </h4>
            <div class="pl-row">
              <label class="pl-label">Mode</label>
              <select
                class="sm-input"
                :value="dfMode(entry.p) ? 'dockerfile' : 'build'"
                @change="setImageMode(entry.p, ($event.target as HTMLSelectElement).value as 'build' | 'dockerfile')"
              >
                <option value="build">Build &amp; runtime</option>
                <option value="dockerfile">Dockerfile</option>
              </select>
            </div>
          </section>

          <!-- Load balancer -->
          <section class="pl-section">
            <h4 class="pl-section__title">Load balancer</h4>
            <div class="pl-row">
              <label class="pl-label">Type</label>
              <select class="sm-input pl-in pl-in--sm" v-model="lb(entry.p).type" @change="syncYamlFromForm">
                <option value="none">none</option>
                <option value="metallb">metallb</option>
                <option value="k8s">k8s</option>
                <option value="nginx">nginx</option>
              </select>
              <template v-if="lb(entry.p).type === 'metallb'">
                <label class="pl-label">Address pool</label>
                <input class="sm-input pl-in" v-model="lb(entry.p).addressPool" @input="syncYamlFromForm" placeholder="first-pool" />
                <label class="pl-label">Pinned IP(s)</label>
                <input class="sm-input pl-in" v-model="lb(entry.p).loadBalancerIPs" @input="syncYamlFromForm" placeholder="192.168.1.230" />
              </template>
              <template v-if="lb(entry.p).type === 'nginx'">
                <label class="pl-label">Ingress class</label>
                <input class="sm-input pl-in" v-model="lb(entry.p).ingressClass" @input="syncYamlFromForm" placeholder="nginx" />
                <label class="pl-label">TLS secret</label>
                <input class="sm-input pl-in" v-model="lb(entry.p).tlsSecret" @input="syncYamlFromForm" />
              </template>
            </div>
          </section>

          <!-- Ports -->
          <section class="pl-section">
            <h4 class="pl-section__title">Ports <span class="pl-hint">container ports — the source of truth</span></h4>
            <div v-for="(pt, i) in arr(entry.p, null, 'ports')" :key="i" class="pl-row">
              <input class="sm-input pl-in pl-in--xs" type="number" v-model.number="pt.port" @input="syncYamlFromForm" placeholder="8080" />
              <input class="sm-input pl-in pl-in--sm" v-model="pt.name" @input="syncYamlFromForm" placeholder="name (http)" />
              <select class="sm-input pl-in pl-in--sm" v-model="pt.protocol" @change="syncYamlFromForm">
                <option value="TCP">TCP</option>
                <option value="UDP">UDP</option>
              </select>
              <Button variant="ghost" size="sm" @click="arr(entry.p, null, 'ports').splice(i, 1); syncYamlFromForm()">✕</Button>
            </div>
            <Button variant="secondary" size="sm" @click="arr(entry.p, null, 'ports').push({ port: 8080, name: 'http' }); syncYamlFromForm()">+ Port</Button>
          </section>

          <!-- Domains -->
          <section class="pl-section">
            <h4 class="pl-section__title">Domains</h4>
            <div v-for="(d, i) in arr(entry.p, null, 'domains')" :key="i" class="pl-row">
              <input class="sm-input pl-in" v-model="d.host" @input="syncYamlFromForm" placeholder="host.example.com" />
              <input class="sm-input pl-in pl-in--xs" type="number" v-model.number="d.port" @input="syncYamlFromForm" placeholder="80" />
              <select class="sm-input pl-in pl-in--sm" v-model="d.protocol" @change="syncYamlFromForm">
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
              <Button variant="ghost" size="sm" @click="arr(entry.p, null, 'domains').splice(i, 1); syncYamlFromForm()">✕</Button>
            </div>
            <Button variant="secondary" size="sm" @click="arr(entry.p, null, 'domains').push({ host: '', port: 80, protocol: 'https' }); syncYamlFromForm()">+ Domain</Button>
          </section>

          <!-- Env -->
          <section v-if="!dfMode(entry.p)" class="pl-section">
            <h4 class="pl-section__title">Environment variables</h4>
            <div v-for="k in envKeys(entry.p)" :key="'e-' + k" class="pl-row">
              <input class="sm-input pl-in" :value="k" readonly />
              <span class="pl-eq">=</span>
              <input class="sm-input pl-in" v-model="envObj(entry.p)[k]" @input="syncYamlFromForm" />
              <Button variant="ghost" size="sm" @click="removeEnvKey(entry.p, k)">✕</Button>
            </div>
            <div class="pl-row">
              <input class="sm-input pl-in" placeholder="NEW_KEY — press Enter" @keyup.enter="addEnvKey(entry.p, $event)" />
            </div>
          </section>

          <!-- Secret-ref env -->
          <section v-if="!dfMode(entry.p)" class="pl-section">
            <h4 class="pl-section__title">Secret-ref env <span class="pl-hint">existing k8s Secret</span></h4>
            <div v-for="(s, i) in arr(entry.p, 'runtime', 'secretEnv')" :key="'s' + i" class="pl-row">
              <input class="sm-input pl-in" v-model="s.name" @input="syncYamlFromForm" placeholder="ENV_NAME" />
              <span class="pl-eq">←</span>
              <input class="sm-input pl-in" v-model="s.secret" @input="syncYamlFromForm" placeholder="secret-name" />
              <input class="sm-input pl-in pl-in--sm" v-model="s.key" @input="syncYamlFromForm" placeholder="key" />
              <Button variant="ghost" size="sm" @click="arr(entry.p, 'runtime', 'secretEnv').splice(i, 1); syncYamlFromForm()">✕</Button>
            </div>
            <Button variant="secondary" size="sm" @click="arr(entry.p, 'runtime', 'secretEnv').push({ name: '', secret: '', key: '' }); syncYamlFromForm()">+ Secret env</Button>
          </section>

          <!-- Volumes -->
          <section v-if="!dfMode(entry.p)" class="pl-section">
            <h4 class="pl-section__title">Volumes</h4>
            <div v-for="(v, i) in arr(entry.p, 'runtime', 'volumes')" :key="'v' + i" class="pl-vol">
              <div class="pl-row">
                <input class="sm-input pl-in pl-in--sm" v-model="v.name" @input="syncYamlFromForm" placeholder="volume-name" />
                <select class="sm-input pl-in pl-in--sm" :value="volKind(v)" @change="setVolKind(v, ($event.target as HTMLSelectElement).value)">
                  <option value="nfs">nfs</option>
                  <option value="hostPath">hostPath</option>
                  <option value="pvc">pvc</option>
                  <option value="emptyDir">emptyDir</option>
                </select>
                <template v-if="v.nfs">
                  <input class="sm-input pl-in" v-model="v.nfs.server" @input="syncYamlFromForm" placeholder="192.168.1.147" />
                  <input class="sm-input pl-in" v-model="v.nfs.path" @input="syncYamlFromForm" placeholder="/data" />
                </template>
                <template v-else-if="v.hostPath">
                  <input class="sm-input pl-in" v-model="v.hostPath.path" @input="syncYamlFromForm" placeholder="/host/path" />
                </template>
                <template v-else-if="v.persistentVolumeClaim">
                  <input class="sm-input pl-in" v-model="v.persistentVolumeClaim.claimName" @input="syncYamlFromForm" placeholder="my-pvc" />
                </template>
                <Button variant="ghost" size="sm" @click="arr(entry.p, 'runtime', 'volumes').splice(i, 1); syncYamlFromForm()">Remove volume</Button>
              </div>
              <div v-for="(m, mi) in (v.mounts || (v.mounts = []))" :key="'m' + mi" class="pl-row pl-row--indent">
                <span class="pl-hint">mount</span>
                <input class="sm-input pl-in" v-model="m.path" @input="syncYamlFromForm" placeholder="/cache/www/" />
                <label class="pl-check"><input type="checkbox" v-model="m.readOnly" @change="syncYamlFromForm" /> read-only</label>
                <Button variant="ghost" size="sm" @click="v.mounts.splice(mi, 1); syncYamlFromForm()">✕</Button>
              </div>
              <Button variant="ghost" size="sm" @click="(v.mounts || (v.mounts = [])).push({ path: '/' }); syncYamlFromForm()">+ Mount</Button>
            </div>
            <Button variant="secondary" size="sm" @click="arr(entry.p, 'runtime', 'volumes').push({ name: 'vol', nfs: { server: '', path: '/' }, mounts: [{ path: '/' }] }); syncYamlFromForm()">+ Volume</Button>
          </section>

          <!-- Runtime image + command -->
          <section v-if="!dfMode(entry.p)" class="pl-section">
            <h4 class="pl-section__title">Runtime image &amp; command</h4>
            <div class="pl-row">
              <label class="pl-label">Image</label>
              <input class="sm-input pl-in" :value="ensure(entry.p,'runtime',{}).image" @input="ensure(entry.p,'runtime',{}).image = ($event.target as HTMLInputElement).value; syncYamlFromForm()" placeholder="nginx:alpine" />
            </div>
            <div v-for="(c, i) in strArr(entry.p, 'runtime', 'command')" :key="'c'+i" class="pl-row">
              <span class="pl-hint">argv[{{ i }}]</span>
              <input class="sm-input pl-in" :value="c" @input="setStr(strArr(entry.p,'runtime','command'), i, $event)" placeholder="/start.sh" />
              <Button variant="ghost" size="sm" @click="strArr(entry.p,'runtime','command').splice(i,1); syncYamlFromForm()">✕</Button>
            </div>
            <Button variant="secondary" size="sm" @click="strArr(entry.p,'runtime','command').push(''); syncYamlFromForm()">+ Command arg</Button>
          </section>

          <!-- Scaling / kind / dependsOn -->
          <section class="pl-section">
            <h4 class="pl-section__title">Deployment</h4>
            <div class="pl-row">
              <label class="pl-label">Instances</label>
              <input class="sm-input pl-in pl-in--xs" type="number" min="0" v-model.number="entry.p.instances" @input="syncYamlFromForm" placeholder="1" />
              <label class="pl-label">Kind</label>
              <select class="sm-input pl-in pl-in--sm" v-model="entry.p.kind" @change="syncYamlFromForm">
                <option value="deployable">deployable</option>
                <option value="supporting">supporting</option>
              </select>
              <label class="pl-label">Namespace</label>
              <input class="sm-input pl-in pl-in--sm" v-model="entry.p.namespace" @input="syncYamlFromForm" placeholder="(default)" />
            </div>
            <div v-for="(d, i) in strArr(entry.p, null, 'dependsOn')" :key="'dep'+i" class="pl-row">
              <span class="pl-hint">dependsOn</span>
              <input class="sm-input pl-in pl-in--sm" :value="d" @input="setStr(strArr(entry.p,null,'dependsOn'), i, $event)" placeholder="php-image" />
              <Button variant="ghost" size="sm" @click="strArr(entry.p,null,'dependsOn').splice(i,1); syncYamlFromForm()">✕</Button>
            </div>
            <Button variant="secondary" size="sm" @click="strArr(entry.p,null,'dependsOn').push(''); syncYamlFromForm()">+ Depends on</Button>
          </section>

          <!-- Build -->
          <section v-if="!dfMode(entry.p)" class="pl-section">
            <h4 class="pl-section__title">Build <span class="pl-hint">repo build step</span></h4>
            <div class="pl-row">
              <label class="pl-label">Build image</label>
              <input class="sm-input pl-in" :value="ensure(entry.p,'build',{}).image" @input="ensure(entry.p,'build',{}).image = ($event.target as HTMLInputElement).value; syncYamlFromForm()" placeholder="maven:3.9-eclipse-temurin-17" />
            </div>
            <div v-for="(st, i) in strArr(entry.p, 'build', 'steps')" :key="'bs'+i" class="pl-row">
              <span class="pl-hint">step {{ i + 1 }}</span>
              <input class="sm-input pl-in" :value="st" @input="setStr(strArr(entry.p,'build','steps'), i, $event)" placeholder="mvn -B package" />
              <Button variant="ghost" size="sm" @click="strArr(entry.p,'build','steps').splice(i,1); syncYamlFromForm()">✕</Button>
            </div>
            <Button variant="secondary" size="sm" @click="strArr(entry.p,'build','steps').push(''); syncYamlFromForm()">+ Build step</Button>
            <div :style="{ marginTop: '0.4rem' }">
              <span class="pl-hint">build env</span>
              <div v-for="k in Object.keys(kvObj(entry.p,'build','env'))" :key="'be'+k" class="pl-row">
                <input class="sm-input pl-in pl-in--sm" :value="k" readonly />
                <span class="pl-eq">=</span>
                <input class="sm-input pl-in" v-model="kvObj(entry.p,'build','env')[k]" @input="syncYamlFromForm" />
                <Button variant="ghost" size="sm" @click="delete kvObj(entry.p,'build','env')[k]; syncYamlFromForm()">✕</Button>
              </div>
              <div class="pl-row">
                <input class="sm-input pl-in pl-in--sm" placeholder="KEY — Enter" @keyup.enter="addKv(kvObj(entry.p,'build','env'), $event)" />
              </div>
            </div>
          </section>

          <!-- Artifacts, copy, layers -->
          <section v-if="!dfMode(entry.p)" class="pl-section">
            <h4 class="pl-section__title">Artifacts &amp; runtime layers</h4>
            <div v-for="(a, i) in strArr(entry.p, null, 'artifacts')" :key="'art'+i" class="pl-row">
              <span class="pl-hint">artifact</span>
              <input class="sm-input pl-in pl-in--sm" :value="a" @input="setStr(strArr(entry.p,null,'artifacts'), i, $event)" placeholder="app.jar" />
              <Button variant="ghost" size="sm" @click="strArr(entry.p,null,'artifacts').splice(i,1); syncYamlFromForm()">✕</Button>
            </div>
            <Button variant="secondary" size="sm" @click="strArr(entry.p,null,'artifacts').push(''); syncYamlFromForm()">+ Artifact</Button>
            <div :style="{ marginTop: '0.4rem' }">
              <div v-for="(l, i) in strArr(entry.p, 'runtime', 'layers')" :key="'ly'+i" class="pl-row">
                <span class="pl-hint">layer (artifact tar)</span>
                <input class="sm-input pl-in pl-in--sm" :value="l" @input="setStr(strArr(entry.p,'runtime','layers'), i, $event)" placeholder="rootfs.tar" />
                <Button variant="ghost" size="sm" @click="strArr(entry.p,'runtime','layers').splice(i,1); syncYamlFromForm()">✕</Button>
              </div>
              <Button variant="secondary" size="sm" @click="strArr(entry.p,'runtime','layers').push(''); syncYamlFromForm()">+ Layer</Button>
            </div>
            <div :style="{ marginTop: '0.4rem' }">
              <div v-for="(cp, i) in arr(entry.p, 'runtime', 'copy')" :key="'cp'+i" class="pl-row">
                <span class="pl-hint">copy</span>
                <input class="sm-input pl-in pl-in--sm" v-model="cp.from" @input="syncYamlFromForm" placeholder="from (artifact)" />
                <span class="pl-eq">→</span>
                <input class="sm-input pl-in" v-model="cp.to" @input="syncYamlFromForm" placeholder="/abs/path" />
                <Button variant="ghost" size="sm" @click="arr(entry.p,'runtime','copy').splice(i,1); syncYamlFromForm()">✕</Button>
              </div>
              <Button variant="secondary" size="sm" @click="arr(entry.p,'runtime','copy').push({ from: '', to: '/' }); syncYamlFromForm()">+ Copy</Button>
            </div>
          </section>

          <!-- Dockerfile mode -->
          <section v-if="dfMode(entry.p)" class="pl-section">
            <h4 class="pl-section__title">Dockerfile</h4>
            <div class="pl-row">
              <label class="pl-label">Path</label>
              <input class="sm-input pl-in pl-in--sm" :value="ensure(entry.p,'dockerfile',{}).path" @input="ensure(entry.p,'dockerfile',{}).path = ($event.target as HTMLInputElement).value; syncYamlFromForm()" placeholder="Dockerfile" />
              <label class="pl-label">Context</label>
              <input class="sm-input pl-in pl-in--sm" :value="ensure(entry.p,'dockerfile',{}).context" @input="ensure(entry.p,'dockerfile',{}).context = ($event.target as HTMLInputElement).value; syncYamlFromForm()" placeholder="." />
              <label class="pl-label">Target</label>
              <input class="sm-input pl-in pl-in--sm" :value="ensure(entry.p,'dockerfile',{}).target" @input="ensure(entry.p,'dockerfile',{}).target = ($event.target as HTMLInputElement).value; syncYamlFromForm()" placeholder="(stage)" />
            </div>
            <div v-for="k in Object.keys(kvObj(entry.p,'dockerfile','args'))" :key="'da'+k" class="pl-row">
              <input class="sm-input pl-in pl-in--sm" :value="k" readonly />
              <span class="pl-eq">=</span>
              <input class="sm-input pl-in" v-model="kvObj(entry.p,'dockerfile','args')[k]" @input="syncYamlFromForm" />
              <Button variant="ghost" size="sm" @click="delete kvObj(entry.p,'dockerfile','args')[k]; syncYamlFromForm()">✕</Button>
            </div>
            <div class="pl-row">
              <input class="sm-input pl-in pl-in--sm" placeholder="build-arg — Enter" @keyup.enter="addKv(kvObj(entry.p,'dockerfile','args'), $event)" />
            </div>
          </section>

          <!-- Per-environment overrides -->
          <section class="pl-section">
            <h4 class="pl-section__title">Environment overrides</h4>
            <div v-for="envName in Object.keys(ensure(entry.p, 'environments', {}))" :key="'env' + envName" class="pl-row">
              <span class="pl-tag">{{ envName }}</span>
              <label class="pl-label">Namespace</label>
              <input class="sm-input pl-in" v-model="ensure(entry.p, 'environments', {})[envName].namespace" @input="syncYamlFromForm" />
              <Button variant="ghost" size="sm" @click="delete ensure(entry.p, 'environments', {})[envName]; syncYamlFromForm()">✕</Button>
            </div>
            <div class="pl-row">
              <input class="sm-input pl-in pl-in--sm" placeholder="production — press Enter" @keyup.enter="addEnvName(entry.p, ($event.target as HTMLInputElement).value); ($event.target as HTMLInputElement).value = ''" />
            </div>
          </section>
        </div>

        <p class="pl-muted pl-foot">
          The form covers the full kaiad.yaml schema; the Raw tab stays
          available for hand-editing or anything unusual.
        </p>
      </div>

      <!-- validation + actions -->
      <div class="pl-actions">
        <span class="sm-badge" :class="validation.ok ? 'sm-badge--success' : 'sm-badge--danger'">
          {{ validation.ok ? '✓' : '✗' }} {{ validation.reason }}
        </span>
        <div class="pl-actions__btns">
          <Button variant="primary" size="md" :loading="saving" :disabled="!validation.ok" @click="saveAndDeploy">
            Save &amp; deploy
          </Button>
          <Button variant="secondary" size="md" :loading="saving" :disabled="!validation.ok" @click="save">
            Save only
          </Button>
          <Button variant="ghost" size="md" :disabled="saving || !hadOverride" @click="clearOverride">
            {{ scope === 'service' ? 'Clear (this service)' : 'Clear (repo override)' }}
          </Button>
        </div>
      </div>
      <p
        v-if="message"
        class="pl-msg"
        :class="messageOk ? 'pl-msg--ok' : 'pl-msg--err'"
      >{{ message }}</p>
    </template>
  </Card>
</template>

<style scoped>
.pl-muted {
  color: var(--color-text-secondary);
  font-size: 0.875rem;
}
.pl-scope {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 0.6rem 0.85rem;
  margin: 0 0 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.pl-scope__legend {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--color-text-secondary);
  padding: 0 0.35rem;
}
.pl-scope__opt {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 0.875rem;
  cursor: pointer;
}
.pl-scope__text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.pl-scope__svcs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding-top: 0.35rem;
  border-top: 1px dashed var(--color-border);
}
.pl-foot {
  margin: 0.75rem 0 0;
}

/* Tabs — segmented control */
.pl-tabs {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.2rem;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  margin-bottom: 0.85rem;
}
.pl-tab {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  font-weight: 600;
  padding: 0.35rem 0.9rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.pl-tab:hover {
  color: var(--color-text);
}
.pl-tab--active {
  background: var(--color-surface);
  color: var(--color-primary);
  box-shadow: 0 1px 2px rgb(15 23 42 / 8%);
}

.pl-yaml {
  width: 100%;
  min-height: 22rem;
  padding: 0.75rem;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
  white-space: pre;
  color: var(--color-text);
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border-strong);
  border-radius: 8px;
  resize: vertical;
}
.pl-yaml:focus {
  outline: none;
  border-color: var(--color-primary);
}

/* Form */
.pl-form__bar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.5rem;
}
.pl-pipeline {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 0.85rem;
  margin: 0.65rem 0;
  background: var(--color-surface-muted);
}
.pl-pipeline__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.35rem;
}
.pl-pipeline__name {
  font-weight: 600;
  font-size: 0.9rem;
}
.pl-section {
  border-top: 1px solid var(--color-border);
  padding-top: 0.6rem;
  margin-top: 0.6rem;
}
.pl-section__title {
  margin: 0 0 0.45rem;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--color-text-secondary);
}
.pl-hint {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}
.pl-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
  margin: 0.3rem 0;
}
.pl-row--indent {
  padding-left: 1.25rem;
}
.pl-label {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.pl-eq {
  color: var(--color-text-muted);
}
.pl-in {
  width: auto;
  min-width: 9rem;
  flex: 1 1 9rem;
  padding: 0.35rem 0.55rem;
  font-size: 0.8rem;
}
.pl-in--sm {
  min-width: 6rem;
  flex: 0 0 auto;
}
.pl-in--xs {
  min-width: 4.5rem;
  flex: 0 0 4.5rem;
}
.pl-vol {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.5rem;
  margin: 0.4rem 0;
  background: var(--color-surface);
}
.pl-check {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.pl-tag {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  background: var(--color-surface);
  border: 1px solid var(--color-border-strong);
  font-size: 0.8rem;
  font-weight: 600;
  min-width: 5rem;
  justify-content: center;
}

.pl-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: 0.9rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-border);
}
.pl-actions__btns {
  display: flex;
  gap: 0.5rem;
}
.pl-msg {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
}
.pl-msg--ok {
  color: var(--color-success);
}
.pl-msg--err {
  color: var(--color-danger);
}
</style>
