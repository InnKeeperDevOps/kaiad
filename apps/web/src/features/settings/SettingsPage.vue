<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Settings, Lock, Database } from "lucide-vue-next";
import {
  api,
  type AuthProviderEntry,
  type OAuthProviderConfigPayload,
  type RegistryRetentionPolicy,
  type RegistryStats,
  type RegistryGcStats
} from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

const GOOGLE_OAUTH_DEFAULTS: Pick<
  OAuthProviderConfigPayload,
  "id" | "provider" | "authorizeUrl" | "tokenUrl" | "userInfoUrl" | "scopes"
> = {
  id: "google",
  provider: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  scopes: ["openid", "email", "profile"]
};

const auth = useAuth();
const canManageOAuth = computed(() => auth.value.role === "owner" || auth.value.role === "admin");

const authProviders = ref<AuthProviderEntry[]>([]);
const oauthId = ref("");
const oauthProviderKind = ref("");
const oauthClientId = ref("");
const oauthClientSecret = ref("");
const oauthAuthorizeUrl = ref("");
const oauthTokenUrl = ref("");
const oauthUserInfoUrl = ref("");
const oauthScopesInput = ref("");
const oauthFormError = ref<string | null>(null);
const oauthSuccess = ref<string | null>(null);
const isSubmittingOAuth = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const r = await api.getAuthProviders();
    authProviders.value = r.providers;
  } catch {
    /* ignore */
  }
});

async function refreshAuthProviders() {
  try {
    const r = await api.getAuthProviders();
    authProviders.value = r.providers;
  } catch {
    /* ignore */
  }
}

function parseScopesInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function handleSubmitOAuthProvider() {
  oauthFormError.value = null;
  oauthSuccess.value = null;

  const scopes = parseScopesInput(oauthScopesInput.value);
  const payload: OAuthProviderConfigPayload = {
    id: oauthId.value.trim(),
    provider: oauthProviderKind.value.trim(),
    clientId: oauthClientId.value.trim(),
    clientSecret: oauthClientSecret.value,
    authorizeUrl: oauthAuthorizeUrl.value.trim(),
    tokenUrl: oauthTokenUrl.value.trim(),
    userInfoUrl: oauthUserInfoUrl.value.trim(),
    scopes
  };

  if (!payload.id || !payload.provider || !payload.clientId) {
    oauthFormError.value = "Provider id, provider type, and client id are required.";
    return;
  }
  if (!payload.authorizeUrl || !payload.tokenUrl || !payload.userInfoUrl) {
    oauthFormError.value = "Authorize, token, and user info URLs are required.";
    return;
  }

  isSubmittingOAuth.value = true;
  try {
    await api.createOAuthProvider(payload);
    oauthClientSecret.value = "";
    oauthSuccess.value = `Provider “${payload.id}” saved. It appears on the login page for OAuth sign-in.`;
    await refreshAuthProviders();
    error.value = null;
  } catch (e) {
    oauthFormError.value = (e as Error).message;
  } finally {
    isSubmittingOAuth.value = false;
  }
}

function applyGoogleDefaults() {
  oauthFormError.value = null;
  oauthSuccess.value = null;
  oauthId.value = GOOGLE_OAUTH_DEFAULTS.id;
  oauthProviderKind.value = GOOGLE_OAUTH_DEFAULTS.provider;
  oauthAuthorizeUrl.value = GOOGLE_OAUTH_DEFAULTS.authorizeUrl;
  oauthTokenUrl.value = GOOGLE_OAUTH_DEFAULTS.tokenUrl;
  oauthUserInfoUrl.value = GOOGLE_OAUTH_DEFAULTS.userInfoUrl;
  oauthScopesInput.value = GOOGLE_OAUTH_DEFAULTS.scopes.join(" ");
}

// --- Registry retention ---------------------------------------------------
const GB = 1024 * 1024 * 1024;
const registryPolicy = ref<RegistryRetentionPolicy | null>(null);
const registryStats = ref<RegistryStats | null>(null);
const registryError = ref<string | null>(null);
const registryFormKeepN = ref(10);
const registryFormMaxGb = ref(64);
const registryFormDays = ref(0);
const registrySaving = ref(false);
const registryRunning = ref(false);
const registryLastRun = ref<RegistryGcStats | null>(null);

