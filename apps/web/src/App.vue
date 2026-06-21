<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Component, type CSSProperties } from "vue";
import {
  AlertTriangle,
  Box,
  Building2,
  Cpu,
  Database,
  Key,
  LayoutDashboard,
  LogOut,
  Network,
  Settings,
  Shield,
  Users,
  Workflow,
  X
} from "lucide-vue-next";
import "./tokens.css";
import { api, meResponseToAuthUser } from "./lib/api.js";
import { provideAuth, buildAuthState, type AuthUser } from "./lib/useAuth.js";
import TenantSwitcher from "./components/TenantSwitcher.vue";
import DashboardPage from "./features/dashboard/DashboardPage.vue";
import IncidentsPage from "./features/incidents/IncidentsPage.vue";
import ThreatsPage from "./features/threats/ThreatsPage.vue";
import AgentsPage from "./features/agents/AgentsPage.vue";
import ServicesPage from "./features/services/ServicesPage.vue";
import SshKeysPage from "./features/ssh-keys/SshKeysPage.vue";
import TenantsPage from "./features/tenants/TenantsPage.vue";
import RegistryPage from "./features/registry/RegistryPage.vue";
import ImageFileBrowserPage from "./features/registry/ImageFileBrowserPage.vue";
import LoadBalancersPage from "./features/load-balancers/LoadBalancersPage.vue";
import AgentDetailPage from "./features/agents/AgentDetailPage.vue";
import ContainerDetailPage from "./features/agents/ContainerDetailPage.vue";
import OperatorPage from "./features/operator/OperatorPage.vue";
import ServiceDetailPage from "./features/services/ServiceDetailPage.vue";
import SettingsPage from "./features/settings/SettingsPage.vue";
import UsersGroupsPage from "./features/users/UsersGroupsPage.vue";
import TenantConfigurationPage from "./features/tenants/TenantConfigurationPage.vue";
import LoginPage from "./features/auth/LoginPage.vue";
import SetupWizardPage from "./features/setup/SetupWizardPage.vue";

type Route =
  | "dashboard"
  | "incidents"
  | "threats"
  | "agents"
  | "agentDetail"
  | "containerDetail"
  | "operator"
  | "services"
  | "serviceDetail"
  | "sshKeys"
  | "registry"
  | "registryImage"
  | "loadBalancers"
  | "settings"
  | "tenants"
  | "users"
  | "tenantConfig"
  | "login";

type NavItem = { route: Route; label: string; icon: Component; adminOnly?: boolean };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operate",
    items: [
      { route: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { route: "agents", label: "Agents", icon: Cpu },
      { route: "services", label: "Services", icon: Box },
      { route: "incidents", label: "Incidents", icon: AlertTriangle },
      { route: "threats", label: "Threats", icon: Shield, adminOnly: true },
      { route: "operator", label: "Operator", icon: Workflow, adminOnly: true }
    ]
  },
  {
    label: "Deployment",
    items: [
      { route: "sshKeys", label: "SSH Keys", icon: Key },
      { route: "loadBalancers", label: "Load Balancers", icon: Network },
      { route: "registry", label: "Registry", icon: Database, adminOnly: true }
    ]
  },
  {
    label: "Admin",
    items: [
      { route: "tenants", label: "Tenants", icon: Building2, adminOnly: true },
      { route: "users", label: "Users & Groups", icon: Users, adminOnly: true },
      { route: "settings", label: "Settings", icon: Settings, adminOnly: true }
    ]
  }
];

// Human-readable page title shown in the top bar — derived from the
// active route so it stays in sync with the sidebar selection and
// browser history without each page having to render its own H1.
const PAGE_TITLE: Record<Route, string> = {
  dashboard: "Dashboard",
  incidents: "Incidents",
  threats: "Threats",
  agents: "Agents",
  agentDetail: "Agent",
  containerDetail: "Container",
  operator: "Operator",
  services: "Services",
  serviceDetail: "Service",
  sshKeys: "SSH Keys",
  registry: "Registry",
  registryImage: "Image files",
  loadBalancers: "Load Balancers",
  settings: "Settings",
  tenants: "Tenants",
  users: "Users & Groups",
  tenantConfig: "Tenant configuration",
  login: "Sign in"
};

