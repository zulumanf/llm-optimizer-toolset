import { describe, expect, it } from "vitest";
import {
  canMoveOpportunity,
  dedupeDrafts,
  fromAccuracyFinding,
  fromCitationOpportunity,
  fromGapFinding,
  fromSiteFinding,
  APPROVAL,
} from "@/lib/optimization/opportunities";
import { buildStructuredData, STRUCTURED_DATA_KEYS } from "@/lib/optimization/jsonld";

const gap = (over: Partial<Parameters<typeof fromGapFinding>[0]> = {}) =>
  fromGapFinding(
    {
      id: "00000000-0000-4000-8000-000000000001",
      gapType: "recommendation",
      promptCategory: "recommendation",
      finding: "Mentioned in 30% of answers, recommended in none.",
      detail: {},
      opportunityScore: 72,
      confidence: 0.8,
      evidenceIds: [],
      ...over,
    },
    "Springfield"
  );

describe("opportunity normalization", () => {
  it("gives a run-independent dedupe key and maps the action, approvals and plan", () => {
    const a = gap();
    const b = gap({ id: "00000000-0000-4000-8000-000000000002" });
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(a.priorityBand).toBe("do_now");
    expect(a.approvalRequirements).toContain(APPROVAL.PUBLIC_CLAIM);
    expect(a.measurementPlan.primaryMetric).toBe("recommendation_rate");
    expect(a.targetLocation).toBe("Springfield");
    expect(a.limitations).toMatch(/not why/);
  });
  it("citation opportunities never claim influence", () => {
    const c = fromCitationOpportunity(
      { id: "c", domain: "Zillow.com", acvs: 64, acquisitionPath: "review_platform_profile", acquisitionDifficulty: "easy", estimatedCostUsd: null, nextAction: null },
      null
    );
    expect(c.dedupeKey).toBe("citation:zillow.com");
    expect(c.limitations).toMatch(/not influence/);
    expect(c.effort).toBe("low");
    expect(c.approvalRequirements).toEqual([APPROVAL.THIRD_PARTY_OUTREACH]);
  });
  it("site and accuracy findings keep their own evidence and clamp priority", () => {
    const s = fromSiteFinding({ id: "s", checkType: "ai_crawler_blocked", observation: "GPTBot blocked", recommendation: "Allow GPTBot", priorityScore: 140, pageUrl: null, severity: "critical" }, null);
    expect(s.priorityScore).toBe(100);
    expect(s.dedupeKey).toBe("site:ai_crawler_blocked:site");
    const a = fromAccuracyFinding({ id: "a", kind: "outdated", quote: "Founded in 1999", rationale: "Approved claim says 2005", severity: "high", confidence: 0.9, claimId: null, responseId: "r" }, null);
    expect(a.evidence.map((e) => e.kind)).toEqual(["accuracy_finding", "response"]);
    expect(a.dedupeKey).toMatch(/^accuracy:outdated:[0-9a-f]{12}$/);
  });
  it("dedupes to the highest-priority draft and sorts by priority", () => {
    const out = dedupeDrafts([gap({ opportunityScore: 40 }), gap({ opportunityScore: 80, id: "z" }), gap({ gapType: "citation", opportunityScore: 60 })]);
    expect(out).toHaveLength(2);
    expect(out[0]?.priorityScore).toBe(80);
  });
  it("lifecycle allows only forward moves, dismissal and reopening", () => {
    expect(canMoveOpportunity("proposed", "approved")).toBe(true);
    expect(canMoveOpportunity("proposed", "implemented")).toBe(false);
    expect(canMoveOpportunity("closed", "proposed")).toBe(false);
    expect(canMoveOpportunity("dismissed", "proposed")).toBe(true);
  });
});

describe("structured data from approved claims", () => {
  const claim = (key: string, value: unknown, id = key) => ({ id, key, canonicalText: typeof value === "string" ? value : "", value });
  it("emits only approved properties and reports what is missing", () => {
    const r = buildStructuredData("agent_business", [
      claim(STRUCTURED_DATA_KEYS.name, "Rivera Team"),
      claim(STRUCTURED_DATA_KEYS.locality, "Springfield"),
      claim(STRUCTURED_DATA_KEYS.sameAs, ["https://www.zillow.com/profile/rivera", "not a url"]),
    ]);
    expect(r.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "RealEstateAgent",
      name: "Rivera Team",
      address: { "@type": "PostalAddress", addressLocality: "Springfield" },
      sameAs: ["https://www.zillow.com/profile/rivera"],
    });
    expect(r.missingRecommended).toContain(STRUCTURED_DATA_KEYS.telephone);
    expect(r.rejected).toEqual([{ key: STRUCTURED_DATA_KEYS.sameAs, reason: "non-URL entries dropped" }]);
  });
  it("never emits ratings, reviews or invented fields", () => {
    const r = buildStructuredData("agent_business", [claim("business.rating", "5 stars"), claim("business.reviews", "120")]);
    expect(Object.keys(r.jsonLd).sort()).toEqual(["@context", "@type"]);
    expect(r.usedClaimIds).toEqual([]);
  });
  it("person template links the brokerage by name only", () => {
    const r = buildStructuredData("person", [claim(STRUCTURED_DATA_KEYS.personName, "Jane Rivera"), claim(STRUCTURED_DATA_KEYS.brokerage, "Compass")]);
    expect(r.jsonLd).toMatchObject({ "@type": "Person", name: "Jane Rivera", worksFor: { "@type": "RealEstateAgent", name: "Compass" } });
  });
});

describe("structured data reads vertical-pack keys as fallbacks", () => {
  it("uses markets_served and brokerage from the real-estate pack", () => {
    const r = buildStructuredData("person", [
      { id: "1", key: "person.name", canonicalText: "Jane Rivera", value: null },
      { id: "2", key: "brokerage", canonicalText: "Compass", value: null },
    ]);
    expect(r.jsonLd).toMatchObject({ worksFor: { name: "Compass" } });
    const b = buildStructuredData("agent_business", [{ id: "3", key: "markets_served", canonicalText: "Jersey City; Hoboken", value: null }]);
    expect(b.jsonLd.areaServed).toEqual(["Jersey City", "Hoboken"]);
  });
});
