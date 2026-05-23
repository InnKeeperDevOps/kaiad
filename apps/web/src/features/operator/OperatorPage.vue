<script setup lang="ts">
import { type CSSProperties } from "vue";
import { Workflow } from "lucide-vue-next";
import Card from "../../components/Card.vue";
import ComponentLogViewer from "../agents/ComponentLogViewer.vue";

// Operator details — one per cluster; surfaces the kaiad-operator's own
// process logs so admins can debug reconcile loops, agent auto-update,
// and RBAC apply behaviour without ssh-ing into the cluster.
const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "1rem"
};
</script>

<template>
  <section :style="{ width: '100%' }">
    <header :style="headerStyle">
      <Workflow :size="22" />
      <h2 :style="{ margin: 0 }">Operator</h2>
    </header>
    <p :style="{ color: 'var(--color-text-secondary)', marginTop: 0 }">
      The kaiad-operator runs in the target cluster and manages KaiadAgent
      resources: image rollouts, RBAC, namespace allowlist, and shipping
      its own logs back here. There's one operator per cluster.
    </p>

    <Card title="Operator logs">
      <ComponentLogViewer kind="operator" />
    </Card>
  </section>
</template>
