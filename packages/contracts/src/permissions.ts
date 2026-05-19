// Fine-grained permission model shared by the API and the web UI.
//
// A permission is `<resource>:<action>`. A group is a named set of
// permissions. A user's effective permissions are the union of every
// group they belong to. The legacy tenant-membership roles
// (owner/admin/operator/viewer) map to built-in groups so existing
// users keep exactly the access they had — the migration backfills
// every membership into its role's built-in group.
//
// `*` is the superuser wildcard (matches every permission). It is what
// owner/admin hold today, so behaviour is unchanged for them.

export const PERMISSIONS = [
  // Services + build pipeline
  "services:read",
  "services:write", // create / edit / delete a monitored service
  "services:deploy", // deploy a build to agents
  "builds:trigger", // manual build
  "pipeline:edit", // kaiad.yaml override editor
  // Agents
  "agents:read",
  "agents:manage", // enroll-tokens, delete, deploy-to-agent, force actions
  "agents:bind", // bind/unbind services to agents
  "agents:logs", // read service logs via an agent
  // Registry
  "registry:read",
  "registry:admin", // visibility, delete repos/tags
  // Observability
  "loadbalancers:read",
  "incidents:read",
  "incidents:write",
  // Secrets / keys
  "sshkeys:read",
  "sshkeys:write",
  // Tenancy + platform admin
  "tenants:manage",
  "apicredentials:manage",
  "enrollment:manage",
  "settings:manage",
  // User & group administration
  "users:read",
  "users:manage"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** The superuser wildcard. */
export const WILDCARD = "*";

export type BuiltinRole = "owner" | "admin" | "operator" | "viewer";

const READ_ONLY: Permission[] = [
  "services:read",
  "agents:read",
  "registry:read",
  "loadbalancers:read",
  "incidents:read",
  "sshkeys:read",
  "users:read"
];

// owner/admin keep `*` (identical to today, where both bypass every
// role gate). operator = read everything + day-to-day operational
// actions. viewer = read only.
export const BUILTIN_GROUPS: Record<BuiltinRole, string[]> = {
  owner: [WILDCARD],
  admin: [WILDCARD],
  operator: [
    ...READ_ONLY,
    "services:deploy",
    "builds:trigger",
    "pipeline:edit",
    "agents:bind",
    "agents:logs",
    "incidents:write"
  ],
  viewer: [...READ_ONLY]
};

/** Stable per-tenant name of the built-in group for a legacy role. */
export function builtinGroupName(role: BuiltinRole | string): string {
  return `builtin:${role}`;
}

export function permissionsForRole(role: string): string[] {
  return BUILTIN_GROUPS[(role as BuiltinRole)] ?? BUILTIN_GROUPS.viewer;
}

/**
 * True if `held` (a user's effective permission list) satisfies `need`.
 * `*` matches anything; otherwise an exact match is required.
 */
export function hasPermission(held: readonly string[], need: string): boolean {
  return held.includes(WILDCARD) || held.includes(need);
}

/** Union of permissions across a set of groups' permission arrays. */
export function unionPermissions(groups: readonly { permissions: readonly string[] }[]): string[] {
  const set = new Set<string>();
  for (const g of groups) for (const p of g.permissions) set.add(p);
  return [...set];
}
