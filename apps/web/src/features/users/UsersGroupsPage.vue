<script setup lang="ts">
// Tenant user + permission-group administration. Read requires
// users:read; all mutations require users:manage (also enforced by the
// API). Built-in groups (builtin:owner/admin/operator/viewer) are
// read-only; custom groups are fully editable.
import { ref, onMounted, computed } from "vue";
import { api, type PermissionGroup, type TenantMember } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import Card from "../../components/Card.vue";
import Button from "../../components/Button.vue";

const auth = useAuth();
const canManage = computed(() => auth.value.can("users:manage"));

const loading = ref(true);
const error = ref<string | null>(null);
const msg = ref<string | null>(null);
const users = ref<TenantMember[]>([]);
const groups = ref<PermissionGroup[]>([]);
const allPerms = ref<string[]>([]);

const ROLES = ["owner", "admin", "operator", "viewer"] as const;

async function reload() {
  loading.value = true;
  error.value = null;
  try {
    const [u, g, p] = await Promise.all([api.listUsers(), api.listGroups(), api.listPermissions()]);
    users.value = u.users;
    groups.value = g.groups;
    allPerms.value = p.permissions;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(reload);

function flash(m: string, ok = true) {
  msg.value = m;
  error.value = ok ? null : m;
  if (ok) error.value = null;
  setTimeout(() => (msg.value = null), 4000);
}
async function guard(fn: () => Promise<unknown>) {
  try {
    await fn();
    await reload();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// ---- Members ----
const inviteEmail = ref("");
const inviteRole = ref<string>("viewer");
const customGroups = computed(() => groups.value.filter((g) => !g.builtin));

async function addMember() {
  if (!inviteEmail.value.trim()) return;
  await guard(async () => {
    await api.addUser(inviteEmail.value.trim(), inviteRole.value);
    inviteEmail.value = "";
    flash("Member added.");
  });
}
async function changeRole(m: TenantMember, role: string) {
  await guard(() => api.updateUser(m.userId, { role }));
}
async function toggleMemberGroup(m: TenantMember, gid: string) {
  const cur = m.groups.filter((g) => !g.builtin).map((g) => g.id);
  const next = cur.includes(gid) ? cur.filter((x) => x !== gid) : [...cur, gid];
  await guard(() => api.updateUser(m.userId, { groupIds: next }));
}
async function removeMember(m: TenantMember) {
  if (!window.confirm(`Remove ${m.email} from this tenant?`)) return;
  await guard(() => api.removeUser(m.userId));
}

// ---- Groups ----
const editingId = ref<string | null>(null);
const draftName = ref("");
const draftDesc = ref("");
const draftPerms = ref<string[]>([]);
const creating = ref(false);

function startCreate() {
  creating.value = true;
  editingId.value = null;
  draftName.value = "";
  draftDesc.value = "";
  draftPerms.value = [];
}
function startEdit(g: PermissionGroup) {
  if (g.builtin) return;
  creating.value = false;
  editingId.value = g.id;
  draftName.value = g.name;
  draftDesc.value = g.description;
  draftPerms.value = [...g.permissions];
}
function togglePerm(p: string) {
  draftPerms.value = draftPerms.value.includes(p)
    ? draftPerms.value.filter((x) => x !== p)
    : [...draftPerms.value, p];
}
function cancelEdit() {
  creating.value = false;
  editingId.value = null;
}
async function saveGroup() {
  if (!draftName.value.trim()) return;
  await guard(async () => {
    if (creating.value) {
      await api.createGroup({
        name: draftName.value.trim(),
        description: draftDesc.value,
        permissions: draftPerms.value
      });
    } else if (editingId.value) {
      await api.updateGroup(editingId.value, {
        name: draftName.value.trim(),
        description: draftDesc.value,
        permissions: draftPerms.value
      });
    }
    cancelEdit();
    flash("Group saved.");
  });
}
async function removeGroup(g: PermissionGroup) {
  if (g.builtin) return;
  if (!window.confirm(`Delete group "${g.name}"?`)) return;
  await guard(() => api.deleteGroup(g.id));
}
</script>

<template>
  <section>
    <div :style="{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }">
      <h2 :style="{ margin: 0 }">Users &amp; Groups</h2>
      <span v-if="!canManage" class="sm-badge sm-badge--muted">read-only — needs users:manage</span>
    </div>

    <p v-if="error" :style="{ color: 'var(--color-danger)' }">{{ error }}</p>
    <p v-if="msg" :style="{ color: 'var(--color-success)' }">{{ msg }}</p>
    <p v-if="loading">Loading…</p>

    <template v-else>
      <Card title="Members" :style="{ marginBottom: '1rem' }">
        <template v-if="canManage" #actions>
          <div :style="{ display: 'flex', gap: '0.4rem', alignItems: 'center' }">
            <input class="sm-input" style="min-width:14rem" v-model="inviteEmail" placeholder="existing user's email" />
            <select class="sm-input" style="width:8rem" v-model="inviteRole">
              <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
            </select>
            <Button variant="primary" size="sm" @click="addMember">Add member</Button>
          </div>
        </template>
        <table class="sm-table">
          <thead>
            <tr><th>Email</th><th>Role</th><th>Custom groups</th><th v-if="canManage"></th></tr>
          </thead>
          <tbody>
            <tr v-for="m in users" :key="m.userId">
              <td>{{ m.email }}</td>
              <td>
                <select
                  v-if="canManage"
                  class="sm-input"
                  style="width:8rem"
                  :value="m.role"
                  @change="changeRole(m, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
                </select>
                <span v-else class="sm-badge sm-badge--muted">{{ m.role }}</span>
              </td>
              <td>
                <span v-if="!customGroups.length" :style="{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }">—</span>
                <label
                  v-for="g in customGroups"
                  :key="g.id"
                  :style="{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center', marginRight: '0.75rem', fontSize: '0.8rem' }"
                >
                  <input
                    type="checkbox"
                    :disabled="!canManage"
                    :checked="m.groups.some((x) => x.id === g.id)"
                    @change="toggleMemberGroup(m, g.id)"
                  />
                  {{ g.name }}
                </label>
              </td>
              <td v-if="canManage">
                <Button variant="ghost" size="sm" @click="removeMember(m)">Remove</Button>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card title="Permission groups">
        <template v-if="canManage" #actions>
          <Button variant="primary" size="sm" @click="startCreate">+ New group</Button>
        </template>

        <div
          v-if="creating || editingId"
          :style="{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0.75rem', marginBottom: '1rem' }"
        >
          <div :style="{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }">
            <input class="sm-input" style="min-width:12rem" v-model="draftName" placeholder="group name" />
            <input class="sm-input" style="flex:1;min-width:14rem" v-model="draftDesc" placeholder="description" />
          </div>
          <div :style="{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem 1rem' }">
            <label
              v-for="p in allPerms"
              :key="p"
              :style="{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center', fontSize: '0.78rem', fontFamily: 'ui-monospace, monospace' }"
            >
              <input type="checkbox" :checked="draftPerms.includes(p)" @change="togglePerm(p)" />
              {{ p }}
            </label>
          </div>
          <div :style="{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }">
            <Button variant="primary" size="sm" @click="saveGroup">Save</Button>
            <Button variant="ghost" size="sm" @click="cancelEdit">Cancel</Button>
          </div>
        </div>

        <table class="sm-table">
          <thead>
            <tr><th>Group</th><th>Permissions</th><th v-if="canManage"></th></tr>
          </thead>
          <tbody>
            <tr v-for="g in groups" :key="g.id">
              <td>
                <strong>{{ g.name }}</strong>
                <span v-if="g.builtin" class="sm-badge sm-badge--muted" style="margin-left:0.4rem">built-in</span>
                <div :style="{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }">{{ g.description }}</div>
              </td>
              <td :style="{ fontSize: '0.75rem', fontFamily: 'ui-monospace, monospace' }">
                {{ g.permissions.join(", ") }}
              </td>
              <td v-if="canManage">
                <template v-if="!g.builtin">
                  <Button variant="secondary" size="sm" @click="startEdit(g)">Edit</Button>
                  <Button variant="ghost" size="sm" @click="removeGroup(g)">Delete</Button>
                </template>
                <span v-else :style="{ color: 'var(--color-text-muted)', fontSize: '0.78rem' }">read-only</span>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>
    </template>
  </section>
</template>
