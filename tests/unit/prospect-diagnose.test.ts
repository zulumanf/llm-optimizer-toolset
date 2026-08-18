/**
 * Known-answer tests for the diagnosis layer (spec 042): every key has a
 * triggering and a non-triggering case; absence-of-research diagnoses carry
 * low confidence and honest wording.
 */
import { describe, expect, it } from "vitest";
import { deriveDiagnoses, type DiagnoseInputs, type PromptOutcome } from "@/lib/prospects/diagnose";

const prompt = (over: Partial<PromptOutcome>): PromptOutcome => ({
  promptText: "best luxury team in manhattan?",
  tier: null,
  category: "recommendation",
  responses: 3,
  mentioned: 0,
  recommended: 0,
  ...over,
});

const base = (): DiagnoseInputs => ({
  prospectDomain: "riverateam.com",
  prospectCompanyName: "Rivera Team",
  prompts: [],
  citedDomains: [],
  competitorCompanies: [],
  signalKinds: ["review_footprint", "press_mention"],
  assessments: {},
});

const keys = (inputs: DiagnoseInputs): string[] =>
  deriveDiagnoses(inputs).map((d) => d.key);

describe("deriveDiagnoses", () => {
  it("no_organic_visibility triggers on zero mentions, with affected prompts", () => {
    const inputs = { ...base(), prompts: [prompt({}), prompt({ promptText: "second?" })] };
    const diagnosis = deriveDiagnoses(inputs).find((d) => d.key === "no_organic_visibility")!;
    expect(diagnosis).toBeDefined();
    expect(diagnosis.affectedPrompts.length).toBe(2);
    // v2 epistemics: the measured fact lives in observations, the reading
    // of it in explanation — both present, kept apart.
    expect(diagnosis.observations.join(" ")).toContain("0 of 6");
    expect(diagnosis.explanation.length).toBeGreaterThan(0);
    // Mentioned somewhere → not triggered.
    expect(
      keys({ ...base(), prompts: [prompt({ mentioned: 1 })] })
    ).not.toContain("no_organic_visibility");
  });

  it("mentioned_never_recommended triggers only when mentioned and never endorsed", () => {
    expect(
      keys({ ...base(), prompts: [prompt({ mentioned: 2, recommended: 0, responses: 6 })] })
    ).toContain("mentioned_never_recommended");
    expect(
      keys({ ...base(), prompts: [prompt({ mentioned: 2, recommended: 1, responses: 6 })] })
    ).not.toContain("mentioned_never_recommended");
    expect(keys({ ...base(), prompts: [prompt({})] })).not.toContain(
      "mentioned_never_recommended"
    );
  });

  it("missing_from_high_intent_prompts needs visibility elsewhere plus total high-intent absence", () => {
    const inputs = {
      ...base(),
      prompts: [
        prompt({ promptText: "high intent?", tier: 1, mentioned: 0 }),
        prompt({ promptText: "broad?", tier: 4, category: "how-to", mentioned: 2 }),
      ],
    };
    const diagnosis = deriveDiagnoses(inputs).find(
      (d) => d.key === "missing_from_high_intent_prompts"
    )!;
    expect(diagnosis).toBeDefined();
    expect(diagnosis.affectedPrompts).toEqual(["high intent?"]);
    // Present in one high-intent prompt → not triggered.
    expect(
      keys({
        ...base(),
        prompts: [
          prompt({ tier: 1, mentioned: 1 }),
          prompt({ promptText: "b", tier: 2, mentioned: 0 }),
          prompt({ promptText: "c", tier: 4, category: "how-to", mentioned: 1 }),
        ],
      })
    ).not.toContain("missing_from_high_intent_prompts");
  });

  it("missing_from_cited_sources triggers when citations exist and own domain never appears", () => {
    const inputs = {
      ...base(),
      prompts: [prompt({ mentioned: 1 })],
      citedDomains: [
        { domain: "zillow.com", citations: 5 },
        { domain: "therealdeal.com", citations: 2 },
      ],
    };
    const diagnosis = deriveDiagnoses(inputs).find(
      (d) => d.key === "missing_from_cited_sources"
    )!;
    expect(diagnosis.citedDomains.length).toBe(2);
    // Own domain cited → not triggered.
    expect(
      keys({
        ...inputs,
        citedDomains: [...inputs.citedDomains, { domain: "riverateam.com", citations: 1 }],
      })
    ).not.toContain("missing_from_cited_sources");
    // No citations at all → not triggered (nothing measured).
    expect(keys({ ...base(), prompts: [prompt({})] })).not.toContain(
      "missing_from_cited_sources"
    );
  });

  it("competitors_dominate_sources triggers at ≥50% competitor-owned citations", () => {
    const inputs = {
      ...base(),
      citedDomains: [
        { domain: "acmerealty.com", citations: 6 },
        { domain: "zillow.com", citations: 4 },
      ],
      competitorCompanies: [{ name: "Acme Realty", domain: "acmerealty.com" }],
    };
    const diagnosis = deriveDiagnoses(inputs).find(
      (d) => d.key === "competitors_dominate_sources"
    )!;
    expect(diagnosis.competitors).toContain("Acme Realty");
    expect(
      keys({
        ...inputs,
        citedDomains: [
          { domain: "acmerealty.com", citations: 2 },
          { domain: "zillow.com", citations: 8 },
        ],
      })
    ).not.toContain("competitors_dominate_sources");
  });

  it("entity_ambiguity triggers on a normalized name collision", () => {
    const inputs = {
      ...base(),
      competitorCompanies: [{ name: "The Rivera Group", domain: null }],
    };
    const diagnosis = deriveDiagnoses(inputs).find((d) => d.key === "entity_ambiguity")!;
    expect(diagnosis.competitors).toEqual(["The Rivera Group"]);
    expect(
      keys({ ...base(), competitorCompanies: [{ name: "Acme", domain: null }] })
    ).not.toContain("entity_ambiguity");
  });

  it("unstable_sample below 6 organic responses, full confidence — it's a fact about the sample", () => {
    const diagnosis = deriveDiagnoses({
      ...base(),
      prompts: [prompt({ responses: 5, mentioned: 5, recommended: 5 })],
    }).find((d) => d.key === "unstable_sample")!;
    expect(diagnosis.confidence).toBe(1);
    expect(
      keys({ ...base(), prompts: [prompt({ responses: 6, mentioned: 6, recommended: 6 })] })
    ).not.toContain("unstable_sample");
  });

  it("assessment-driven diagnoses fire on explicit no, not unknown", () => {
    expect(keys({ ...base(), assessments: { website_indexable: "no" } })).toContain(
      "website_not_indexable"
    );
    expect(keys({ ...base(), assessments: { website_indexable: "unknown" } })).not.toContain(
      "website_not_indexable"
    );
    expect(
      keys({ ...base(), assessments: { structured_data_consistent: "no" } })
    ).toContain("weak_structured_data");
  });

  it("absence-of-research diagnoses carry low confidence and say they are about our research", () => {
    const inputs = { ...base(), signalKinds: [] as DiagnoseInputs["signalKinds"] };
    const reviews = deriveDiagnoses(inputs).find((d) => d.key === "no_review_evidence")!;
    const media = deriveDiagnoses(inputs).find((d) => d.key === "no_media_evidence")!;
    expect(reviews.confidence).toBeLessThan(0.5);
    expect(reviews.explanation).toContain("gap in our research");
    expect(media.explanation).toContain("gap in our research");
    // Recorded evidence → neither fires.
    expect(keys(base())).not.toContain("no_review_evidence");
    expect(keys(base())).not.toContain("no_media_evidence");
  });

  it("every diagnosis carries a suggested action and results sort by confidence", () => {
    const results = deriveDiagnoses({
      ...base(),
      signalKinds: [],
      prompts: [prompt({})],
      assessments: { website_indexable: "no" },
    });
    expect(results.every((d) => d.suggestedAction.length > 10)).toBe(true);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1]!.confidence).toBeGreaterThanOrEqual(results[i]!.confidence);
    }
  });

  it("every diagnosis states at least one measured observation, apart from its inference (spec 086)", () => {
    const results = deriveDiagnoses({
      ...base(),
      signalKinds: [],
      prompts: [prompt({})],
      assessments: { website_indexable: "no", structured_data_consistent: "no" },
    });
    expect(results.length).toBeGreaterThan(0);
    for (const d of results) {
      expect(d.observations.length).toBeGreaterThan(0);
      expect(d.observations.every((o) => o.length > 0)).toBe(true);
      expect(d.explanation.length).toBeGreaterThan(0);
    }
  });
});
