/**
 * Provider preflight (2026-09-14): billing refusals map to CAPACITY_BLOCKED,
 * auth to AUTH_ERROR, transient to RETRYABLE — the qualification code
 * never sees a billing state, only a provider-agnostic one.
 */
import { describe, expect, it } from "vitest";
import { classifyProviderError, PREFLIGHT_TTL_MINUTES } from "../../scripts/provider-preflight";

describe("provider preflight classification", () => {
  it("credit exhaustion and quota refusals are CAPACITY_BLOCKED (parks benchmarks, never retried in a loop)", () => {
    expect(classifyProviderError({ status: 429, message: "You have no credits remaining", code: "insufficient_quota" })).toBe("CAPACITY_BLOCKED");
    expect(classifyProviderError({ status: 401, message: "You exceeded your current quota" })).toBe("CAPACITY_BLOCKED");
    expect(classifyProviderError({ status: 402, message: "payment required" })).toBe("CAPACITY_BLOCKED");
  });
  it("a bad key is AUTH_ERROR, a missing model is MODEL_UNAVAILABLE, everything else is retryable", () => {
    expect(classifyProviderError({ status: 401, message: "Incorrect API key provided" })).toBe("AUTH_ERROR");
    expect(classifyProviderError({ status: 404, message: "The model `x` does not exist" })).toBe("MODEL_UNAVAILABLE");
    expect(classifyProviderError({ status: 503, message: "overloaded" })).toBe("RETRYABLE_ERROR");
    expect(classifyProviderError(null)).toBe("AVAILABLE");
  });
  it("caches the verdict briefly so a blocked provider is not hammered", () => {
    expect(PREFLIGHT_TTL_MINUTES).toBeGreaterThanOrEqual(15);
  });
});