function readNavFromHash(): {
  route: Route;
  tenantConfigTenantId: string | null;
  agentDetailAgentId: string | null;
  serviceDetailServiceId: string | null;
  registryImageRepo: string | null;
  registryImageTag: string | null;
  containerDetailAgentId: string | null;
  containerDetailContainerId: string | null;
} {
  const raw = window.location.hash.replace(/^#/, "").split("?")[0];
  const empty = {
    tenantConfigTenantId: null,
    agentDetailAgentId: null,
    serviceDetailServiceId: null,
    registryImageRepo: null,
    registryImageTag: null,
    containerDetailAgentId: null,
    containerDetailContainerId: null
  };
  if (raw.startsWith("tenant-config/")) {
    const id = decodeURIComponent(raw.slice("tenant-config/".length).trim());
    return { route: "tenantConfig", ...empty, tenantConfigTenantId: id || null };
  }
  if (raw.startsWith("container/")) {
    // Shape: container/<encoded agentId>/<encoded containerId>. Both ids
    // are slash-free (UUID / docker sha / pod name) so a simple split is
    // safe.
    const rest = raw.slice("container/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      const agentId = decodeURIComponent(rest.slice(0, slash)).trim();
      const containerId = decodeURIComponent(rest.slice(slash + 1)).trim();
      if (agentId && containerId) {
        return {
          route: "containerDetail",
          ...empty,
          containerDetailAgentId: agentId,
          containerDetailContainerId: containerId
        };
      }
    }
  }
  if (raw.startsWith("agent/")) {
    const id = decodeURIComponent(raw.slice("agent/".length).trim());
    return { route: "agentDetail", ...empty, agentDetailAgentId: id || null };
  }
  if (raw.startsWith("service/")) {
    const id = decodeURIComponent(raw.slice("service/".length).trim());
    return { route: "serviceDetail", ...empty, serviceDetailServiceId: id || null };
  }
  if (raw.startsWith("registry-image/")) {
    // Shape: registry-image/<encoded repo>/<encoded tag>. Repo names
    // can contain `/` (e.g. library/alpine) so we keep the part before
    // the LAST `/` as the repo and the trailing segment as the tag.
    const rest = raw.slice("registry-image/".length);
    const slash = rest.lastIndexOf("/");
    if (slash > 0) {
      const repo = decodeURIComponent(rest.slice(0, slash)).trim();
      const tag = decodeURIComponent(rest.slice(slash + 1)).trim();
      if (repo && tag) {
        return {
          route: "registryImage",
          ...empty,
          registryImageRepo: repo,
          registryImageTag: tag
        };
      }
    }
  }
  const base = (raw.split("/")[0] || "dashboard") as Route;
  const allowed: Route[] = [
    "dashboard",
    "incidents",
    "threats",
    "agents",
    "operator",
    "services",
    "sshKeys",
    "registry",
    "loadBalancers",
    "settings",
    "tenants",
    "users",
    "login"
  ];
  if (allowed.includes(base)) {
    return { route: base, ...empty };
  }
  return { route: "dashboard", ...empty };
}

function hasToken(): boolean {
  return Boolean(localStorage.getItem("sm_token"));
}

const setupStatus = ref<boolean | null>(null);
const route = ref<Route>(hasToken() ? readNavFromHash().route : "login");
const tenantConfigTenantId = ref<string | null>(hasToken() ? readNavFromHash().tenantConfigTenantId : null);
const agentDetailAgentId = ref<string | null>(hasToken() ? readNavFromHash().agentDetailAgentId : null);
const serviceDetailServiceId = ref<string | null>(hasToken() ? readNavFromHash().serviceDetailServiceId : null);
const registryImageRepo = ref<string | null>(hasToken() ? readNavFromHash().registryImageRepo : null);
const registryImageTag = ref<string | null>(hasToken() ? readNavFromHash().registryImageTag : null);
const containerDetailAgentId = ref<string | null>(hasToken() ? readNavFromHash().containerDetailAgentId : null);
const containerDetailContainerId = ref<string | null>(hasToken() ? readNavFromHash().containerDetailContainerId : null);
const user = ref<AuthUser | null>(null);
const meResolved = ref(false);

provideAuth(user);

const authState = computed(() => buildAuthState(user.value));

// Filter each group's items by the current user's role; drop empty
// groups so the sidebar doesn't render a header with no rows under it.
const visibleNavGroups = computed<NavGroup[]>(() =>
  NAV_GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => !(it.adminOnly && authState.value.isViewer))
    }))
    .filter((g) => g.items.length > 0)
);
const currentPageTitle = computed<string>(() => PAGE_TITLE[route.value] ?? "");
const userInitial = computed(() => {
  const e = user.value?.email ?? "";
  return e ? e.slice(0, 1).toUpperCase() : "?";
});

