/**
 * Prospect-facing terminology (Team Moza review 2026-08-19): the failure
 * modes that cost credibility, pinned. An API benchmark must never render
 * as "we asked ChatGPT"; mention counts must never be labeled as answer
 * counts; sponsored evidence must be distinguishable from independent;
 * competitor-owned surfaces must never be actionable targets.
 */
import { describe, expect, it } from "vitest";
import {
  MENTIONS_VS_ANSWERS_NOTE,
  isActionableSurface,
  providersDisplay,
  recommendationMentionsLine,
  sourceQualityLabel,
  surfaceCategory,
  testedSystemPhrase,
  verifySuggestionApps,
} from "@/lib/prospects/terminology";

describe("testedSystemPhrase — model terminology from run metadata", () => {
  const apiSearchOnly = {
    method: "api" as const,
    searchEnabled: 64,
    modelOnly: 0,
    purpose: "prospecting",
  };

  it("an API search-enabled OpenAI benchmark is described as a model, never as ChatGPT", () => {
    const phrase = testedSystemPhrase(["openai"], apiSearchOnly);
    expect(phrase).toBe("a search-enabled OpenAI model");
    expect(phrase).not.toMatch(/chatgpt/i);
  });

  it("multiple providers list all of them", () => {
    const phrase = testedSystemPhrase(["openai", "perplexity"], apiSearchOnly);
    expect(phrase).toContain("OpenAI");
    expect(phrase).toContain("Perplexity");
    expect(phrase).toContain("search-enabled");
  });

  it("mixed search/model-only collections disclose the split", () => {
    const phrase = testedSystemPhrase(["openai"], {
      method: "api",
      searchEnabled: 32,
      modelOnly: 32,
      purpose: "prospecting",
    });
    expect(phrase).toMatch(/with and without live web search/);
  });

  it("legacy snapshots without collection facts stay neutral, never claim a consumer app", () => {
    const phrase = testedSystemPhrase(["openai"], null);
    expect(phrase).toBe("OpenAI AI models");
    expect(phrase).not.toMatch(/chatgpt/i);
  });

  it("consumer names appear only in the verify invitation, derived from providers", () => {
    expect(verifySuggestionApps(["openai"])).toBe("ChatGPT");
    expect(verifySuggestionApps(["openai", "google"])).toBe("ChatGPT and Gemini");
    expect(verifySuggestionApps(["unknown"])).toBe("any AI assistant");
  });

  it("provider ids render as display names", () => {
    expect(providersDisplay(["openai", "perplexity"])).toBe(
      "OpenAI and Perplexity"
    );
  });
});

describe("mention counts vs answer counts", () => {
  it("189 mentions over 64 answers renders both units and never '189 answers'", () => {
    const line = recommendationMentionsLine(189, 64);
    expect(line).toBe("189 recommendation mentions across the 64 answers");
    expect(line).not.toContain("189 answers");
  });

  it("the note explains why mentions outnumber answers", () => {
    expect(MENTIONS_VS_ANSWERS_NOTE).toMatch(/mentions outnumber answers/);
  });
});

describe("source quality labels", () => {
  it("sponsored is distinguishable from independent", () => {
    expect(sourceQualityLabel("sponsored")).toBe("Sponsored coverage");
    expect(sourceQualityLabel("independent")).toBe("Independent source");
    expect(sourceQualityLabel("sponsored")).not.toBe(
      sourceQualityLabel("independent")
    );
  });

  it("derived estimates are labeled as such", () => {
    expect(sourceQualityLabel("derived")).toBe("Derived estimate");
  });

  it("legacy/unclassified rows get no badge, never a guess", () => {
    expect(sourceQualityLabel(null)).toBeNull();
    expect(sourceQualityLabel(undefined)).toBeNull();
  });
});

describe("actionable surfaces vs competitor-owned diagnostics", () => {
  it("competitor-owned sources are categorized but never actionable", () => {
    const category = surfaceCategory({
      sourceType: "brokerage",
      relationship: "competitor",
    });
    expect(category).toBe("competitor");
    expect(isActionableSurface(category)).toBe(false);
  });

  it("portals and directories are actionable third-party platforms", () => {
    const category = surfaceCategory({
      sourceType: "portal",
      relationship: "third_party",
    });
    expect(category).toBe("platform");
    expect(isActionableSurface(category)).toBe(true);
  });

  it("press and rankings are earned surfaces", () => {
    expect(
      surfaceCategory({ sourceType: "local_press", relationship: "third_party" })
    ).toBe("earned");
    expect(
      surfaceCategory({
        sourceType: "industry_ranking",
        relationship: "third_party",
      })
    ).toBe("earned");
  });

  it("the prospect's own site is owned", () => {
    expect(
      surfaceCategory({ sourceType: "client_site", relationship: "owned" })
    ).toBe("owned");
  });

  it("unclassifiable domains get no category, never a guess", () => {
    expect(
      surfaceCategory({ sourceType: "other", relationship: "third_party" })
    ).toBeNull();
  });

});
