<script setup lang="ts">
import { onMounted, ref, type CSSProperties } from "vue";
import { KeyRound } from "lucide-vue-next";
import { api, type ApiCredential, type ApiCredentialScope } from "../../lib/api.js";

// CRUD for tenant API credentials — long-lived bearer tokens for
// programmatic / machine access (e.g. the kaiad operator's
// KAIAD_API_CREDENTIAL). There is no update: rotate by revoking and
// creating a new one.
const SCOPES: { value: ApiCredentialScope; label: string }[] = [
  {
    value: "agents.read",
    label: "Read agents — status & versions (operator status polling + auto-update)"
  },
  { value: "enrollment-tokens.create", label: "Create agent enrollment tokens" },
  { value: "registry.pull", label: "Registry pull — pull images from the built-in OCI registry" },
  {
    value: "registry.push",
    label: "Registry push — push (and pull) images to the built-in OCI registry"
  }
];

const credentials = ref<ApiCredential[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const name = ref("");
const selectedScopes = ref<ApiCredentialScope[]>(["agents.read"]);
const creating = ref(false);
const newToken = ref<string | null>(null);
const copyMessage = ref<string | null>(null);
const revokingId = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    credentials.value = (await api.listApiCredentials()).credentials;
    error.value = null;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function toggleScope(s: ApiCredentialScope): void {
  selectedScopes.value = selectedScopes.value.includes(s)
    ? selectedScopes.value.filter((x) => x !== s)
    : [...selectedScopes.value, s];
}

async function handleCreate(): Promise<void> {
  error.value = null;
  newToken.value = null;
  copyMessage.value = null;
  if (!name.value.trim()) {
    error.value = "Give the credential a name.";
    return;
  }
  if (selectedScopes.value.length === 0) {
    error.value = "Select at least one scope.";
    return;
  }
  creating.value = true;
  try {
    const created = await api.createApiCredential({
      name: name.value.trim(),
      scopes: selectedScopes.value
    });
    const { token, ...metadata } = created;
    credentials.value = [metadata, ...credentials.value];
    newToken.value = token;
    name.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    creating.value = false;
  }
}

async function handleCopy(): Promise<void> {
  if (!newToken.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(newToken.value);
    copyMessage.value = "Copied token to clipboard.";
  } catch {
    copyMessage.value = "Unable to copy automatically.";
  }
}

async function handleRevoke(id: string): Promise<void> {
  const c = credentials.value.find((x) => x.id === id);
  if (!c || c.revokedAt) return;
  if (!window.confirm(`Revoke API credential "${c.name}"? Any client using it stops working.`)) return;
  error.value = null;
  revokingId.value = id;
  try {
    await api.deleteApiCredential(id);
    credentials.value = credentials.value.map((x) =>
      x.id === id ? { ...x, revokedAt: new Date().toISOString() } : x
    );
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    revokingId.value = null;
  }
}

const sectionStyle: CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "10px",
  padding: "1rem",
  marginTop: "1rem"
};
const h3Style: CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "1rem",
  display: "flex",
  alignItems: "center",
  gap: "0.4rem"
};
const mutedText: CSSProperties = {
  color: "var(--color-text-secondary)",
  margin: 0,
  fontSize: "0.85rem"
};
const inputStyle: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  padding: "0.35rem 0.45rem",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)",
  minWidth: "220px"
};
function primaryBtn(disabled: boolean): CSSProperties {
  return {
    background: "var(--color-primary)",
    color: "var(--color-primary-foreground)",
    border: "none",
    borderRadius: "6px",
    padding: "0.45rem 0.85rem",
    fontSize: "0.85rem",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.75 : 1
  };
}
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "0.4rem",
  borderBottom: "1px solid var(--color-border)",
  color: "var(--color-text-secondary)",
  fontSize: "0.8rem"
};
const tdStyle: CSSProperties = { padding: "0.4rem", fontSize: "0.82rem", verticalAlign: "top" };
</script>

