// Settings → Builds section (Vue). Mounted via @vue/test-utils with a
// mocked api layer and an injected auth user.
import { mount, flushPromises } from "@vue/test-utils";
import { isRef, ref, type Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getBuildSettings, updateBuildSettings } = vi.hoisted(() => ({
  getBuildSettings: vi.fn(),
  updateBuildSettings: vi.fn()
}));

vi.mock("../src/lib/api.js", () => ({
  api: {
    getBuildSettings,
    updateBuildSettings,
    getAuthProviders: vi.fn(async () => ({ providers: [] })),
    getRegistryRetention: vi.fn(async () => ({
      policy: { keepLastNPerRepo: 10, maxTotalBytes: 0, keepForDays: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
      stats: { totalBytes: 0, totalBlobs: 0, repos: [] }
    })),
    listApiCredentials: vi.fn(async () => ({ credentials: [] })),
    listPermissions: vi.fn(async () => ({ permissions: [] }))
  }
}));

import SettingsPage from "../src/features/settings/SettingsPage.vue";
import { AuthKey, type AuthUser } from "../src/lib/useAuth.js";
import { diskWarningFor, fmtGb, HEAVY_BUILD_BYTES } from "../src/features/settings/useBuildSettings.js";

const GB = 1024 ** 3;
const admin: AuthUser = {
  id: "u1",
  email: "admin@example.com",
  role: "admin",
  tenantId: "t1",
  memberships: [{ tenantId: "t1", tenantName: "Acme", role: "admin" }],
  permissions: ["*"]
};
const viewer: AuthUser = { ...admin, id: "u2", role: "viewer", permissions: ["services:read"] };

const settings = (over: Record<string, unknown> = {}) => ({
  maxConcurrentBuilds: 1,
  running: 2,
  queued: 5,
  buildsDisk: { freeBytes: 60 * GB, totalBytes: 200 * GB },
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "root@example.com",
  ...over
});

const mounted: Array<{ unmount: () => void }> = [];
function mountPage(user: AuthUser | Ref<AuthUser | null> = admin) {
  const userRef = isRef(user) ? user : ref(user);
  const w = mount(SettingsPage, { global: { provide: { [AuthKey as symbol]: userRef } } });
  mounted.push(w);
  return w;
}

describe("diskWarningFor", () => {
  it("is informational while limit × 25 GB fits, danger otherwise, and tolerates unknown disk", () => {
    const disk = { freeBytes: 60 * GB, totalBytes: 200 * GB };
    expect(diskWarningFor(2, disk).level).toBe("info");
    expect(diskWarningFor(3, disk).level).toBe("danger");
    expect(diskWarningFor(3, disk).text).toContain("75.0 GB");
    expect(diskWarningFor(3, disk).text).toContain("60.0 GB free");
    expect(diskWarningFor(8, null).level).toBe("info");
    expect(HEAVY_BUILD_BYTES).toBe(25 * GB);
    expect(fmtGb(150 * GB)).toBe("150 GB");
  });
});

describe("Settings → Builds section", () => {
  beforeEach(() => {
    // Only fake the interval APIs so flushPromises (macrotask-based) keeps working.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    getBuildSettings.mockReset();
    updateBuildSettings.mockReset();
    getBuildSettings.mockResolvedValue(settings());
  });
  afterEach(() => {
    // Unmount even when an assertion failed mid-test so no poller leaks.
    for (const w of mounted.splice(0)) w.unmount();
    vi.useRealTimers();
  });

  it("is hidden for non-admins", async () => {
    const w = mountPage(viewer);
    await flushPromises();
    expect(w.find('[data-testid="builds-settings"]').exists()).toBe(false);
    expect(getBuildSettings).not.toHaveBeenCalled();
    w.unmount();
  });

  it("shows the limit select, live counts, disk and last-changed info", async () => {
    const w = mountPage();
    await flushPromises();
    const section = w.get('[data-testid="builds-settings"]');
    const select = section.get<HTMLSelectElement>('select[aria-label="Parallel builds"]');
    expect(select.findAll("option").map((o) => o.text())).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(select.element.value).toBe("1");
    expect(section.get('[data-testid="builds-running"]').text()).toBe("2");
    expect(section.get('[data-testid="builds-queued"]').text()).toBe("5");
    expect(section.get('[data-testid="builds-limit"]').text()).toBe("1");
    expect(section.get('[data-testid="builds-disk"]').text()).toContain("60.0 GB free of 200 GB");
    expect(section.text()).toContain("Last changed by root@example.com");
    const warn = section.get('[data-testid="builds-disk-warning"]');
    expect(warn.attributes("data-level")).toBe("info");
    expect(warn.text()).toContain("~20–25 GB");
    // Save is disabled until the value changes.
    expect(section.get("button").attributes("disabled")).toBeDefined();
    w.unmount();
  });

  it("escalates the warning when the chosen value × 25 GB exceeds free space", async () => {
    const w = mountPage();
    await flushPromises();
    const section = w.get('[data-testid="builds-settings"]');
    await section.get("select").setValue("4");
    const warn = section.get('[data-testid="builds-disk-warning"]');
    expect(warn.attributes("data-level")).toBe("danger");
    expect(warn.text()).toContain("= 100 GB");
    await section.get("select").setValue("2");
    expect(section.get('[data-testid="builds-disk-warning"]').attributes("data-level")).toBe("info");
    w.unmount();
  });

  it("saves the new limit and shows success; shows API errors", async () => {
    updateBuildSettings.mockResolvedValue(settings({ maxConcurrentBuilds: 3, updatedBy: "admin@example.com" }));
    const w = mountPage();
    await flushPromises();
    const section = w.get('[data-testid="builds-settings"]');
    await section.get("select").setValue("3");
    expect(section.get("button").attributes("disabled")).toBeUndefined();
    await section.get("button").trigger("click");
    await flushPromises();
    expect(updateBuildSettings).toHaveBeenCalledWith({ maxConcurrentBuilds: 3 });
    expect(section.get('[role="status"]').text()).toContain("Parallel build limit set to 3");
    expect(section.get('[data-testid="builds-limit"]').text()).toBe("3");
    expect(section.text()).toContain("Last changed by admin@example.com");

    updateBuildSettings.mockRejectedValueOnce(new Error("Missing permission: settings:manage"));
    await section.get("select").setValue("5");
    await section.get("button").trigger("click");
    await flushPromises();
    expect(section.get('[role="alert"]').text()).toContain("Missing permission: settings:manage");
    w.unmount();
  });

  it("refreshes the counts every 5 s without clobbering an unsaved selection, and stops on unmount", async () => {
    const w = mountPage();
    await flushPromises();
    expect(getBuildSettings).toHaveBeenCalledTimes(1);
    const section = w.get('[data-testid="builds-settings"]');
    await section.get("select").setValue("6");

    getBuildSettings.mockResolvedValue(settings({ running: 7, queued: 0 }));
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(getBuildSettings).toHaveBeenCalledTimes(2);
    expect(section.get('[data-testid="builds-running"]').text()).toBe("7");
    expect(section.get<HTMLSelectElement>("select").element.value).toBe("6");

    w.unmount();
    await vi.advanceTimersByTimeAsync(15000);
    expect(getBuildSettings).toHaveBeenCalledTimes(2);
  });

  it("surfaces a load error", async () => {
    getBuildSettings.mockRejectedValue(new Error("Persistence unavailable"));
    const w = mountPage();
    await flushPromises();
    expect(w.get('[data-testid="builds-settings"] [role="alert"]').text()).toContain("Persistence unavailable");
    w.unmount();
  });

  it("initialises the select from the first load even when the auth state arrives after mount (hard reload)", async () => {
    getBuildSettings.mockResolvedValue(settings({ maxConcurrentBuilds: 3 }));
    const user = ref<AuthUser | null>(null);
    const w = mountPage(user);
    await flushPromises();
    expect(w.find('[data-testid="builds-settings"]').exists()).toBe(false);
    expect(getBuildSettings).not.toHaveBeenCalled();

    user.value = admin; // /me resolved
    await flushPromises();
    const section = w.get('[data-testid="builds-settings"]');
    expect(getBuildSettings).toHaveBeenCalledTimes(1);
    expect(section.get('[data-testid="builds-limit"]').text()).toBe("3");
    expect(section.get<HTMLSelectElement>("select").element.value).toBe("3");
    w.unmount();
  });

  it("a refresh that is the first successful load still initialises the select", async () => {
    getBuildSettings.mockRejectedValueOnce(new Error("boot"));
    getBuildSettings.mockResolvedValue(settings({ maxConcurrentBuilds: 5 }));
    const w = mountPage();
    await flushPromises();
    const section = w.get('[data-testid="builds-settings"]');
    expect(section.get('[role="alert"]').text()).toContain("boot");
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(section.get<HTMLSelectElement>("select").element.value).toBe("5");
    expect(section.find('[role="alert"]').exists()).toBe(false);
    w.unmount();
  });
});