// ─── Open-item tabs ─────────────────────────────────────────────────
// Browser-style tab strip above the content that tracks the service /
// agent detail pages the user has drilled into. Opening a detail route
// adds a tab; the strip persists across reloads via localStorage so the
// user's working set of services/agents survives a refresh.
type OpenTabKind = "service" | "agent";
type OpenTab = { kind: OpenTabKind; id: string; label: string };

const OPEN_TABS_KEY = "sm_open_tabs";

function loadOpenTabs(): OpenTab[] {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t: unknown): t is OpenTab =>
          !!t &&
          typeof t === "object" &&
          ((t as OpenTab).kind === "service" || (t as OpenTab).kind === "agent") &&
          typeof (t as OpenTab).id === "string"
      )
      .map((t) => ({ kind: t.kind, id: t.id, label: typeof t.label === "string" && t.label ? t.label : t.id }));
  } catch {
    return [];
  }
}

const openTabs = ref<OpenTab[]>(hasToken() ? loadOpenTabs() : []);
watch(
  openTabs,
  (tabs) => {
    try {
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs));
    } catch {
      /* localStorage may be unavailable (private mode/quota) — non-fatal */
    }
  },
  { deep: true }
);

function tabKey(t: OpenTab): string {
  return `${t.kind}:${t.id}`;
}

// Which detail item (if any) the current route is showing — drives the
// active-tab highlight and which tab a close() should navigate away from.
const activeTabKey = computed<string | null>(() => {
  if (route.value === "serviceDetail" && serviceDetailServiceId.value) {
    return `service:${serviceDetailServiceId.value}`;
  }
  if (route.value === "agentDetail" && agentDetailAgentId.value) {
    return `agent:${agentDetailAgentId.value}`;
  }
  return null;
});

function tabHash(t: OpenTab): string {
  return t.kind === "service"
    ? `service/${encodeURIComponent(t.id)}`
    : `agent/${encodeURIComponent(t.id)}`;
}

function tabIcon(kind: OpenTabKind): Component {
  return kind === "service" ? Box : Cpu;
}

// Add a tab for the current detail route if one doesn't exist yet.
function ensureTabForCurrentRoute() {
  let kind: OpenTabKind | null = null;
  let id: string | null = null;
  if (route.value === "serviceDetail") {
    kind = "service";
    id = serviceDetailServiceId.value;
  } else if (route.value === "agentDetail") {
    kind = "agent";
    id = agentDetailAgentId.value;
  }
  if (!kind || !id) return;
  const key = `${kind}:${id}`;
  if (!openTabs.value.some((t) => tabKey(t) === key)) {
    // Friendly placeholder until the detail page reports its real name.
    const short = id.length > 14 ? `${id.slice(0, 10)}…` : id;
    openTabs.value = [...openTabs.value, { kind, id, label: short }];
  }
}

// Detail pages emit their resolved name once loaded so the tab shows a
// human label instead of the raw id.
function setTabLabel(kind: OpenTabKind, id: string | null, name: string) {
  if (!id) return;
  const key = `${kind}:${id}`;
  const trimmed = name.trim();
  if (!trimmed) return;
  openTabs.value = openTabs.value.map((t) => (tabKey(t) === key ? { ...t, label: trimmed } : t));
}