async function loadRegistry() {
  try {
    const r = await api.getRegistryRetention();
    registryPolicy.value = r.policy;
    registryStats.value = r.stats;
    registryFormKeepN.value = r.policy.keepLastNPerRepo;
    registryFormMaxGb.value = Math.round((r.policy.maxTotalBytes / GB) * 100) / 100;
    registryFormDays.value = r.policy.keepForDays;
  } catch (e) {
    registryError.value = (e as Error).message;
  }
}
async function saveRegistry() {
  registrySaving.value = true;
  registryError.value = null;
  try {
    const r = await api.updateRegistryRetention({
      keepLastNPerRepo: Math.max(0, Math.floor(registryFormKeepN.value)),
      maxTotalBytes: Math.max(0, Math.round(registryFormMaxGb.value * GB)),
      keepForDays: Math.max(0, Math.floor(registryFormDays.value))
    });
    registryPolicy.value = r.policy;
    registryStats.value = r.stats;
  } catch (e) {
    registryError.value = (e as Error).message;
  } finally {
    registrySaving.value = false;
  }
}
async function runRegistry() {
  registryRunning.value = true;
  registryError.value = null;
  try {
    registryLastRun.value = await api.runRegistryRetention();
    await loadRegistry();
  } catch (e) {
    registryError.value = (e as Error).message;
  } finally {
    registryRunning.value = false;
  }
}
function fmtBytes(b: number): string {
  if (b >= GB) return `${(b / GB).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

onMounted(loadRegistry);

const sectionStyle = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: "10px",
  padding: "1rem",
  marginBottom: "1rem"
} as const;
const inputStyle = {
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  padding: "0.35rem 0.45rem",
  background: "var(--color-surface)",
  color: "var(--color-text-primary)",
  width: "100%",
  maxWidth: "420px",
  boxSizing: "border-box"
} as const;
const labelColStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.8rem",
  marginBottom: "0.65rem"
} as const;
</script>

<template>
  <section>
    <h2 :style="{ margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }">
      <Settings :size="20" /> Settings
    </h2>
    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.5rem' }">{{ error }}</div>

    <div :style="sectionStyle">
      <h3 :style="{ margin: '0 0 0.75rem', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }">
        <Lock :size="16" /> Authentication
      </h3>
      <p :style="{ color: 'var(--color-text-secondary)', margin: 0, fontSize: '0.85rem' }">
        Email and password sign-in uses local accounts on the login page. Configure OAuth/OIDC providers here (or via
        <code>POST /api/v1/settings/oauth-providers</code>) so users see "Sign in with …" on the login page.
      </p>
      <p
        v-if="authProviders.length === 0"
        :style="{ color: 'var(--color-text-secondary)', margin: 0, fontSize: '0.85rem', marginTop: '0.5rem' }"
      >
        No OAuth providers configured yet.
      </p>
      <table v-else :style="{ width: '100%', borderCollapse: 'collapse', marginTop: '0.75rem' }">
        <thead>
          <tr>
            <th
              v-for="h in ['ID', 'Name', 'Provider']"
              :key="h"
              :style="{
                textAlign: 'left',
                padding: '0.4rem',
                borderBottom: '1px solid var(--color-border)',
                color: 'var(--color-text-secondary)',
                fontSize: '0.8rem'
              }"
            >{{ h }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in authProviders" :key="p.id">
            <td :style="{ padding: '0.4rem', fontSize: '0.85rem', fontFamily: 'monospace' }">{{ p.id }}</td>
            <td :style="{ padding: '0.4rem', fontSize: '0.85rem' }">{{ p.name }}</td>
            <td :style="{ padding: '0.4rem', fontSize: '0.85rem' }">{{ p.provider }}</td>
          </tr>
        </tbody>
      </table>

      <p
        v-if="!canManageOAuth"
        :style="{ color: 'var(--color-text-secondary)', margin: 0, fontSize: '0.85rem', marginTop: '0.75rem' }"
      >
        Only owners and admins can add or change OAuth providers. Ask an administrator to update configuration.
      </p>

      <div
        v-if="canManageOAuth"
        :style="{
          marginTop: '1rem',
          paddingTop: '1rem',
          borderTop: '1px solid var(--color-border)'
        }"
      >
        <div
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
            marginBottom: '0.75rem'
          }"
        >
          <span :style="{ fontSize: '0.85rem', fontWeight: 600 }">Add OAuth provider</span>
          <button
            type="button"
            :style="{
              background: 'var(--color-surface-muted)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '0.3rem 0.55rem',
              fontSize: '0.78rem',
              cursor: 'pointer'
            }"
            @click="applyGoogleDefaults"
          >Use Google defaults</button>
        </div>
        <p
          v-if="oauthFormError"
          :style="{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0 0 0.5rem' }"
        >{{ oauthFormError }}</p>
        <p
          v-if="oauthSuccess"
          :style="{ color: 'var(--color-success)', fontSize: '0.85rem', margin: '0 0 0.5rem' }"
        >{{ oauthSuccess }}</p>

        <div :style="{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0 1rem' }">
          <label :style="labelColStyle">
            <span :style="{ color: 'var(--color-text-secondary)' }">Provider id</span>
            <input v-model="oauthId" aria-label="Provider id" placeholder="e.g. google" autocomplete="off" :style="inputStyle" />
          </label>
          <label :style="labelColStyle">
            <span :style="{ color: 'var(--color-text-secondary)' }">Provider type</span>
            <input v-model="oauthProviderKind" aria-label="Provider type" placeholder="google, oidc, …" autocomplete="off" :style="inputStyle" />
          </label>
        </div>
        <label :style="labelColStyle">
          <span :style="{ color: 'var(--color-text-secondary)' }">Client ID</span>
          <input v-model="oauthClientId" aria-label="Client ID" autocomplete="off" :style="inputStyle" />
        </label>
        <label :style="labelColStyle">
          <span :style="{ color: 'var(--color-text-secondary)' }">Client secret</span>
          <input v-model="oauthClientSecret" aria-label="Client secret" type="password" autocomplete="new-password" :style="inputStyle" />
        </label>
        <label :style="labelColStyle">
          <span :style="{ color: 'var(--color-text-secondary)' }">Authorize URL</span>
          <input v-model="oauthAuthorizeUrl" aria-label="Authorize URL" :style="{ ...inputStyle, maxWidth: '100%' }" />
        </label>
        <label :style="labelColStyle">
          <span :style="{ color: 'var(--color-text-secondary)' }">Token URL</span>
          <input v-model="oauthTokenUrl" aria-label="Token URL" :style="{ ...inputStyle, maxWidth: '100%' }" />
        </label>
        <label :style="labelColStyle">
          <span :style="{ color: 'var(--color-text-secondary)' }">User info URL</span>
          <input v-model="oauthUserInfoUrl" aria-label="User info URL" :style="{ ...inputStyle, maxWidth: '100%' }" />
        </label>
        <label :style="labelColStyle">
          <span :style="{ color: 'var(--color-text-secondary)' }">Scopes (space or comma separated)</span>
          <textarea
            v-model="oauthScopesInput"
            aria-label="OAuth scopes"
            :rows="2"
            placeholder="openid email profile"
            :style="{
              ...inputStyle,
              maxWidth: '100%',
              resize: 'vertical',
              minHeight: '2.5rem',
              fontFamily: 'inherit'
            }"
          />
        </label>
        <button
          type="button"
          :disabled="isSubmittingOAuth"
          :style="{
            background: 'var(--color-primary)',
            color: 'var(--color-primary-foreground)',
            border: 'none',
            borderRadius: '6px',
            padding: '0.45rem 0.8rem',
            fontSize: '0.85rem',
            cursor: isSubmittingOAuth ? 'not-allowed' : 'pointer',
            opacity: isSubmittingOAuth ? 0.75 : 1,
            marginTop: '0.25rem'
          }"
          @click="handleSubmitOAuthProvider"
        >{{ isSubmittingOAuth ? "Saving…" : "Save provider" }}</button>
      </div>
    </div>

    <div :style="sectionStyle">
      <h3 :style="{ margin: '0 0 0.75rem', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }">
        <Database :size="16" /> Registry retention
      </h3>
      <p :style="{ color: 'var(--color-text-secondary)', margin: 0, fontSize: '0.85rem' }">
        Every kaiad build pushes an image to the built-in registry. These
        policies cap retention so the registry doesn't grow forever — a
        background sweep applies them every 30 minutes (and you can run
        it now with the button below).
      </p>
      <div v-if="registryError" :style="{ color: 'var(--color-danger)', marginTop: '0.5rem' }">{{ registryError }}</div>

      <div
        v-if="registryStats"
        :style="{ marginTop: '0.75rem', display: 'flex', gap: '1.25rem', flexWrap: 'wrap', fontSize: '0.85rem' }"
      >
        <div>
          <div :style="{ color: 'var(--color-text-secondary)' }">Current size</div>
          <div :style="{ fontWeight: 600 }">{{ fmtBytes(registryStats.totalBytes) }}</div>
        </div>
        <div>
          <div :style="{ color: 'var(--color-text-secondary)' }">Blobs</div>
          <div :style="{ fontWeight: 600 }">{{ registryStats.totalBlobs }}</div>
        </div>
        <div>
          <div :style="{ color: 'var(--color-text-secondary)' }">Repositories</div>
          <div :style="{ fontWeight: 600 }">{{ registryStats.repos.length }}</div>
        </div>
      </div>

      <div :style="{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginTop: '1rem', maxWidth: '780px' }">
        <label :style="labelColStyle">
          <span>Keep last N per repository</span>
          <input type="number" min="0" v-model.number="registryFormKeepN" :style="inputStyle" />
          <small :style="{ color: 'var(--color-text-secondary)' }">Older tags pruned. `latest` is always kept.</small>
        </label>
        <label :style="labelColStyle">
          <span>Max total size (GB)</span>
          <input type="number" min="0" step="1" v-model.number="registryFormMaxGb" :style="inputStyle" />
          <small :style="{ color: 'var(--color-text-secondary)' }">Drops oldest tags until under cap. 0 = no cap.</small>
        </label>
        <label :style="labelColStyle">
          <span>Keep for at least (days)</span>
          <input type="number" min="0" v-model.number="registryFormDays" :style="inputStyle" />
          <small :style="{ color: 'var(--color-text-secondary)' }">Protects fresh tags from "keep last N". 0 = disabled.</small>
        </label>
      </div>

      <div :style="{ display: 'flex', gap: '0.5rem', marginTop: '0.85rem', flexWrap: 'wrap' }">
        <button
          :disabled="registrySaving"
          :style="{ background: 'var(--color-primary)', color: 'var(--color-primary-foreground)', border: 'none', borderRadius: '6px', padding: '0.45rem 0.8rem', fontSize: '0.85rem', cursor: registrySaving ? 'not-allowed' : 'pointer', opacity: registrySaving ? 0.75 : 1 }"
          @click="saveRegistry"
        >{{ registrySaving ? "Saving…" : "Save policy" }}</button>
        <button
          :disabled="registryRunning"
          :style="{ background: 'transparent', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', borderRadius: '6px', padding: '0.45rem 0.8rem', fontSize: '0.85rem', cursor: registryRunning ? 'not-allowed' : 'pointer', opacity: registryRunning ? 0.75 : 1 }"
          @click="runRegistry"
        >{{ registryRunning ? "Sweeping…" : "Run sweep now" }}</button>
      </div>

      <p
        v-if="registryLastRun"
        :style="{ marginTop: '0.55rem', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }"
      >
        Last sweep: {{ registryLastRun.tagsDeleted }} tag(s),
        {{ registryLastRun.manifestsDeleted }} manifest(s),
        {{ registryLastRun.blobsDeleted }} blob(s) removed —
        reclaimed {{ fmtBytes(registryLastRun.bytesReclaimed) }};
        registry now {{ fmtBytes(registryLastRun.totalBytesAfter) }}.
      </p>

      <details
        v-if="registryStats && registryStats.repos.length > 0"
        :style="{ marginTop: '0.85rem' }"
      >
        <summary :style="{ cursor: 'pointer', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }">
          Per-repository breakdown
        </summary>
        <table :style="{ width: '100%', borderCollapse: 'collapse', marginTop: '0.45rem', fontSize: '0.82rem' }">
          <thead>
            <tr>
              <th :style="{ textAlign: 'left', padding: '0.25rem 0.5rem', borderBottom: '1px solid var(--color-border)' }">Repository</th>
              <th :style="{ textAlign: 'right', padding: '0.25rem 0.5rem', borderBottom: '1px solid var(--color-border)' }">Tags</th>
              <th :style="{ textAlign: 'right', padding: '0.25rem 0.5rem', borderBottom: '1px solid var(--color-border)' }">Size</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in registryStats.repos" :key="r.repo">
              <td :style="{ padding: '0.2rem 0.5rem' }">{{ r.repo }}</td>
              <td :style="{ padding: '0.2rem 0.5rem', textAlign: 'right' }">{{ r.tags }}</td>
              <td :style="{ padding: '0.2rem 0.5rem', textAlign: 'right' }">{{ fmtBytes(r.bytes) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>
  </section>
</template>
