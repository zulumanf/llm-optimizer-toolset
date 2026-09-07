/**
 * Observation provenance (spec 086): collection method, surface, tier, and
 * purpose are pure functions of stored instrument facts — deterministic,
 * never independently editable. These tests pin the derivations and the
 * business invariants: API observations can never read as consumer
 * observations, and no automated consumer collector exists.
 */
import { describe, expect, it } from "vitest";
import {
  apiSurface,
  apiObservationProvenance,
  manualObservationProvenance,
  measurementTier,
  measurementPurpose,
  COLLECTOR_REGISTRY,
} from "@/lib/runs/provenance";

describe("apiSurface", () => {
  it("perplexity is always search-grounded", () => {
    expect(
      apiSurface({ provider: "perplexity", model: "sonar", requestParams: null })
    ).toBe("web_search");
  });

  it("+search model variants are web_search", () => {
    expect(
      apiSurface({
        provider: "anthropic",
        model: "claude-opus-5+search",
        requestParams: null,
      })
    ).toBe("web_search");
  });

  it("recorded search tools mark web_search (openai and google spellings)", () => {
    expect(
      apiSurface({
        provider: "openai",
        model: "gpt-5.4",
        requestParams: { tools: ["web_search"] },
      })
    ).toBe("web_search");
    expect(
      apiSurface({
        provider: "google",
        model: "gemini-3-flash-preview",
        requestParams: { tools: ["googleSearch"] },
      })
    ).toBe("web_search");
  });

  it("no search evidence → model_only, including legacy rows with null request_params", () => {
    expect(
      apiSurface({ provider: "openai", model: "gpt-5.4", requestParams: null })
    ).toBe("model_only");
    expect(
      apiSurface({
        provider: "anthropic",
        model: "claude-sonnet-5",
        requestParams: { tools: [] },
      })
    ).toBe("model_only");
  });
});

describe("measurementTier", () => {
  it("consumer observations are Tier A, search API B, licensed C, model-only D", () => {
    expect(measurementTier("manual_ui", "consumer_web")).toBe("A");
    expect(measurementTier("consumer_ui", "consumer_web")).toBe("A");
    expect(measurementTier("api", "web_search")).toBe("B");
    expect(measurementTier("licensed_provider", "web_search")).toBe("C");
    expect(measurementTier("serp_provider", "web_search")).toBe("C");
    expect(measurementTier("api", "model_only")).toBe("D");
  });

  it("an API observation can never derive a consumer tier label", () => {
    // The invariant behind "API runs cannot be presented as consumer UI
    // observations": with method 'api', every surface maps to B or D.
    expect(measurementTier("api", "web_search")).not.toBe("A");
    expect(measurementTier("api", "model_only")).not.toBe("A");
    expect(apiObservationProvenance({
      provider: "openai",
      model: "gpt-5.4+search",
      requestParams: { tools: ["web_search"] },
    }).collectionMethod).toBe("api");
  });

  it("manual observations always derive consumer provenance", () => {
    const p = manualObservationProvenance();
    expect(p).toEqual({
      collectionMethod: "manual_ui",
      surface: "consumer_web",
      tier: "A",
      tierLabel: "Consumer UI observed",
    });
  });
});

describe("measurementPurpose", () => {
  it("intervention role wins over everything", () => {
    expect(
      measurementPurpose({
        projectKind: "client",
        trigger: "scheduled",
        interventionRole: "post",
      })
    ).toBe("experiment_followup");
    expect(
      measurementPurpose({
        projectKind: "client",
        trigger: "manual",
        interventionRole: "baseline",
      })
    ).toBe("client_baseline");
  });

  it("prospect projects measure for prospecting; client projects split by trigger", () => {
    expect(
      measurementPurpose({
        projectKind: "prospect",
        trigger: "manual",
        interventionRole: null,
      })
    ).toBe("prospecting");
    expect(
      measurementPurpose({
        projectKind: "prospect",
        trigger: "scheduled",
        interventionRole: null,
      })
    ).toBe("prospecting");
    expect(
      measurementPurpose({
        projectKind: "client",
        trigger: "scheduled",
        interventionRole: null,
      })
    ).toBe("client_monitoring");
    expect(
      measurementPurpose({
        projectKind: "client",
        trigger: "manual",
        interventionRole: null,
      })
    ).toBe("client_baseline");
  });
});

describe("COLLECTOR_REGISTRY", () => {
  it("every consumer surface is manual-only — no automated consumer collection exists", () => {
    const consumer = COLLECTOR_REGISTRY.filter(
      (c) => c.surface === "consumer_web"
    );
    expect(consumer.length).toBeGreaterThan(0);
    for (const c of consumer) {
      expect(c.status).toBe("manual_only");
      expect(c.collectorType).toBe("manual_ui");
    }
  });

  it("every API collector maps to a real provider id", () => {
    const apiProviders = new Set(
      COLLECTOR_REGISTRY.filter((c) => c.collectorType === "api").map(
        (c) => c.provider
      )
    );
    expect([...apiProviders].sort()).toEqual([
      "anthropic",
      "google",
      "openai",
      "perplexity",
    ]);
  });
});
