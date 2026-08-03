/**
 * A1 (pilot-launch-plan): the mock provider must be unreachable outside
 * tests. Its canned answers flow through the real parser into real scores;
 * a deployment that loses its API keys must fail loudly, not measure
 * fiction. These tests simulate a production environment by stubbing away
 * every signal the guard accepts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProvider,
  isKnownModel,
  listAllModels,
  mockProviderAllowed,
} from "@/lib/ai/registry";
import { ClassifiedError } from "@/lib/errors";

function stubProductionEnv(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", "");
  vi.stubEnv("ALLOW_MOCK_PROVIDER", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mock provider production guard", () => {
  it("is allowed under the test runner without any opt-in", () => {
    expect(mockProviderAllowed()).toBe(true);
    expect(getProvider("mock").id).toBe("mock");
  });

  it("refuses getProvider('mock') in a production environment", () => {
    stubProductionEnv();
    expect(mockProviderAllowed()).toBe(false);
    expect(() => getProvider("mock")).toThrowError(ClassifiedError);
    expect(() => getProvider("mock")).toThrowError(/disabled outside tests/);
  });

  it("does not offer mock models to the UI in production", () => {
    stubProductionEnv();
    const providers = new Set(listAllModels().map((m) => m.provider));
    expect(providers.has("mock")).toBe(false);
    // Real providers are unaffected by the guard.
    expect(providers.has("openai")).toBe(true);
  });

  it("rejects mock models at run validation in production", () => {
    stubProductionEnv();
    expect(isKnownModel("mock", "mock-model")).toBe(false);
  });

  it("honours an explicit development opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ALLOW_MOCK_PROVIDER", "1");
    expect(mockProviderAllowed()).toBe(true);
    expect(isKnownModel("mock", "mock-model")).toBe(true);
  });

  it("treats falsy opt-in strings as no opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    for (const value of ["0", "false", ""]) {
      vi.stubEnv("ALLOW_MOCK_PROVIDER", value);
      expect(mockProviderAllowed()).toBe(false);
    }
  });

  it("still refuses genuinely unknown providers with a classified error", () => {
    expect(() => getProvider("nope" as never)).toThrowError(ClassifiedError);
  });
});
