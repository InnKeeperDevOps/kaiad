import { agentHelloMessageSchema, type TenantSettings } from "@sm/contracts";

/** Builds the first WebSocket frame for enrolled agents (runtime + workload policy from tenant settings). */
export function buildRealtimeAgentHello(settings: TenantSettings | undefined) {
  const runtimeBackend: "docker" | "kubernetes" | "shell" = "docker";

  try {
    return agentHelloMessageSchema.parse({
      type: "hello",
      service: "realtime",
      runtime: { backend: runtimeBackend }
    });
  } catch (e) {
    console.error("Parse Error in buildRealtimeAgentHello:", e);
    throw e;
  }
}
