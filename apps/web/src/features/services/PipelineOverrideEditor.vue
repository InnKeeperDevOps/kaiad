<script setup lang="ts">
// Panel editor for a service's kaiad.yaml override. Two tabs:
//  - Raw YAML: the canonical stored text, live-validated against the
//    Kaiad contracts schema (parsePipelineYaml).
//  - Form: guided controls for the common deploy knobs (load balancer +
//    pinned IPs, domains, env, secret-ref env, volumes, per-environment
//    namespace/IP overrides, multi-service add/remove). The form edits
//    the parsed object and re-serialises to the YAML text, which stays
//    the single source of truth that gets saved.
import { ref, computed, watch, onMounted } from "vue";
import { api } from "../../lib/api.js";
import { parsePipelineYaml, yamlParse, yamlStringify } from "@sm/contracts";

const props = defineProps<{ serviceId: string; serviceName: string }>();

const loading = ref(true);
const saving = ref(false);
const tab = ref<"raw" | "form">("raw");
const yamlText = ref("");
const hadOverride = ref(false);
const message = ref<string | null>(null);
const messageOk = ref(false);

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
  const summary =
    r.kind === "multi"
      ? `valid — multi-service (${Object.keys(r.pipelines).join(", ")})`
      : "valid — single pipeline";
  return { ok: true, reason: summary };
});