function closeTab(t: OpenTab) {
  const key = tabKey(t);
  const idx = openTabs.value.findIndex((x) => tabKey(x) === key);
  const remaining = openTabs.value.filter((x) => tabKey(x) !== key);
  openTabs.value = remaining;
  // If the closed tab was the active page, move to a neighbouring tab,
  // else fall back to the relevant list page.
  if (activeTabKey.value === key) {
    const next = remaining[idx] ?? remaining[idx - 1] ?? null;
    window.location.hash = next ? tabHash(next) : t.kind === "service" ? "services" : "agents";
  }
}

async function loadSetupStatus() {
  try {
    const res = await api.getSetupStatus();
    setupStatus.value = res.setupRequired;
  } catch {
    setupStatus.value = false;
  }
}

async function loadMe() {
  if (!hasToken()) {
    meResolved.value = true;
    return;
  }
  try {
    const m = await api.me();
    user.value = meResponseToAuthUser(m);
  } catch (err) {
    console.error("[app] GET /api/v1/me failed", err);
  } finally {
    meResolved.value = true;
  }
}

function onHashChange() {
  if (!hasToken()) {
    window.location.hash = "login";
    route.value = "login";
    tenantConfigTenantId.value = null;
    agentDetailAgentId.value = null;
    serviceDetailServiceId.value = null;
    registryImageRepo.value = null;
    registryImageTag.value = null;
    return;
  }
  const nav = readNavFromHash();
  route.value = nav.route;
  tenantConfigTenantId.value = nav.tenantConfigTenantId;
  agentDetailAgentId.value = nav.agentDetailAgentId;
  serviceDetailServiceId.value = nav.serviceDetailServiceId;
  registryImageRepo.value = nav.registryImageRepo;
  registryImageTag.value = nav.registryImageTag;
  containerDetailAgentId.value = nav.containerDetailAgentId;
  containerDetailContainerId.value = nav.containerDetailContainerId;
  ensureTabForCurrentRoute();
}

function handleTenantSwitch(u: AuthUser) {
  user.value = u;
  if (route.value === "tenantConfig" && tenantConfigTenantId.value && tenantConfigTenantId.value !== u.tenantId) {
    window.location.hash = `tenant-config/${encodeURIComponent(u.tenantId)}`;
  }
}

function logout() {
  api.logout();
}

function isActive(itemRoute: Route): boolean {
  return (
    route.value === itemRoute ||
    (itemRoute === "tenants" && route.value === "tenantConfig") ||
    (itemRoute === "agents" && route.value === "agentDetail") ||
    (itemRoute === "agents" && route.value === "containerDetail") ||
    (itemRoute === "services" && route.value === "serviceDetail") ||
    (itemRoute === "registry" && route.value === "registryImage")
  );
}

onMounted(() => {
  void loadSetupStatus();
  void loadMe();
  ensureTabForCurrentRoute();
  window.addEventListener("hashchange", onHashChange);
});
onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
});

const docsUrl = (import.meta.env.VITE_DOCS_URL as string | undefined) ?? "";

// ─── Layout style constants ─────────────────────────────────────────
// All consolidated here so the top-bar + sidebar share a vocabulary
// and Vue templates below stay readable.
const TOPBAR_HEIGHT = "56px";
const SIDEBAR_WIDTH = "232px";

