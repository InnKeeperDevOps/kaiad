import { computed, inject, provide, type ComputedRef, type InjectionKey, type Ref } from "vue";
import { hasPermission } from "@sm/contracts";

export type AuthMembership = {
  tenantId: string;
  tenantName: string;
  role: string;
};

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  memberships: AuthMembership[];
  /** Effective permissions for the active tenant (union of the user's groups). */
  permissions: string[];
};

export type AuthState = {
  user: AuthUser | null;
  role: string | null;
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  permissions: string[];
  /** Permission check — `*` (owner/admin) satisfies anything. */
  can: (perm: string) => boolean;
};

const EMPTY: AuthState = {
  user: null,
  role: null,
  isAdmin: false,
  isOperator: false,
  isViewer: false,
  permissions: [],
  can: () => false
};

export const AuthKey: InjectionKey<Ref<AuthUser | null>> = Symbol("AuthUser");

export function buildAuthState(user: AuthUser | null): AuthState {
  if (!user) return EMPTY;
  const role = user.role;
  const permissions = user.permissions ?? [];
  return {
    user,
    role,
    isAdmin: role === "admin" || role === "owner",
    isOperator: role === "operator",
    isViewer: role === "viewer",
    permissions,
    can: (perm: string) => hasPermission(permissions, perm)
  };
}

export function provideAuth(userRef: Ref<AuthUser | null>): void {
  provide(AuthKey, userRef);
}

export function useAuth(): ComputedRef<AuthState> {
  const userRef = inject(AuthKey);
  return computed(() => buildAuthState(userRef ? userRef.value : null));
}
