import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentToPlatformMessageSchema,
  apiErrorSchema,
  buildSummarySchema,
  createEnrollmentTokenResponseSchema,
  listBuildsQuerySchema,
  listBuildsResponseSchema,
  listSshKeysResponseSchema,
  createSshKeyRequestSchema,
  healthResponseSchema,
  listEnrollmentTokensResponseSchema,
  serviceBuildSchema,
  tenantSettingsSchema
} from "../src/index.js";

describe("contracts", () => {
  it("validates api error envelope", () => {
    const parsed = apiErrorSchema.parse({
      code: "POLICY_DENY",
      message: "Denied",
      correlationId: "cid-1"
    });
    expect(parsed.code).toBe("POLICY_DENY");
  });

  it("parses SSH Key contracts", () => {
    const body = createSshKeyRequestSchema.parse({
      name: "My Key",
      type: "uploaded",
      privateKey: "secret"
    });
    expect(body.name).toBe("My Key");
    const list = listSshKeysResponseSchema.parse({
      keys: [{ id: "1", tenantId: "t-1", name: "My Key", type: "uploaded", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]
    });
    expect(list.keys).toHaveLength(1);
  });

  it("validates health response schema", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        uptimeSeconds: 10
      })
    ).toBeTruthy();
  });

  it("parses enrollment token create/list responses", () => {
    const created = createEnrollmentTokenResponseSchema.parse({
      id: "tok-1",
      tenantId: "t-1",
      token: "plaintext-secret",
      expiresAt: "2026-01-01T00:00:00.000Z",
      createdBy: "u-1",
      createdAt: "2025-12-31T00:00:00.000Z",
      usedAt: null,
      revokedAt: null,
      isActive: true
    });
    expect(created.token).toBe("plaintext-secret");

    const listed = listEnrollmentTokensResponseSchema.parse({
      tokens: [
        {
          id: "tok-1",
          tenantId: "t-1",
          expiresAt: "2026-01-01T00:00:00.000Z",
          createdBy: "u-1",
          createdAt: "2025-12-31T00:00:00.000Z",
          usedAt: null,
          revokedAt: null,
          isActive: true
        }
      ]
    });
    expect(listed.tokens[0]).not.toHaveProperty("token");
  });

  it("parses heartbeat fixture", async () => {
    const fixturePath = resolve(import.meta.dirname, "../fixtures/agent-heartbeat.json");
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(agentToPlatformMessageSchema.parse(fixture).type).toBe("heartbeat");
  });

  describe("builds", () => {
    const summary = {
      id: "b-1",
      tenantId: "t-1",
      serviceId: "svc-1",
      serviceName: "web",
      gitSha: "abc123",
      branch: "main",
      status: "success",
      triggeredBy: "manual",
      imageRef: "reg/web@sha256:abc",
      failureReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: null
    };

    it("buildSummarySchema is the build shape minus log/pipelineYaml plus serviceName", () => {
      const full = serviceBuildSchema.parse({ ...summary, log: "...", pipelineYaml: null });
      expect(full.log).toBe("...");
      expect(buildSummarySchema.shape).not.toHaveProperty("log");
      expect(buildSummarySchema.shape).not.toHaveProperty("pipelineYaml");
      expect(buildSummarySchema.shape).toHaveProperty("serviceName");
      expect(buildSummarySchema.parse(summary).serviceName).toBe("web");
      expect(buildSummarySchema.safeParse({ ...summary, serviceName: undefined }).success).toBe(false);
      expect(listBuildsResponseSchema.parse({ builds: [summary], nextCursor: null }).nextCursor).toBeNull();
      expect(listBuildsResponseSchema.parse({ builds: [], nextCursor: "abc" }).nextCursor).toBe("abc");
    });

    it("listBuildsQuerySchema coerces limit from the query string and bounds it", () => {
      expect(listBuildsQuerySchema.parse({})).toEqual({ limit: 50 });
      expect(listBuildsQuerySchema.parse({ limit: "25", status: "failed", triggeredBy: "poll", serviceId: "s", cursor: "c" })).toEqual({
        limit: 25,
        status: "failed",
        triggeredBy: "poll",
        serviceId: "s",
        cursor: "c"
      });
      expect(listBuildsQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
      expect(listBuildsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
      expect(listBuildsQuerySchema.safeParse({ limit: "abc" }).success).toBe(false);
      expect(listBuildsQuerySchema.safeParse({ status: "no_pipeline" }).success).toBe(false);
      expect(listBuildsQuerySchema.safeParse({ triggeredBy: "cron" }).success).toBe(false);
      expect(listBuildsQuerySchema.safeParse({ serviceId: "" }).success).toBe(false);
    });
  });
});
