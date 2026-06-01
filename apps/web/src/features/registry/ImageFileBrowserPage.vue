<script setup lang="ts">
// File browser for a tagged registry image. Two panes:
//   - Left: directory tree built from the flat file list (rendered as
//     a depth-padded flat list to keep the DOM small — typical images
//     have tens of thousands of paths).
//   - Right: file header (size, mode, owning layer) + a viewer that
//     renders text inline (with mojibake-tolerant UTF-8 decoding) and
//     falls back to a hex preview for binary bodies.
//
// We don't fetch contents up front: the tree response is metadata
// only. Click a file → /file endpoint streams that one body.
import { computed, onMounted, ref, watch } from "vue";
import { api, type RegistryImageFile, type RegistryImageFilesResponse } from "../../lib/api.js";
import Card from "../../components/Card.vue";
import Badge from "../../components/Badge.vue";

const props = defineProps<{ repo: string; tag: string }>();

const loading = ref(true);
const error = ref<string | null>(null);
const payload = ref<RegistryImageFilesResponse | null>(null);

const fileError = ref<string | null>(null);
const fileLoading = ref(false);
const selectedPath = ref<string | null>(null);
const selectedMeta = ref<RegistryImageFile | null>(null);
const fileBodyBytes = ref<Uint8Array | null>(null);
const fileTruncated = ref(false);
const fileFullSize = ref(0);

// Root always starts open so the user sees something on load.
const expanded = ref<Set<string>>(new Set(["/"]));

