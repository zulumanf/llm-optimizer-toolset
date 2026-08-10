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
  mockScoringAllowed,
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

/**
 * Spec 050: permission to RUN the mock is not permission to SCORE it.
 * ALLOW_MOCK_PROVIDER was one flag doing both jobs, so the standard local
 * recipe, set in a deployed process, folded fabricated answers into real
 * score rows. The scoring fence is stricter and fails closed under the
 * real-auth posture no matter what flags say.
 */
describe("mock scoring fence", () => {
  it("allows scoring mock under the test runner", () => {
    expect(mockScoringAllowed()).toBe(true);
  });

  it("refuses to score mock when only ALLOW_MOCK_PROVIDER is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ALLOW_MOCK_PROVIDER", "1");
    vi.stubEnv("ALLOW_MOCK_SCORING", "");
    expect(mockProviderAllowed()).toBe(true);
    expect(mockScoringAllowed()).toBe(false);
  });

  it("honours the explicit ALLOW_MOCK_SCORING opt-in outside real auth", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ALLOW_MOCK_SCORING", "1");
    expect(mockScoringAllowed()).toBe(true);
  });

  it("refuses under AUTH_MODE=supabase regardless of every flag", () => {
    vi.stubEnv("AUTH_MODE", "supabase");
    vi.stubEnv("ALLOW_MOCK_PROVIDER", "1");
    vi.stubEnv("ALLOW_MOCK_SCORING", "1");
    expect(mockScoringAllowed()).toBe(false);
  });
});