const navStyle: CSSProperties = {
  background: "var(--color-nav-bg)",
  display: "flex",
  flexDirection: "column",
  gap: "0.1rem",
  borderRight: "1px solid var(--color-border)",
  height: "100vh",
  position: "sticky",
  top: 0,
  overflowY: "auto"
};
const topBarStyle: CSSProperties = {
  height: TOPBAR_HEIGHT,
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  padding: "0 1rem",
  borderBottom: "1px solid var(--color-border)",
  background: "var(--color-surface)",
  boxShadow: "var(--shadow-sm)",
  position: "sticky",
  top: 0,
  zIndex: 5
};
const groupLabelStyle: CSSProperties = {
  padding: "0.65rem 1rem 0.25rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--color-nav-muted)"
};
// Open-item tab strip: sits directly under the top bar, sticky, with a
// horizontal-scrolling row of tabs.
const tabStripStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: "0.25rem",
  height: "38px",
  padding: "0 0.5rem",
  borderBottom: "1px solid var(--color-border)",
  background: "var(--color-surface-muted)",
  position: "sticky",
  top: TOPBAR_HEIGHT,
  zIndex: 4,
  overflowX: "auto"
};
const tabItemStyle = (active: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  padding: "0 0.4rem 0 0.7rem",
  marginTop: "5px",
  color: active ? "var(--color-text)" : "var(--color-text-secondary)",
  textDecoration: "none",
  fontSize: "0.82rem",
  fontWeight: active ? 600 : 500,
  whiteSpace: "nowrap",
  background: active ? "var(--color-surface)" : "transparent",
  border: "1px solid",
  borderColor: active ? "var(--color-border)" : "transparent",
  borderBottom: active ? "1px solid var(--color-surface)" : "1px solid transparent",
  borderTopLeftRadius: "8px",
  borderTopRightRadius: "8px"
});
const tabCloseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "1.1rem",
  height: "1.1rem",
  border: "none",
  borderRadius: "4px",
  background: "transparent",
  color: "var(--color-text-muted)",
  cursor: "pointer",
  padding: 0
};
const navItemStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "0.55rem",
  margin: "0.05rem 0.5rem",
  padding: "0.5rem 0.7rem",
  color: active ? "var(--color-nav-active)" : "var(--color-nav-text)",
  textDecoration: "none",
  fontSize: "0.88rem",
  fontWeight: active ? 600 : 500,
  borderRadius: "8px",
  background: active ? "var(--color-nav-surface)" : "transparent",
  transition: "background 0.15s, color 0.15s"
});
</script>

