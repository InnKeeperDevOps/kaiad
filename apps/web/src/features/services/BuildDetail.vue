<script setup lang="ts">
import { Download } from "lucide-vue-next";
import { api, type ServiceBuild, type ServiceBuildArtifact } from "../../lib/api.js";

// Expanded-row body for a single build: failure reason, downloadable
// artifacts, the captured kaiad.yaml, and the log buffer. Shared by the
// per-service Builds section and the tenant-wide Builds page so both
// render a build identically.
const props = defineProps<{
  serviceId: string;
  detail: { build: ServiceBuild; artifacts: ServiceBuildArtifact[] } | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  /** Non-fatal problem (e.g. an artifact download failed) for the parent to surface. */
  (e: "error", message: string): void;
}>();

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function downloadArtifact(buildId: string, name: string) {
  // Pull the file via fetch so we can attach the Authorization header,
  // then trigger a download from the resulting blob URL.
  const url = api.serviceBuildArtifactUrl(props.serviceId, buildId, name);
  const token = localStorage.getItem("sm_token") ?? "";
  fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => {
      if (!r.ok) throw new Error(`download ${r.status}`);
      return r.blob();
    })
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    })
    .catch((e) => {
      console.error("[builds] artifact download failed", { serviceId: props.serviceId, buildId, name, err: e });
      emit("error", `Download failed: ${(e as Error).message}`);
    });
}
</script>

<template>
  <p
    v-if="loading && !detail"
    :style="{ color: 'var(--color-text-secondary)', margin: 0 }"
  >
    Loading…
  </p>

  <template v-else-if="detail">
    <p
      v-if="detail.build.failureReason"
      :style="{
        margin: '0 0 0.4rem',
        color: 'var(--color-danger)',
        fontSize: '0.85rem'
      }"
    >
      {{ detail.build.failureReason }}
    </p>

    <div
      v-if="detail.artifacts.length > 0"
      :style="{ margin: '0.25rem 0 0.5rem', fontSize: '0.8rem' }"
    >
      <strong :style="{ color: 'var(--color-text-secondary)' }">Artifacts:</strong>
      <span
        v-for="art in detail.artifacts"
        :key="art.name"
        :style="{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          marginLeft: '0.6rem',
          padding: '0.1rem 0.4rem',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)'
        }"
        @click="downloadArtifact(detail.build.id, art.name)"
      >
        <Download :size="11" /> {{ art.name }}
        <span :style="{ color: 'var(--color-text-secondary)' }">({{ formatBytes(art.sizeBytes) }})</span>
      </span>
    </div>

    <details
      v-if="detail.build.pipelineYaml"
      :style="{ marginTop: '0.4rem', fontSize: '0.8rem' }"
    >
      <summary :style="{ cursor: 'pointer', color: 'var(--color-text-secondary)' }">
        kaiad.yaml at this commit
      </summary>
      <pre
        :style="{
          margin: '0.3rem 0 0',
          padding: '0.5rem 0.6rem',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          overflowX: 'auto',
          fontSize: '0.78rem'
        }"
      >{{ detail.build.pipelineYaml }}</pre>
    </details>

    <details open :style="{ marginTop: '0.4rem', fontSize: '0.8rem' }">
      <summary :style="{ cursor: 'pointer', color: 'var(--color-text-secondary)' }">
        Build log
      </summary>
      <pre
        :style="{
          margin: '0.3rem 0 0',
          padding: '0.5rem 0.6rem',
          background: '#0c0c0c',
          color: '#e6e6e6',
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          maxHeight: '320px',
          overflow: 'auto',
          fontSize: '0.76rem',
          fontFamily: 'var(--font-mono)'
        }"
      >{{ detail.build.log || "(no output yet)" }}</pre>
    </details>
  </template>
</template>
