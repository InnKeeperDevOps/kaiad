<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDown, X } from "lucide-vue-next";
import type { MonitoredService } from "../../lib/api.js";

// Searchable single-select over the tenant's services. The option set is
// database-backed (and can be large), so it is a combobox rather than a
// plain <select> or free-text input: type to filter, arrow keys / Enter
// to pick, Escape to close. An empty value means "all services".
const props = defineProps<{
  services: MonitoredService[];
  modelValue: string;
  inputId?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const ALL_OPTION = { id: "", name: "All services" } as const;

const open = ref(false);
const query = ref("");
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const listId = `${props.inputId ?? "service-combobox"}-listbox`;

const selected = computed(() => props.services.find((s) => s.id === props.modelValue) ?? null);

/** What the input shows when the user is not typing. */
const displayLabel = computed(() => {
  if (!props.modelValue) return ALL_OPTION.name;
  return selected.value?.name ?? props.modelValue;
});

const options = computed<Array<{ id: string; name: string; branch?: string }>>(() => {
  const needle = query.value.trim().toLowerCase();
  const matches = props.services
    .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle))
    .slice(0, 200)
    .map((s) => ({ id: s.id, name: s.name, branch: s.branch }));
  // "All services" is always offered unless the user is actively filtering.
  return needle ? matches : [ALL_OPTION, ...matches];
});

watch(options, (opts) => {
  if (activeIndex.value >= opts.length) activeIndex.value = Math.max(0, opts.length - 1);
});

function openList() {
  if (open.value) return;
  open.value = true;
  query.value = "";
  const idx = options.value.findIndex((o) => o.id === props.modelValue);
  activeIndex.value = idx >= 0 ? idx : 0;
}

function closeList() {
  open.value = false;
  query.value = "";
}

function choose(id: string) {
  if (id !== props.modelValue) emit("update:modelValue", id);
  closeList();
  void nextTick(() => inputEl.value?.blur());
}

function clear() {
  if (props.modelValue) emit("update:modelValue", "");
  closeList();
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    e.preventDefault();
    openList();
    return;
  }
  if (!open.value) return;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      activeIndex.value = Math.min(activeIndex.value + 1, options.value.length - 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      activeIndex.value = Math.max(activeIndex.value - 1, 0);
      break;
    case "Enter": {
      e.preventDefault();
      const opt = options.value[activeIndex.value];
      if (opt) choose(opt.id);
      break;
    }
    case "Escape":
      e.preventDefault();
      closeList();
      break;
    case "Tab":
      closeList();
      break;
  }
}

function onInput(e: Event) {
  query.value = (e.target as HTMLInputElement).value;
  if (!open.value) open.value = true;
  activeIndex.value = 0;
}

function onBlur() {
  // Option clicks use mousedown.prevent so the input never blurs before
  // the choice lands; anything else that steals focus closes the list.
  closeList();
}
</script>

<template>
  <div class="svc-combo">
    <input
      :id="inputId"
      ref="inputEl"
      class="svc-combo__input"
      type="text"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && options[activeIndex] ? `${listId}-${activeIndex}` : undefined"
      :placeholder="open ? 'Type to search services…' : ''"
      :value="open ? query : displayLabel"
      @focus="openList"
      @click="openList"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <button
      v-if="modelValue"
      type="button"
      class="svc-combo__clear"
      title="All services"
      aria-label="Clear service filter"
      @mousedown.prevent
      @click="clear"
    >
      <X :size="12" />
    </button>
    <ChevronDown v-else :size="14" class="svc-combo__chev" aria-hidden="true" />

    <ul v-if="open" :id="listId" class="svc-combo__list" role="listbox" aria-label="Services">
      <li v-if="options.length === 0" class="svc-combo__empty">No services match “{{ query }}”</li>
      <li
        v-for="(opt, i) in options"
        :id="`${listId}-${i}`"
        :key="opt.id || '__all__'"
        role="option"
        :aria-selected="opt.id === modelValue"
        :class="['svc-combo__option', { 'is-active': i === activeIndex, 'is-selected': opt.id === modelValue }]"
        @mousedown.prevent
        @mouseenter="activeIndex = i"
        @click="choose(opt.id)"
      >
        <span class="svc-combo__name">{{ opt.name }}</span>
        <span v-if="opt.branch" class="svc-combo__branch">{{ opt.branch }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.svc-combo {
  position: relative;
  min-width: 16rem;
}
.svc-combo__input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.4rem 1.9rem 0.4rem 0.6rem;
  border: 1px solid var(--color-border-strong);
  border-radius: 8px;
  font-size: 0.85rem;
  background: var(--color-surface);
  color: var(--color-text);
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.svc-combo__input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-subtle);
  outline: none;
}
.svc-combo__chev,
.svc-combo__clear {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-text-muted);
}
.svc-combo__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.3rem;
  height: 1.3rem;
  border: none;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-secondary);
}
.svc-combo__clear:hover {
  background: var(--color-surface-muted);
  color: var(--color-text);
}
.svc-combo__list {
  position: absolute;
  z-index: 20;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  max-height: 16rem;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: var(--shadow-md);
}
.svc-combo__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0.55rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--color-text);
}
.svc-combo__option.is-active {
  background: var(--color-surface-muted);
}
.svc-combo__option.is-selected .svc-combo__name {
  color: var(--color-primary);
  font-weight: 600;
}
.svc-combo__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.svc-combo__branch {
  flex-shrink: 0;
  font-size: 0.72rem;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}
.svc-combo__empty {
  padding: 0.5rem 0.55rem;
  font-size: 0.82rem;
  color: var(--color-text-secondary);
}
</style>
