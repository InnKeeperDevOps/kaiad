import { describe, expect, it } from "vitest";
import { buildRealtimeAgentHello } from "../src/agentHelloPayload.js";

describe("buildRealtimeAgentHello", () => {
  it("defaults to docker backend when no settings exist", () => {
    const h = buildRealtimeAgentHello(undefined);
    expect(h.runtime?.backend).toBe("docker");
  });

  it("returns a docker hello regardless of tenant settings", () => {
    const h = buildRealtimeAgentHello({ tenantId: "t-1" });
    expect(h.type).toBe("hello");
    expect(h.service).toBe("realtime");
    expect(h.runtime?.backend).toBe("docker");
  });
});