async function load() {
  loading.value = true;
  error.value = null;
  payload.value = null;
  selectedPath.value = null;
  fileBodyBytes.value = null;
  try {
    payload.value = await api.listRegistryImageFiles(props.repo, props.tag);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => `${props.repo}|${props.tag}`, load);

// ── Tree model ────────────────────────────────────────────────────────
type TreeNode = {
  path: string;
  name: string;
  isDir: boolean;
  meta: RegistryImageFile | null;
};

// Map from parent path → its sorted children. Includes synthetic
// directory entries for ancestors the tar didn't ship explicitly
// (common in scratch images).
const childrenByParent = computed<Map<string, TreeNode[]>>(() => {
  const out = new Map<string, TreeNode[]>();
  if (!payload.value || payload.value.manifestKind !== "image") return out;
  const seenDirs = new Set<string>();
  const push = (parent: string, node: TreeNode) => {
    const list = out.get(parent) ?? [];
    list.push(node);
    out.set(parent, list);
  };
  for (const f of payload.value.files) {
    const parts = f.path.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = cur || "/";
      cur = `${cur}/${parts[i]}`;
      if (!seenDirs.has(cur)) {
        seenDirs.add(cur);
        push(parent, { path: cur, name: parts[i], isDir: true, meta: null });
      }
    }
    const parent = parts.length <= 1 ? "/" : "/" + parts.slice(0, -1).join("/");
    const base = parts[parts.length - 1] ?? "";
    if (!base) continue;
    if (f.type === "directory") {
      if (!seenDirs.has(f.path)) {
        seenDirs.add(f.path);
        push(parent, { path: f.path, name: base, isDir: true, meta: f });
      }
    } else {
      push(parent, { path: f.path, name: base, isDir: false, meta: f });
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  return out;
});

// Flat list of visible rows for v-for. Walks the tree iteratively and
// includes each child only if its parent chain is fully expanded.
type VisibleRow = TreeNode & { depth: number };
const visibleRows = computed<VisibleRow[]>(() => {
  const rows: VisibleRow[] = [];
  if (!payload.value || payload.value.manifestKind !== "image") return rows;
  const walk = (parent: string, depth: number) => {
    const kids = childrenByParent.value.get(parent) ?? [];
    for (const k of kids) {
      rows.push({ ...k, depth });
      if (k.isDir && expanded.value.has(k.path)) walk(k.path, depth + 1);
    }
  };
  walk("/", 0);
  return rows;
});

const fileCount = computed(() => {
  if (!payload.value || payload.value.manifestKind !== "image") return 0;
  return payload.value.files.filter((f) => f.type !== "directory").length;
});

function toggleDir(path: string) {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

function onRowClick(row: VisibleRow) {
  if (row.isDir) {
    toggleDir(row.path);
  } else {
    void selectFile(row);
  }
}

async function selectFile(node: TreeNode) {
  if (!node.meta || node.isDir) return;
  selectedPath.value = node.path;
  selectedMeta.value = node.meta;
  fileError.value = null;
  fileLoading.value = true;
  fileBodyBytes.value = null;
  try {
    const r = await api.getRegistryImageFile(
      props.repo,
      props.tag,
      node.path,
      node.meta.layerIdx
    );
    const decoded = atob(r.bodyBase64);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    fileBodyBytes.value = bytes;
    fileTruncated.value = r.truncated;
    fileFullSize.value = r.size;
  } catch (e) {
    fileError.value = (e as Error).message;
  } finally {
    fileLoading.value = false;
  }
}

// ── Body rendering ────────────────────────────────────────────────────
// Heuristic: text body if no NULs and < 5% control chars in the first
// 4 KiB. Matches what `file(1)` does roughly.
const renderMode = computed<"text" | "binary" | "empty">(() => {
  const b = fileBodyBytes.value;
  if (!b) return "empty";
  if (b.length === 0) return "empty";
  let controls = 0;
  let nulls = 0;
  const sampleLen = Math.min(b.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    const c = b[i];
    if (c === 0) nulls++;
    else if (c < 9 || (c > 13 && c < 32)) controls++;
  }
  if (nulls > 0 || controls / sampleLen > 0.05) return "binary";
  return "text";
});

const textBody = computed<string>(() => {
  if (!fileBodyBytes.value) return "";
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(fileBodyBytes.value);
  } catch {
    return "";
  }
});

const hexBody = computed<string>(() => {
  const b = fileBodyBytes.value;
  if (!b) return "";
  const limit = Math.min(b.length, 64 * 1024); // cap rendering to 64 KiB
  const lines: string[] = [];
  for (let off = 0; off < limit; off += 16) {
    const slice = b.subarray(off, Math.min(off + 16, limit));
    const hex: string[] = [];
    let ascii = "";
    for (const byte of slice) {
      hex.push(byte.toString(16).padStart(2, "0"));
      ascii += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".";
    }
    while (hex.length < 16) hex.push("  ");
    lines.push(
      `${off.toString(16).padStart(8, "0")}  ${hex.slice(0, 8).join(" ")}  ${hex.slice(8).join(" ")}  |${ascii}|`
    );
  }
  if (b.length > limit) {
    lines.push(`… (truncated; showing first ${formatBytes(limit)} of ${formatBytes(b.length)})`);
  }
  return lines.join("\n");
});

function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function modeString(mode: number): string {
  const bits = mode & 0o777;
  let s = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (bits >> shift) & 0o7;
    s += triad & 4 ? "r" : "-";
    s += triad & 2 ? "w" : "-";
    s += triad & 1 ? "x" : "-";
  }
  return s + ` (0${bits.toString(8)})`;
}

function backToRegistry() {
  window.location.hash = "registry";
}

function shortDigest(d: string | undefined | null, n = 12): string {
  if (!d) return "";
  return d.startsWith("sha256:") ? d.slice(7, 7 + n) : d.slice(0, n);
}
</script>

<template>
  <Card :title="`Image files — ${props.repo}:${props.tag}`" :style="{ marginBottom: '1rem' }">
    <template #actions>
      <button type="button" class="ifb-back" @click="backToRegistry">← Back to registry</button>
    </template>

    <p v-if="loading" class="ifb-muted">Reading image layers…</p>
    <p v-else-if="error" class="ifb-error">Couldn't load image files: {{ error }}</p>

    <template v-else-if="payload?.manifestKind === 'index'">
      <p class="ifb-muted">
        This tag points at a <strong>manifest list</strong> (multi-platform image).
        Pick a child manifest digest from the registry page to browse files
        for a specific platform — the index itself has no file contents.
      </p>
      <ul class="ifb-children">
        <li v-for="d in payload.referencedManifestDigests" :key="d">
          <code>{{ shortDigest(d) }}</code> — {{ d }}
        </li>
      </ul>
    </template>

    <template v-else-if="payload?.manifestKind === 'image'">
      <div class="ifb-summary">
        <Badge variant="muted">{{ payload.layers.length }} layer{{ payload.layers.length === 1 ? '' : 's' }}</Badge>
        <span class="ifb-muted">{{ fileCount.toLocaleString() }} files</span>
        <span class="ifb-muted" :title="payload.digest">manifest {{ shortDigest(payload.digest) }}</span>
      </div>

      <div class="ifb-split">
        <!-- Tree (flat depth-padded list) -->
        <div class="ifb-tree">
          <div
            v-for="row in visibleRows"
            :key="row.path"
            class="ifb-row"
            :class="{ 'ifb-row--selected': selectedPath === row.path, 'ifb-row--dir': row.isDir }"
            :style="{ paddingLeft: `${0.4 + row.depth * 1}rem` }"
            @click="onRowClick(row)"
          >
            <span class="ifb-row__chev">
              <template v-if="row.isDir">{{ expanded.has(row.path) ? '▾' : '▸' }}</template>
              <template v-else> </template>
            </span>
            <span class="ifb-row__name" :class="{ 'ifb-row__name--dir': row.isDir }">
              {{ row.name }}
            </span>
            <span v-if="row.meta?.type === 'symlink'" class="ifb-row__hint">→ {{ row.meta.linkTarget }}</span>
            <span v-else-if="row.meta?.type === 'hardlink'" class="ifb-row__hint">↪ {{ row.meta.linkTarget }}</span>
            <span v-else-if="!row.isDir && row.meta" class="ifb-row__size">{{ formatBytes(row.meta.size) }}</span>
          </div>
          <p v-if="visibleRows.length === 0" class="ifb-muted">(no files in image)</p>
        </div>

        <!-- Viewer -->
        <div class="ifb-viewer">
          <p v-if="!selectedPath" class="ifb-muted">
            Click a file in the tree to view its contents.
          </p>
          <template v-else-if="selectedMeta">
            <div class="ifb-fileheader">
              <code class="ifb-path">{{ selectedPath }}</code>
              <div class="ifb-fileheader__meta">
                <span>{{ selectedMeta.type }}</span>
                <span :title="`uid=${selectedMeta.uid} gid=${selectedMeta.gid}`">
                  {{ modeString(selectedMeta.mode) }}
                </span>
                <span>{{ formatBytes(selectedMeta.size) }}</span>
                <span :title="`layer index ${selectedMeta.layerIdx}`">
                  layer #{{ selectedMeta.layerIdx }}
                </span>
              </div>
            </div>

            <p v-if="fileLoading" class="ifb-muted">Reading file…</p>
            <p v-else-if="fileError" class="ifb-error">Couldn't read file: {{ fileError }}</p>
            <template v-else-if="selectedMeta.type === 'symlink' || selectedMeta.type === 'hardlink'">
              <p class="ifb-muted">
                {{ selectedMeta.type }} → <code>{{ selectedMeta.linkTarget ?? '(none)' }}</code>
              </p>
            </template>
            <template v-else-if="selectedMeta.type === 'directory'">
              <p class="ifb-muted">Directory — pick a file inside to view its contents.</p>
            </template>
            <template v-else>
              <p v-if="fileTruncated" class="ifb-warn">
                Truncated — showing first {{ formatBytes(fileBodyBytes?.length ?? 0) }}
                of {{ formatBytes(fileFullSize) }}.
              </p>
              <pre v-if="renderMode === 'text'" class="ifb-body ifb-body--text">{{ textBody }}</pre>
              <pre v-else-if="renderMode === 'binary'" class="ifb-body ifb-body--hex">{{ hexBody }}</pre>
              <p v-else class="ifb-muted">(empty file)</p>
            </template>
          </template>
        </div>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.ifb-back {
  font-size: 0.78rem;
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-family: inherit;
}
.ifb-back:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text);
}
.ifb-muted {
  color: var(--color-text-secondary);
  font-size: 0.88rem;
  margin: 0.4rem 0;
}
.ifb-error {
  color: var(--color-danger);
  font-size: 0.88rem;
}
.ifb-warn {
  color: var(--color-warning, var(--color-text-secondary));
  font-size: 0.8rem;
  margin: 0 0 0.4rem;
}
.ifb-summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin: 0.2rem 0 0.85rem;
  font-size: 0.85rem;
}
.ifb-children {
  font-size: 0.8rem;
  font-family: var(--font-mono);
  padding-left: 1.2rem;
}
.ifb-split {
  display: grid;
  grid-template-columns: minmax(15rem, 30rem) 1fr;
  gap: 0.85rem;
  align-items: stretch;
  min-height: 26rem;
}
.ifb-tree {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  padding: 0.35rem 0;
  overflow: auto;
  max-height: 70vh;
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.ifb-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.12rem 0.5rem 0.12rem 0.4rem;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.ifb-row:hover {
  background: var(--color-surface-muted);
}
.ifb-row--selected,
.ifb-row--selected:hover {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary);
}
.ifb-row--dir .ifb-row__name {
  color: var(--color-text);
  font-weight: 600;
}
.ifb-row__chev {
  display: inline-block;
  width: 0.9rem;
  color: var(--color-text-muted);
  font-size: 0.7rem;
  text-align: center;
}
.ifb-row__name {
  color: var(--color-text);
}
.ifb-row__hint {
  font-size: 0.72rem;
  color: var(--color-text-muted);
}
.ifb-row__size {
  margin-left: auto;
  font-size: 0.72rem;
  color: var(--color-text-muted);
}
.ifb-viewer {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  padding: 0.7rem 0.85rem;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ifb-fileheader {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding-bottom: 0.5rem;
  margin-bottom: 0.6rem;
  border-bottom: 1px solid var(--color-border);
}
.ifb-path {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  word-break: break-all;
}
.ifb-fileheader__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}
.ifb-body {
  margin: 0;
  padding: 0.6rem 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.45;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface-muted);
  overflow: auto;
  max-height: 60vh;
  white-space: pre;
}
</style>
