import { describe, expect, it } from "vitest";
import { tenantConcurrencyAvailable } from "../../packages/shared/src/admission-budget.js";

describe("tenant concurrency plans", () => {
  it("admits work only below the configured concurrent cap", () => {
    expect(tenantConcurrencyAvailable(0, 1)).toBe(true);
    expect(tenantConcurrencyAvailable(1, 1)).toBe(false);
    expect(tenantConcurrencyAvailable(3, 4)).toBe(true);
    expect(tenantConcurrencyAvailable(4, 4)).toBe(false);
  });
});