<template>
  <div
    v-if="setupStatus === null"
    :style="{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }"
  >
    <p :style="{ color: 'var(--color-text-secondary)' }">Loading…</p>
  </div>

  <SetupWizardPage v-else-if="setupStatus" />

  <LoginPage v-else-if="route === 'login'" />

  <div
    v-else
    :style="{
      display: 'grid',
      gridTemplateColumns: `${SIDEBAR_WIDTH} 1fr`,
      minHeight: '100vh',
      background: 'var(--color-canvas)'
    }"
  >
    <!-- Sidebar: brand at top, grouped nav, doc link at bottom. The
         tenant switcher + user menu moved up to the top bar so this
         column stays purely navigational. -->
    <nav :style="navStyle">
      <a
        href="#dashboard"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '0.55rem',
          padding: '1rem',
          color: 'var(--color-nav-text)',
          textDecoration: 'none',
          fontWeight: 700,
          fontSize: '1.05rem',
          borderBottom: '1px solid var(--color-border)'
        }"
      >
        <LayoutDashboard :size="18" />
        Kaiad
      </a>
      <template v-for="(group, gi) in visibleNavGroups" :key="group.label">
        <div :style="{ ...groupLabelStyle, marginTop: gi === 0 ? '0.4rem' : '0.6rem' }">
          {{ group.label }}
        </div>
        <a
          v-for="item in group.items"
          :key="item.route"
          :href="`#${item.route}`"
          :style="navItemStyle(isActive(item.route))"
        >
          <component :is="item.icon" :size="15" />
          {{ item.label }}
        </a>
      </template>
      <div :style="{ flex: 1 }" />
      <a
        v-if="docsUrl"
        :href="docsUrl"
        target="_blank"
        rel="noopener"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.6rem 1rem',
          color: 'var(--color-nav-muted)',
          textDecoration: 'none',
          fontSize: '0.78rem',
          borderTop: '1px solid var(--color-border)'
        }"
      >
        Documentation ↗
      </a>
    </nav>

    <div :style="{ minWidth: 0 }">
      <!-- Top bar: page title, tenant context, user identity + sign out -->
      <header :style="topBarStyle">
        <h1
          :style="{
            margin: 0,
            fontSize: '1rem',
            fontWeight: 600,
            color: 'var(--color-text)'
          }"
        >
          {{ currentPageTitle }}
        </h1>
        <div :style="{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.6rem' }">
          <TenantSwitcher :user="user" :me-resolved="meResolved" @user-updated="handleTenantSwitch" />
          <div
            :title="user?.email ?? ''"
            :style="{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.25rem 0.45rem 0.25rem 0.3rem',
              border: '1px solid var(--color-border)',
              borderRadius: '999px',
              fontSize: '0.82rem',
              color: 'var(--color-text)',
              background: 'var(--color-surface)'
            }"
          >
            <span
              :style="{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '1.4rem',
                height: '1.4rem',
                borderRadius: '50%',
                background: 'var(--color-primary)',
                color: 'var(--color-primary-foreground)',
                fontSize: '0.72rem',
                fontWeight: 600
              }"
            >{{ userInitial }}</span>
            <span
              :style="{
                maxWidth: '14rem',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }"
            >{{ user?.email ?? 'signed in' }}</span>
          </div>
          <button
            type="button"
            title="Sign out"
            :style="{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.3rem 0.6rem',
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              fontSize: '0.82rem',
              cursor: 'pointer',
              fontFamily: 'inherit'
            }"
            @click="logout"
          >
            <LogOut :size="14" />
            <span :style="{ display: 'none' }">Sign out</span>
          </button>
        </div>
      </header>

      <!-- Open-item tabs: services/agents the user has drilled into.
           Persists across reloads; click to switch, × to close. -->
      <nav v-if="openTabs.length" :style="tabStripStyle" aria-label="Open items">
        <div
          v-for="t in openTabs"
          :key="`${t.kind}:${t.id}`"
          :style="tabItemStyle(activeTabKey === `${t.kind}:${t.id}`)"
        >
          <a
            :href="`#${tabHash(t)}`"
            :title="t.label"
            :style="{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              color: 'inherit',
              textDecoration: 'none',
              maxWidth: '12rem',
              overflow: 'hidden'
            }"
          >
            <component :is="tabIcon(t.kind)" :size="13" />
            <span :style="{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }">{{ t.label }}</span>
          </a>
          <button type="button" :style="tabCloseStyle" :title="`Close ${t.label}`" @click="closeTab(t)">
            <X :size="13" />
          </button>
        </div>
      </nav>

      <main :style="{ padding: '1.5rem', overflow: 'auto' }">
      <DashboardPage v-if="route === 'dashboard'" />
      <IncidentsPage v-else-if="route === 'incidents'" />
      <ThreatsPage v-else-if="route === 'threats'" />
      <AgentsPage v-else-if="route === 'agents'" />
      <AgentDetailPage
        v-else-if="route === 'agentDetail' && agentDetailAgentId"
        :agent-id="agentDetailAgentId"
        @resolved-name="(n: string) => setTabLabel('agent', agentDetailAgentId, n)"
      />
      <ContainerDetailPage
        v-else-if="route === 'containerDetail' && containerDetailAgentId && containerDetailContainerId"
        :agent-id="containerDetailAgentId"
        :container-id="containerDetailContainerId"
      />
      <OperatorPage v-else-if="route === 'operator'" />
      <ServicesPage v-else-if="route === 'services'" />
      <ServiceDetailPage
        v-else-if="route === 'serviceDetail' && serviceDetailServiceId"
        :service-id="serviceDetailServiceId"
        @resolved-name="(n: string) => setTabLabel('service', serviceDetailServiceId, n)"
      />
      <SshKeysPage v-else-if="route === 'sshKeys'" />
      <RegistryPage v-else-if="route === 'registry'" />
      <ImageFileBrowserPage
        v-else-if="route === 'registryImage' && registryImageRepo && registryImageTag"
        :repo="registryImageRepo"
        :tag="registryImageTag"
      />
      <LoadBalancersPage v-else-if="route === 'loadBalancers'" />
      <TenantsPage v-else-if="route === 'tenants'" @auth-user-updated="(u: AuthUser) => (user = u)" />
      <UsersGroupsPage v-else-if="route === 'users'" />
      <SettingsPage v-else-if="route === 'settings'" />
      <TenantConfigurationPage
        v-else-if="route === 'tenantConfig' && tenantConfigTenantId"
        :tenant-id-from-route="tenantConfigTenantId"
        @auth-user-updated="(u: AuthUser) => (user = u)"
      />
      </main>
    </div>
  </div>
</template>
