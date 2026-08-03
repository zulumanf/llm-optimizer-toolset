/**
 * Known-answer tests for fixability (spec 039). Every expected number is
 * derived by hand from the rubric in lib/prospects/fixability.ts.
 */
import { describe, expect, it } from "vitest";
import {
  fixabilityProfile,
  type FixabilityInputs,
  type FixabilitySignal,
} from "@/lib/prospects/fixability";
import { weightedComposite } from "@/lib/scoring/weights";

let n = 0;
const signal = (over: Partial<FixabilitySignal>): FixabilitySignal => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  kind: "ranking",
  provenance: "verified",
  scope: "local",
  label: "a signal",
  sourceUrl: "https://example.com/x",
  ...over,
});

const empty = (): FixabilityInputs => ({
  authorityScore: null,
  visibilityScore: null,
  organicResponses: null,
  signals: [],
  citedDomains: null,
  rivalRecommendationRates: null,
  assessments: {},
  hasPrimaryContactWithEmail: false,
});

const category = (p: ReturnType<typeof fixabilityProfile>, key: string) =>
  p.categories.find((c) => c.key === key)!;

describe("fixabilityProfile categories", () => {
  it("with no data, only the decision-maker sub-item is measurable", () => {
    const p = fixabilityProfile(empty());
    // Five categories unmeasured; ability keeps its always-measurable
    // contact sub-item (measuredMax 2, points 0).
    expect(p.categories.filter((c) => !c.measured).map((c) => c.key)).toEqual([
      "existing_authority",
      "website_readiness",
      "evidence_availability",
      "third_party_opportunity",
      "competitive_difficulty",
    ]);
    expect(category(p, "ability_to_implement").measuredMax).toBe(2);
    expect(p.raw).toBe(0); // 0 of the 2 measurable points
    // confidence = 0.6×(2/100) + 0.4×1
    expect(p.confidence).toBeCloseTo(0.412, 10);
    expect(p.adjusted).toBe(0);
  });

  it("a fully verified, fully answered prospect reaches exactly 100 / 1.0 / 100", () => {
    const p = fixabilityProfile({
      authorityScore: 100,
      visibilityScore: 20,
      organicResponses: 12,
      signals: [
        signal({ kind: "transaction_volume" }),
        signal({ kind: "notable_sale" }),
        signal({ kind: "review_footprint" }),
        signal({ kind: "market_report" }),
        signal({ kind: "award" }),
      ],
      citedDomains: [
        { domain: "zillow.com", citations: 3 },
        { domain: "yelp.com", citations: 2 },
      ],
      rivalRecommendationRates: [0.2, 0.3],
      assessments: {
        website_indexable: "yes",
        has_dedicated_website: "yes",
        services_markets_clear: "yes",
        credentials_visible: "yes",
        neighborhood_content: "yes",
        structured_data_consistent: "yes",
        website_control: "yes",
        content_publishing_access: "yes",
        marketing_resources: "yes",
        can_obtain_reviews: "yes",
      },
      hasPrimaryContactWithEmail: true,
    });
    expect(category(p, "existing_authority").points).toBe(20);
    expect(category(p, "website_readiness").points).toBeCloseTo(20, 10);
    expect(category(p, "evidence_availability").points).toBe(15); // 5+3+3+2+2 verified
    expect(category(p, "third_party_opportunity").points).toBe(20); // all attainable
    expect(category(p, "competitive_difficulty").points).toBe(15); // no dominant rival
    expect(category(p, "ability_to_implement").points).toBe(10);
    expect(p.raw).toBeCloseTo(100, 10);
    expect(p.confidence).toBeCloseTo(1, 10);
    expect(p.adjusted).toBeCloseTo(100, 10);
    expect(p.flags).toEqual([]);
  });

  it("partially answered website items scale the measured ceiling, not the score", () => {
    const p = fixabilityProfile({
      ...empty(),
      assessments: { website_indexable: "yes", has_dedicated_website: "no" },
    });
    const web = category(p, "website_readiness");
    expect(web.points).toBeCloseTo(20 / 6, 10); // one yes
    expect(web.measuredMax).toBeCloseTo((2 * 20) / 6, 10); // two answered
    // raw = 100 × (20/6) / (40/6 + 2)
    expect(p.raw).toBeCloseTo((100 * (20 / 6)) / (40 / 6 + 2), 10);
    // confidence = 0.6 × ((40/6 + 2)/100) + 0.4 × 1
    expect(p.confidence).toBeCloseTo(0.6 * ((40 / 6 + 2) / 100) + 0.4, 10);
  });

  it("evidence availability requires source URLs and applies provenance factors", () => {
    const p = fixabilityProfile({
      ...empty(),
      signals: [
        signal({ kind: "transaction_volume", provenance: "estimated" }), // 5 × 0.4
        signal({ kind: "award", sourceUrl: null }), // URL-less: no points
      ],
    });
    expect(category(p, "evidence_availability").points).toBeCloseTo(2, 10);
    expect(category(p, "evidence_availability").measured).toBe(true);
  });

  it("unknown assessment answers are unanswered, not no", () => {
    const p = fixabilityProfile({
      ...empty(),
      assessments: { website_indexable: "unknown" },
    });
    expect(category(p, "website_readiness").measured).toBe(false);
  });
});

