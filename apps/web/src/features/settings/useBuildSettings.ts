// Settings → Builds: the instance-wide parallel-build limit plus the live
// running/queued counts and build-workspace disk figures. Wraps api.ts
// (transport) with the small amount of state + validation the section
// needs, per the ui-api-layer rule.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, type BuildSettings } from "../../lib/api.js";

const GB = 1024 * 1024 * 1024;

/** Scratch space a heavy build (e.g. Rust) can need; the UI sizes its warning on this. */
export const HEAVY_BUILD_BYTES = 25 * GB;
export const BUILD_LIMIT_MIN = 1;
export const BUILD_LIMIT_MAX = 8;
export const BUILD_LIMIT_OPTIONS: readonly number[] = Array.from(
  { length: BUILD_LIMIT_MAX - BUILD_LIMIT_MIN + 1 },
  (_, i) => BUILD_LIMIT_MIN + i
);
export const BUILD_SETTINGS_REFRESH_MS = 5000;

export type DiskWarning = {
  /** "danger" when limit × 25 GB exceeds the free space; "info" otherwise. */
  level: "info" | "danger";
  text: string;
};

export function fmtGb(bytes: number): string {
  return `${(bytes / GB).toFixed(bytes >= 100 * GB ? 0 : 1)} GB`;
}

/** Pure helper (unit-testable): the disk-sizing advice for a chosen limit. */
export function diskWarningFor(limit: number, disk: BuildSettings["buildsDisk"]): DiskWarning {
  const needed = limit * HEAVY_BUILD_BYTES;
  const base = "A heavy build (e.g. Rust) can need ~20–25 GB of scratch space, so keep limit × 25 GB under the free space of the build workspace.";
  if (disk && needed > disk.freeBytes) {
    return {
      level: "danger",
      text: `${limit} parallel build${limit === 1 ? "" : "s"} × 25 GB = ${fmtGb(needed)}, more than the ${fmtGb(disk.freeBytes)} free on the build workspace. Concurrent heavy builds may fail with out-of-disk errors. ${base}`
    };
  }
  return { level: "info", text: base };
}

export function useBuildSettings(opts: { enabled?: () => boolean; refreshMs?: number } = {}) {
  const enabled = opts.enabled ?? (() => true);
  const refreshMs = opts.refreshMs ?? BUILD_SETTINGS_REFRESH_MS;

  const data = ref<BuildSettings | null>(null);
  const form = ref<number>(BUILD_LIMIT_MIN);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const success = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Load (or refresh) the settings. The select is initialised from the
   * first successful load; a later refresh never clobbers an unsaved
   * selection.
   */
  async function load(opts2: { refresh?: boolean } = {}): Promise<void> {
    if (!enabled()) return;
    const initial = data.value === null;
    if (!opts2.refresh) loading.value = true;
    try {
      const r = await api.getBuildSettings();
      data.value = r;
      if (initial || !opts2.refresh) form.value = r.maxConcurrentBuilds;
      if (opts2.refresh) error.value = null;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function save(): Promise<void> {
    const n = Number(form.value);
    error.value = null;
    success.value = null;
    if (!Number.isInteger(n) || n < BUILD_LIMIT_MIN || n > BUILD_LIMIT_MAX) {
      error.value = `Parallel builds must be a whole number between ${BUILD_LIMIT_MIN} and ${BUILD_LIMIT_MAX}.`;
      return;
    }
    saving.value = true;
    try {
      const r = await api.updateBuildSettings({ maxConcurrentBuilds: n });
      data.value = r;
      form.value = r.maxConcurrentBuilds;
      success.value = `Parallel build limit set to ${r.maxConcurrentBuilds}. Running builds are unaffected; new claims use the new limit within a few seconds.`;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      saving.value = false;
    }
  }

  function start(): void {
    if (timer || refreshMs <= 0) return;
    timer = setInterval(() => void load({ refresh: true }), refreshMs);
  }
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const dirty = computed(() => data.value !== null && Number(form.value) !== data.value.maxConcurrentBuilds);
  const warning = computed<DiskWarning>(() => diskWarningFor(Number(form.value) || BUILD_LIMIT_MIN, data.value?.buildsDisk ?? null));

  // The section may become enabled after mount (auth state arriving after a
  // hard reload); load as soon as that happens instead of on the next tick.
  watch(enabled, (on) => {
    if (on && data.value === null) void load();
  });

  onMounted(() => {
    void load();
    start();
  });
  onBeforeUnmount(stop);

  return { data, form, loading, saving, error, success, dirty, warning, load, save, start, stop };
}
