import type { TenantSettings } from "@sm/contracts";
import { describe, expect, it } from "vitest";
import { mergeTenantSettings } from "../src/features/settings/mergeTenantSettings.js";

describe("mergeTenantSettings", () => {
  const sessionTenantId = "t-1";

  it("fills required fields from patch when no previous row", () => {
    const base: TenantSettings = { tenantId: sessionTenantId };
    const merged = mergeTenantSettings(base, {
      docsUrl: "https://docs.example.com"
    });
    expect(merged).toEqual({
      tenantId: sessionTenantId,
      docsUrl: "https://docs.example.com"
    });
  });

  it("clears optional fields when patch sets null", () => {
    const previous: TenantSettings = {
      tenantId: sessionTenantId,
      docsUrl: "https://docs.example.com"
    };

    const merged = mergeTenantSettings(previous, {
      docsUrl: null
    });

    expect(merged.docsUrl).toBeUndefined();
  });

  it("keeps previous values when patch does not provide them", () => {
    const previous: TenantSettings = {
      tenantId: sessionTenantId,
      docsUrl: "https://docs.example.com"
    };

    const merged = mergeTenantSettings(previous, {});

    expect(merged).toEqual({
      tenantId: sessionTenantId,
      docsUrl: "https://docs.example.com"
    });
  });
});