describe("fixability hard flags", () => {
  it("unverifiable_authority: signals without a credible sourced one", () => {
    const flagged = fixabilityProfile({
      ...empty(),
      signals: [signal({ provenance: "manual" })],
    });
    expect(flagged.flags.map((f) => f.flag)).toContain("unverifiable_authority");
    const ok = fixabilityProfile({ ...empty(), signals: [signal({})] });
    expect(ok.flags.map((f) => f.flag)).not.toContain("unverifiable_authority");
  });

  it("no_local_evidence: only global signals (or none)", () => {
    const flagged = fixabilityProfile({
      ...empty(),
      signals: [signal({ scope: "global" })],
    });
    expect(flagged.flags.map((f) => f.flag)).toContain("no_local_evidence");
    const ok = fixabilityProfile({ ...empty(), signals: [signal({})] });
    expect(ok.flags.map((f) => f.flag)).not.toContain("no_local_evidence");
  });

  it("already_dominant at visibility ≥ 70, not below", () => {
    const flagged = fixabilityProfile({ ...empty(), visibilityScore: 70 });
    expect(flagged.flags.map((f) => f.flag)).toContain("already_dominant");
    const ok = fixabilityProfile({ ...empty(), visibilityScore: 69.9 });
    expect(ok.flags.map((f) => f.flag)).not.toContain("already_dominant");
  });

  it("insufficient_sample below 6 organic responses; absent benchmark is not flagged", () => {
    const flagged = fixabilityProfile({ ...empty(), organicResponses: 5 });
    expect(flagged.flags.map((f) => f.flag)).toContain("insufficient_sample");
    expect(
      fixabilityProfile({ ...empty(), organicResponses: 6 }).flags.map((f) => f.flag)
    ).not.toContain("insufficient_sample");
    expect(fixabilityProfile(empty()).flags.map((f) => f.flag)).not.toContain(
      "insufficient_sample"
    );
  });

  it("restrictive_website_control only on an explicit no", () => {
    const flagged = fixabilityProfile({
      ...empty(),
      assessments: { website_control: "no" },
    });
    expect(flagged.flags.map((f) => f.flag)).toContain("restrictive_website_control");
    const unknown = fixabilityProfile({
      ...empty(),
      assessments: { website_control: "unknown" },
    });
    expect(unknown.flags.map((f) => f.flag)).not.toContain("restrictive_website_control");
  });

  it("unobtainable_sources when attainable citation share < 20%", () => {
    const flagged = fixabilityProfile({
      ...empty(),
      citedDomains: [
        { domain: "nytimes.com", citations: 9 },
        { domain: "zillow.com", citations: 1 },
      ],
    });
    expect(flagged.flags.map((f) => f.flag)).toContain("unobtainable_sources");
    const ok = fixabilityProfile({
      ...empty(),
      citedDomains: [
        { domain: "nytimes.com", citations: 1 },
        { domain: "zillow.com", citations: 1 },
      ],
    });
    expect(ok.flags.map((f) => f.flag)).not.toContain("unobtainable_sources");
  });

  it("reputation_concern flags AND recommends review; flags never null the score", () => {
    const p = fixabilityProfile({
      ...empty(),
      assessments: { reputation_concern: "yes" },
    });
    expect(p.flags.map((f) => f.flag)).toContain("reputation_concern");
    expect(p.needsReview).toBe(true);
    expect(p.raw).not.toBeNull(); // downgraded/explained, never deleted
  });
});

describe("weightedComposite", () => {
  const weights = { a: 0.5, b: 0.3, c: 0.2 };

  it("computes the plain weighted sum when everything is present", () => {
    const r = weightedComposite({ a: 100, b: 50, c: 0 }, weights);
    expect(r.score).toBeCloseTo(65, 10);
    expect(r.missing).toEqual([]);
  });

  it("redistributes a null component's weight proportionally", () => {
    const r = weightedComposite({ a: 100, b: null, c: 0 }, weights);
    // a: 0.5/0.7, c: 0.2/0.7
    expect(r.score).toBeCloseTo(100 * (0.5 / 0.7), 10);
    expect(r.missing).toEqual(["b"]);
  });

  it("is null — never zero — when nothing is measurable", () => {
    const r = weightedComposite({ a: null, b: null, c: null }, weights);
    expect(r.score).toBeNull();
    expect(r.missing).toEqual(["a", "b", "c"]);
  });
});
