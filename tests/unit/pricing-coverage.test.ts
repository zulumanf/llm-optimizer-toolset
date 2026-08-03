/**
 * A2 (pilot-launch-plan): pricing must cover every model the platform can
 * call, and an unknown model must be loud. The old `return 0` for unknown
 * models recorded real spend as $0 and made `state.spentMicro` never grow —
 * the run budget cap could not fire for any Gemini or Anthropic-search run
 * because their current ids simply weren't in the table.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { PRICING, costMicroUsd, hasPricing } from "@/lib/ai/pricing";
import { listAllModels } from "@/lib/ai/registry";
import { AGENT_MODEL } from "@/lib/ai/agent";
import { CLASSIFIER_MODEL } from "@/lib/constants";
import { DISCOVERY_SEARCH_MODEL } from "@/lib/knowledge/discovery/service";
import { providerConfigSchema } from "@/lib/runs/validation";
import { ClassifiedError } from "@/lib/errors";

afterEach(() => vi.unstubAllEnvs());

describe("pricing coverage invariant", () => {
  it("has a pricing entry for every model every adapter offers", () => {
    const unpriced = listAllModels()
      .map((m) => m.id)
      .filter((id) => !hasPricing(id));
    expect(unpriced).toEqual([]);
  });

  it("has a pricing entry for the pinned internal models", () => {
    for (const model of [AGENT_MODEL, CLASSIFIER_MODEL, DISCOVERY_SEARCH_MODEL]) {
      expect(hasPricing(model), `${model} must be priced`).toBe(true);
    }
  });

  it("computes a non-zero cost for the current Gemini ids (budget cap enabler)", () => {
    for (const model of [
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview+search",
      "claude-opus-5+search",
      "claude-sonnet-5+search",
    ]) {
      expect(costMicroUsd(model, 1_000, 1_000)).toBeGreaterThan(0);
    }
  });

  it("throws a classified error for an unknown model instead of returning 0", () => {
    expect(() => costMicroUsd("some-future-model", 1_000, 1_000)).toThrowError(
      ClassifiedError
    );
    expect(() => costMicroUsd("some-future-model", 1_000, 1_000)).toThrowError(
      /No pricing entry/
    );
  });

  it("keeps unverified prices flagged so run estimates disclose them", () => {
    for (const model of ["gemini-3-flash-preview", "claude-opus-5+search", "sonar"]) {
      expect(PRICING[model]?.verified).toBe(false);
    }
  });

  it("rejects a run config whose model has no pricing entry", () => {
    // A registry model missing from PRICING would make the budget
    // unenforceable; simulate one by checking the schema path directly.
    const result = providerConfigSchema.safeParse({
      provider: "google",
      model: "gemini-2.5-flash", // retired: no longer in registry or pricing
      repetitions: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a run config for a priced registry model", () => {
    const result = providerConfigSchema.safeParse({
      provider: "google",
      model: "gemini-3-flash-preview",
      repetitions: 1,
    });
    expect(result.success).toBe(true);
  });
});