<template>
  <div :style="sectionStyle">
    <h3 :style="h3Style"><KeyRound :size="16" /> API Credentials</h3>
    <p :style="mutedText">
      Long-lived bearer tokens for programmatic access — e.g. the kaiad operator's
      <code>KAIAD_API_CREDENTIAL</code>. The token is shown once at creation. Rotate by revoking and creating a
      new one.
    </p>

    <div
      :style="{ display: 'flex', gap: '0.75rem', alignItems: 'start', flexWrap: 'wrap', margin: '0.85rem 0 0' }"
    >
      <label :style="{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem' }">
        <span :style="{ color: 'var(--color-text-secondary)' }">Name</span>
        <input
          v-model="name"
          aria-label="Credential name"
          placeholder="kaiad-operator"
          :style="inputStyle"
        />
      </label>
      <fieldset
        :style="{
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          padding: '0.3rem 0.6rem 0.5rem',
          margin: 0
        }"
      >
        <legend :style="{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', padding: '0 0.3rem' }">
          Scopes
        </legend>
        <label
          v-for="s in SCOPES"
          :key="s.value"
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontSize: '0.8rem',
            margin: '0.2rem 0'
          }"
        >
          <input
            type="checkbox"
            :checked="selectedScopes.includes(s.value)"
            @change="toggleScope(s.value)"
          />
          {{ s.label }}
        </label>
      </fieldset>
      <button :disabled="creating" :style="primaryBtn(creating)" @click="handleCreate">
        {{ creating ? "Creating…" : "Create credential" }}
      </button>
    </div>

    <p
      v-if="error"
      :style="{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0.6rem 0 0' }"
    >{{ error }}</p>

    <div
      v-if="newToken"
      :style="{
        marginTop: '0.75rem',
        background: 'var(--color-surface-muted)',
        border: '1px solid var(--color-border)',
        borderRadius: '6px',
        padding: '0.65rem'
      }"
    >
      <div :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: '0.35rem' }">
        New API credential (copy now — shown only once):
      </div>
      <code :style="{ display: 'block', fontSize: '0.8rem', wordBreak: 'break-all' }">{{ newToken }}</code>
      <div :style="{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }">
        <button
          type="button"
          :style="{
            background: 'var(--color-surface)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
            borderRadius: '6px',
            padding: '0.35rem 0.65rem',
            fontSize: '0.8rem',
            cursor: 'pointer'
          }"
          @click="handleCopy"
        >Copy token</button>
        <span
          v-if="copyMessage"
          :style="{
            fontSize: '0.8rem',
            color: copyMessage.startsWith('Copied') ? 'var(--color-success)' : 'var(--color-danger)'
          }"
        >{{ copyMessage }}</span>
      </div>
    </div>

    <p v-if="loading" :style="{ ...mutedText, marginTop: '0.85rem' }">Loading credentials…</p>
    <p v-else-if="credentials.length === 0" :style="{ ...mutedText, marginTop: '0.85rem' }">
      No API credentials yet.
    </p>
    <table v-else :style="{ width: '100%', borderCollapse: 'collapse', marginTop: '0.85rem' }">
      <thead>
        <tr>
          <th v-for="h in ['Name', 'Scopes', 'Status', 'Created', 'Last used', '']" :key="h" :style="thStyle">
            {{ h }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in credentials" :key="c.id">
          <td :style="tdStyle">{{ c.name }}</td>
          <td :style="{ ...tdStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.76rem' }">
            {{ c.scopes.join(", ") }}
          </td>
          <td :style="tdStyle">
            <span :style="{ color: c.revokedAt ? 'var(--color-danger)' : 'var(--color-success)' }">
              {{ c.revokedAt ? "Revoked" : "Active" }}
            </span>
          </td>
          <td :style="tdStyle">{{ new Date(c.createdAt).toLocaleString() }}</td>
          <td :style="tdStyle">{{ c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : "—" }}</td>
          <td :style="tdStyle">
            <button
              type="button"
              :aria-label="`Revoke credential ${c.name}`"
              :disabled="revokingId === c.id || !!c.revokedAt"
              :style="{
                background: 'var(--color-danger-bg)',
                color: 'var(--color-danger)',
                border: '1px solid var(--color-border)',
                borderRadius: '6px',
                padding: '0.3rem 0.55rem',
                fontSize: '0.75rem',
                cursor: revokingId === c.id || c.revokedAt ? 'not-allowed' : 'pointer',
                opacity: revokingId === c.id || c.revokedAt ? 0.6 : 1
              }"
              @click="handleRevoke(c.id)"
            >{{ revokingId === c.id ? "Revoking…" : "Revoke" }}</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
