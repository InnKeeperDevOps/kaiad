import { describe, it, expect } from "vitest";
import {
  hasPermission,
  permissionsForRole,
  BUILTIN_GROUPS,
  builtinGroupName,
  unionPermissions,
  PERMISSIONS
} from "../src/permissions.js";

describe("permissions", () => {
  it("wildcard satisfies anything; exact match otherwise", () => {
    expect(hasPermission(["*"], "services:deploy")).toBe(true);
    expect(hasPermission(["services:read"], "services:read")).toBe(true);
    expect(hasPermission(["services:read"], "services:deploy")).toBe(false);
    expect(hasPermission([], "services:read")).toBe(false);
  });

  it("owner/admin are superusers; viewer is read-only; operator can deploy", () => {
    expect(permissionsForRole("owner")).toEqual(["*"]);
    expect(permissionsForRole("admin")).toEqual(["*"]);
    expect(hasPermission(permissionsForRole("viewer"), "services:read")).toBe(true);
    expect(hasPermission(permissionsForRole("viewer"), "services:deploy")).toBe(false);
    expect(hasPermission(permissionsForRole("operator"), "services:deploy")).toBe(true);
    expect(hasPermission(permissionsForRole("operator"), "users:manage")).toBe(false);
    // unknown role → safest (viewer)
    expect(permissionsForRole("nope")).toEqual(BUILTIN_GROUPS.viewer);
  });

  it("builtinGroupName + unionPermissions", () => {
    expect(builtinGroupName("admin")).toBe("builtin:admin");
    expect(
      unionPermissions([{ permissions: ["a", "b"] }, { permissions: ["b", "c"] }]).sort()
    ).toEqual(["a", "b", "c"]);
  });

  it("every operator/viewer perm is in the catalog", () => {
    const cat = new Set<string>([...PERMISSIONS, "*"]);
    for (const p of [...BUILTIN_GROUPS.operator, ...BUILTIN_GROUPS.viewer]) {
      expect(cat.has(p)).toBe(true);
    }
  });
});