onMounted(async () => {
  try {
    const r = await api.getPipelineOverride(props.serviceId);
    hadOverride.value = r.override != null;
    yamlText.value = r.override ?? STARTER;
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

// A multi-service doc has `services: {name: {...}}`; a single doc is the
// pipeline itself. We normalise to a list of {name, pipeline} the form
// edits in place; name === "" means the single (top-level) pipeline.
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
function envRows(p: AnyObj) {
  const e = ensure(ensure(p, "runtime", {}), "env", {});
  return Object.keys(e).map((k) => ({ k, v: e[k] }));
}
function setEnv(p: AnyObj, rows: { k: string; v: string }[]) {
  const e: AnyObj = {};
  for (const r of rows) if (r.k.trim()) e[r.k.trim()] = r.v;
  ensure(p, "runtime", {}).env = e;
  syncYamlFromForm();
}
function lb(p: AnyObj) {
  return ensure(p, "loadBalancer", { type: "none" });
}
function arr(p: AnyObj, parentKey: string | null, key: string): AnyObj[] {
  const parent = parentKey ? ensure(p, parentKey, {}) : p;
  if (!Array.isArray(parent[key])) parent[key] = [];
  return parent[key];
}

function addMulti() {
  if (!doc.value.services) {
    // Convert the current single pipeline into the first service.
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
    message.value = `Fix errors first: ${validation.value.reason}`;
    messageOk.value = false;
    return;
  }
  saving.value = true;
  message.value = null;
  try {
    await api.savePipelineOverride(props.serviceId, yamlText.value);
    hadOverride.value = true;
    messageOk.value = true;
    message.value = "Override saved. It applies on the next build.";
  } catch (e) {
    messageOk.value = false;
    message.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
async function clearOverride() {
  if (!window.confirm("Remove the panel override? Builds will use the repo's kaiad.yaml again.")) return;
  saving.value = true;
  try {
    await api.clearPipelineOverride(props.serviceId);
    hadOverride.value = false;
    yamlText.value = STARTER;
    messageOk.value = true;
    message.value = "Override cleared — reverting to the repo kaiad.yaml.";
  } catch (e) {
    messageOk.value = false;
    message.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

const box = { fontFamily: "monospace", fontSize: "0.8rem" } as const;
const tabBtn = (active: boolean) => ({
  padding: "0.3rem 0.8rem",
  cursor: "pointer",
  border: "1px solid var(--color-border)",
  borderBottom: active ? "2px solid var(--color-accent, #4c8)" : "1px solid var(--color-border)",
  background: active ? "var(--color-bg-elev, #1b1b1b)" : "transparent",
  fontWeight: active ? 600 : 400
});
const fieldRow = { display: "flex", gap: "0.4rem", margin: "0.25rem 0", alignItems: "center", flexWrap: "wrap" as const };
const inp = { ...box, padding: "0.25rem 0.4rem", minWidth: "8rem" } as const;
</script>

<template>
  <div :style="{ padding: '0.5rem', border: '1px solid var(--color-border)', borderRadius: '4px' }">
    <div :style="{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }">
      <strong>Pipeline override — <code>kaiad.yaml</code></strong>
      <span :style="{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }">
        {{ hadOverride ? 'override active (repo file ignored)' : 'no override — repo kaiad.yaml in use' }}
      </span>
    </div>

    <div v-if="loading">Loading…</div>
    <template v-else>
      <div :style="{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem' }">
        <button type="button" :style="tabBtn(tab === 'raw')" @click="tab = 'raw'">Raw YAML</button>
        <button type="button" :style="tabBtn(tab === 'form')" @click="tab = 'form'">Form</button>
      </div>

      <!-- RAW -->
      <div v-show="tab === 'raw'">
        <textarea
          v-model="yamlText"
          spellcheck="false"
          :style="{ ...box, width: '100%', minHeight: '20rem', padding: '0.5rem', whiteSpace: 'pre' }"
        ></textarea>
      </div>

      <!-- FORM -->
      <div v-show="tab === 'form'">
        <p v-if="formError" :style="{ color: 'var(--color-danger)', fontSize: '0.8rem' }">{{ formError }}</p>
        <div :style="{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }">
          <button type="button" :style="inp" @click="addMulti">+ Add service (multi)</button>
        </div>
        <div
          v-for="entry in pipelines"
          :key="entry.name || '<single>'"
          :style="{ border: '1px dashed var(--color-border)', borderRadius: '4px', padding: '0.5rem', margin: '0.5rem 0' }"
        >
          <div :style="{ display: 'flex', justifyContent: 'space-between' }">
            <strong>{{ entry.name || '(single pipeline)' }}</strong>
            <button v-if="entry.name" type="button" :style="inp" @click="removeService(entry.name)">remove</button>
          </div>

          <!-- Load balancer -->
          <fieldset :style="{ margin: '0.5rem 0', border: '1px solid var(--color-border)', padding: '0.4rem' }">
            <legend>Load balancer</legend>
            <div :style="fieldRow">
              <label>type</label>
              <select :style="inp" v-model="lb(entry.p).type" @change="syncYamlFromForm">
                <option value="none">none</option>
                <option value="metallb">metallb</option>
                <option value="k8s">k8s</option>
                <option value="nginx">nginx</option>
              </select>
              <template v-if="lb(entry.p).type === 'metallb'">
                <label>addressPool</label>
                <input :style="inp" v-model="lb(entry.p).addressPool" @input="syncYamlFromForm" placeholder="first-pool" />
                <label>loadBalancerIPs</label>
                <input :style="inp" v-model="lb(entry.p).loadBalancerIPs" @input="syncYamlFromForm" placeholder="192.168.1.230" />
              </template>
              <template v-if="lb(entry.p).type === 'nginx'">
                <label>ingressClass</label>
                <input :style="inp" v-model="lb(entry.p).ingressClass" @input="syncYamlFromForm" placeholder="nginx" />
                <label>tlsSecret</label>
                <input :style="inp" v-model="lb(entry.p).tlsSecret" @input="syncYamlFromForm" />
              </template>
            </div>
          </fieldset>

          <!-- Domains -->
          <fieldset :style="{ margin: '0.5rem 0', border: '1px solid var(--color-border)', padding: '0.4rem' }">
            <legend>Domains</legend>
            <div v-for="(d, i) in arr(entry.p, null, 'domains')" :key="i" :style="fieldRow">
              <input :style="inp" v-model="d.host" @input="syncYamlFromForm" placeholder="host.example.com" />
              <input :style="{ ...inp, minWidth: '5rem' }" type="number" v-model.number="d.port" @input="syncYamlFromForm" placeholder="80" />
              <select :style="inp" v-model="d.protocol" @change="syncYamlFromForm">
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
              <button type="button" :style="inp" @click="arr(entry.p, null, 'domains').splice(i, 1); syncYamlFromForm()">×</button>
            </div>
            <button type="button" :style="inp" @click="arr(entry.p, null, 'domains').push({ host: '', port: 80, protocol: 'https' }); syncYamlFromForm()">+ domain</button>
          </fieldset>

          <!-- Env -->
          <fieldset :style="{ margin: '0.5rem 0', border: '1px solid var(--color-border)', padding: '0.4rem' }">
            <legend>Env vars</legend>
            <div
              v-for="(row, i) in Object.entries(ensure(ensure(entry.p,'runtime',{}),'env',{}))"
              :key="'e'+i"
              :style="fieldRow"
            >
              <input :style="inp" :value="row[0]" readonly />
              <span>=</span>
              <input :style="inp" v-model="ensure(ensure(entry.p,'runtime',{}),'env',{})[row[0]]" @input="syncYamlFromForm" />
              <button type="button" :style="inp" @click="delete ensure(ensure(entry.p,'runtime',{}),'env',{})[row[0]]; syncYamlFromForm()">×</button>
            </div>
            <div :style="fieldRow">
              <input :style="inp" placeholder="NEW_KEY" @keyup.enter="(ev:any)=>{ const k=ev.target.value.trim(); if(k){ ensure(ensure(entry.p,'runtime',{}),'env',{})[k]=''; ev.target.value=''; syncYamlFromForm(); } }" />
              <span :style="{ fontSize:'0.72rem', color:'var(--color-text-secondary)' }">type a name, press Enter</span>
            </div>
          </fieldset>

          <!-- Secret-ref env -->
          <fieldset :style="{ margin: '0.5rem 0', border: '1px solid var(--color-border)', padding: '0.4rem' }">
            <legend>Secret-ref env (existing k8s Secret)</legend>
            <div v-for="(s, i) in arr(entry.p, 'runtime', 'secretEnv')" :key="'s'+i" :style="fieldRow">
              <input :style="inp" v-model="s.name" @input="syncYamlFromForm" placeholder="ENV_NAME" />
              <span>←</span>
              <input :style="inp" v-model="s.secret" @input="syncYamlFromForm" placeholder="secret-name" />
              <input :style="inp" v-model="s.key" @input="syncYamlFromForm" placeholder="key" />
              <button type="button" :style="inp" @click="arr(entry.p,'runtime','secretEnv').splice(i,1); syncYamlFromForm()">×</button>
            </div>
            <button type="button" :style="inp" @click="arr(entry.p,'runtime','secretEnv').push({ name:'', secret:'', key:'' }); syncYamlFromForm()">+ secret env</button>
          </fieldset>

          <!-- Volumes -->
          <fieldset :style="{ margin: '0.5rem 0', border: '1px solid var(--color-border)', padding: '0.4rem' }">
            <legend>Volumes</legend>
            <div v-for="(v, i) in arr(entry.p, 'runtime', 'volumes')" :key="'v'+i" :style="{ border:'1px solid var(--color-border)', padding:'0.3rem', margin:'0.3rem 0' }">
              <div :style="fieldRow">
                <input :style="inp" v-model="v.name" @input="syncYamlFromForm" placeholder="volume-name" />
                <select :style="inp" :value="v.nfs?'nfs':v.hostPath?'hostPath':v.persistentVolumeClaim?'pvc':'emptyDir'"
                  @change="(ev:any)=>{ delete v.nfs;delete v.hostPath;delete v.persistentVolumeClaim;delete v.emptyDir; const t=ev.target.value; if(t==='nfs')v.nfs={server:'',path:'/'}; else if(t==='hostPath')v.hostPath={path:'/'}; else if(t==='pvc')v.persistentVolumeClaim={claimName:''}; else v.emptyDir=true; syncYamlFromForm(); }">
                  <option value="nfs">nfs</option>
                  <option value="hostPath">hostPath</option>
                  <option value="pvc">pvc</option>
                  <option value="emptyDir">emptyDir</option>
                </select>
                <template v-if="v.nfs">
                  <input :style="inp" v-model="v.nfs.server" @input="syncYamlFromForm" placeholder="192.168.1.147" />
                  <input :style="inp" v-model="v.nfs.path" @input="syncYamlFromForm" placeholder="/data" />
                </template>
                <template v-else-if="v.hostPath">
                  <input :style="inp" v-model="v.hostPath.path" @input="syncYamlFromForm" placeholder="/host/path" />
                </template>
                <template v-else-if="v.persistentVolumeClaim">
                  <input :style="inp" v-model="v.persistentVolumeClaim.claimName" @input="syncYamlFromForm" placeholder="my-pvc" />
                </template>
                <button type="button" :style="inp" @click="arr(entry.p,'runtime','volumes').splice(i,1); syncYamlFromForm()">remove vol</button>
              </div>
              <div v-for="(m, mi) in (v.mounts || (v.mounts=[]))" :key="'m'+mi" :style="fieldRow">
                <span :style="{ fontSize:'0.72rem' }">mount</span>
                <input :style="inp" v-model="m.path" @input="syncYamlFromForm" placeholder="/cache/www/" />
                <label :style="{ fontSize:'0.72rem' }"><input type="checkbox" v-model="m.readOnly" @change="syncYamlFromForm" /> ro</label>
                <button type="button" :style="inp" @click="v.mounts.splice(mi,1); syncYamlFromForm()">×</button>
              </div>
              <button type="button" :style="inp" @click="(v.mounts||(v.mounts=[])).push({ path:'/' }); syncYamlFromForm()">+ mount</button>
            </div>
            <button type="button" :style="inp" @click="arr(entry.p,'runtime','volumes').push({ name:'vol', nfs:{server:'',path:'/'}, mounts:[{path:'/'}] }); syncYamlFromForm()">+ volume</button>
          </fieldset>

          <!-- Per-environment overrides -->
          <fieldset :style="{ margin: '0.5rem 0', border: '1px solid var(--color-border)', padding: '0.4rem' }">
            <legend>Environment overrides</legend>
            <div v-for="envName in Object.keys(ensure(entry.p,'environments',{}))" :key="'env'+envName" :style="fieldRow">
              <strong :style="{ minWidth:'6rem' }">{{ envName }}</strong>
              <label>namespace</label>
              <input :style="inp" v-model="ensure(entry.p,'environments',{})[envName].namespace" @input="syncYamlFromForm" />
              <button type="button" :style="inp" @click="delete ensure(entry.p,'environments',{})[envName]; syncYamlFromForm()">×</button>
            </div>
            <div :style="fieldRow">
              <input :style="inp" placeholder="production" @keyup.enter="(ev:any)=>{ const n=ev.target.value.trim(); if(n){ ensure(entry.p,'environments',{})[n]={namespace:''}; ev.target.value=''; syncYamlFromForm(); } }" />
              <span :style="{ fontSize:'0.72rem', color:'var(--color-text-secondary)' }">env name + Enter</span>
            </div>
          </fieldset>
        </div>
        <p :style="{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }">
          Build steps, command, image &amp; artifacts are edited in the Raw tab.
        </p>
      </div>

      <!-- validation + actions -->
      <div :style="{ marginTop: '0.5rem', fontSize: '0.8rem', color: validation.ok ? 'var(--color-success)' : 'var(--color-danger)' }">
        {{ validation.ok ? '✓' : '✗' }} {{ validation.reason }}
      </div>
      <div :style="{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'center' }">
        <button type="button" :disabled="saving || !validation.ok" :style="{ ...inp, fontWeight: 600 }" @click="save">
          {{ saving ? 'Saving…' : 'Save override' }}
        </button>
        <button type="button" :disabled="saving || !hadOverride" :style="inp" @click="clearOverride">
          Clear (use repo file)
        </button>
        <span v-if="message" :style="{ fontSize: '0.8rem', color: messageOk ? 'var(--color-success)' : 'var(--color-danger)' }">
          {{ message }}
        </span>
      </div>
    </template>
  </div>
</template>
