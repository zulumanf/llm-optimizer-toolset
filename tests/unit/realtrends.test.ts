/**
 * RealTrends authority upgrade (2026-08-15) acceptance tests: ranking scope
 * can never widen, receipts travel with every signal, evidence classes stay
 * distinguishable, derived math is exact and never double-scored, volume is
 * never labeled commission, and the verified-underrepresentation archetype
 * boosts priority.
 */
import { describe, expect, it } from "vitest";
import {
  avgVolumePerSide,
  formatVerifiedProduction,
  realTrendsSignalDrafts,
  type RealTrendsRecord,
} from "@/lib/prospects/realtrends";
import { authorityProfile, type AuthoritySignalInput } from "@/lib/prospects/authority";
import {
  ARCHETYPE_BOOST,
  ARCHETYPE_VERIFIED_UNDERREPRESENTED,
  detectArchetype,
} from "@/lib/prospects/final-score";

const CITY_TEAMS: RealTrendsRecord = {
  entityType: "team",
  rank: 1,
  rankScope: "Jersey City, NJ — teams by closed volume",
  scopeComparable: true,
  city: "Jersey City",
  state: "NJ",
  brokerage: "SERHANT.",
  volumeUsd: 219_310_000,
  sides: 258,
  productionYear: null,
  publicationYear: null,
  sourceUrl:
    "https://www.realtrends.com/ranking/best-real-estate-agents-jersey-city-nj/teams-by-volume/",
  pageTitle: "Best Real Estate Agents Jersey City — Teams by Volume",
  capturedOn: "2026-08-15",
};

const CATEGORY_ONLY: RealTrendsRecord = {
  ...CITY_TEAMS,
  rank: 1,
  rankScope: "Jersey City, NJ — RealTrends team-size category (specific category unverified)",
  scopeComparable: false,
  brokerage: "Compass",
  volumeUsd: 36_150_000,
  sides: 27,
};

describe("ranking scope", () => {
  it("a category-specific #1 renders WITH its category scope, never as overall city #1", () => {
    const { headline } = formatVerifiedProduction({
      source: "RealTrends America's Best",
      rank: 1,
      rankScope: CATEGORY_ONLY.rankScope,
      scopeComparable: false,
      volumeUsd: CATEGORY_ONLY.volumeUsd,
      sides: CATEGORY_ONLY.sides,
      avgPerSideUsd: avgVolumePerSide(CATEGORY_ONLY.volumeUsd, CATEGORY_ONLY.sides),
      productionYear: null,
      sourceUrl: CATEGORY_ONLY.sourceUrl,
      retrievedOn: "2026-08-15",
    });
    expect(headline).toContain("team-size category");
    expect(headline).not.toMatch(/teams by closed volume/);
  });

  it("a rank never appears without its scope; rankless records still format", () => {
    const withRank = formatVerifiedProduction({
      source: "RealTrends America's Best",
      rank: 3,
      rankScope: "Jersey City, NJ — teams by closed volume",
      scopeComparable: true,
      volumeUsd: 60_210_000,
      sides: 85,
      avgPerSideUsd: avgVolumePerSide(60_210_000, 85),
      productionYear: null,
      sourceUrl: CITY_TEAMS.sourceUrl,
      retrievedOn: "2026-08-15",
    });
    expect(withRank.headline).toContain("#3 — Jersey City, NJ — teams by closed volume");
    const rankless = formatVerifiedProduction({
      source: "RealTrends America's Best",
      rank: null,
      rankScope: CATEGORY_ONLY.rankScope,
      scopeComparable: false,
      volumeUsd: 36_150_000,
      sides: 27,
      avgPerSideUsd: avgVolumePerSide(36_150_000, 27),
      productionYear: null,
      sourceUrl: CITY_TEAMS.sourceUrl,
      retrievedOn: "2026-08-15",
    });
    expect(rankless.headline).not.toContain("#");
  });

  it("a record without a scope is refused outright", () => {
    expect(() =>
      realTrendsSignalDrafts({ ...CITY_TEAMS, rankScope: "  " })
    ).toThrow(/scope/);
  });

  it("category records carry scope_comparable=false so rank math skips them", () => {
    const ranking = realTrendsSignalDrafts(CATEGORY_ONLY).find((d) => d.kind === "ranking");
    expect(ranking?.metadata["scope_comparable"]).toBe(false);
  });
});

describe("provenance and receipts", () => {
  it("every draft carries the source URL scope, capture date, and full record", () => {
    for (const draft of realTrendsSignalDrafts(CITY_TEAMS)) {
      expect(draft.metadata["rank_scope"]).toBe(CITY_TEAMS.rankScope);
      expect(draft.metadata["captured_on"]).toBe("2026-08-15");
      expect(draft.metadata["volume_usd"]).toBe(219_310_000);
      expect(draft.metadata["sides"]).toBe(258);
      expect(draft.metadata["brokerage"]).toBe("SERHANT.");
      expect(draft.metadata["record_type"]).toBe("realtrends_production");
    }
  });

  it("independent facts and derived arithmetic are classified apart", () => {
    const drafts = realTrendsSignalDrafts(CITY_TEAMS);
    const byKind = Object.fromEntries(drafts.map((d) => [d.kind, d.sourceType]));
    expect(byKind["ranking"]).toBe("independent");
    expect(byKind["transaction_volume"]).toBe("independent");
    expect(byKind["transaction_count"]).toBe("independent");
    expect(byKind["avg_deal_value"]).toBe("derived");
  });
});

describe("derived metrics", () => {
  it("average closed volume per side is exact", () => {
    expect(avgVolumePerSide(25_410_000, 20)).toBe(1_270_500);
    expect(avgVolumePerSide(219_310_000, 258)).toBe(850_039);
    expect(avgVolumePerSide(10, 0)).toBeNull();
    expect(avgVolumePerSide(0, 5)).toBeNull();
  });

  it("derived labels say closed volume per side, never average sale/home price", () => {
    const avg = realTrendsSignalDrafts(CITY_TEAMS).find((d) => d.kind === "avg_deal_value");
    expect(avg?.label).toContain("Average closed volume per side");
    expect(avg?.label).not.toMatch(/home price|average sale/i);
  });
});

describe("commission language", () => {
  it("no RealTrends label may mention commission — volume is not income", () => {
    for (const record of [CITY_TEAMS, CATEGORY_ONLY]) {
      for (const draft of realTrendsSignalDrafts(record)) {
        expect(draft.label).not.toMatch(/commission/i);
      }
    }
    const vp = formatVerifiedProduction({
      source: "RealTrends America's Best",
      rank: 1,
      rankScope: CITY_TEAMS.rankScope,
      scopeComparable: true,
      volumeUsd: CITY_TEAMS.volumeUsd,
      sides: CITY_TEAMS.sides,
      avgPerSideUsd: avgVolumePerSide(CITY_TEAMS.volumeUsd, CITY_TEAMS.sides),
      productionYear: null,
      sourceUrl: CITY_TEAMS.sourceUrl,
      retrievedOn: "2026-08-15",
    });
    expect(vp.headline + vp.detail).not.toMatch(/commission/i);
    expect(vp.detail).toContain("closed sales volume");
  });
});

describe("duplicate evidence and scoring", () => {
  const signal = (
    id: string,
    overrides: Partial<AuthoritySignalInput> = {}
  ): AuthoritySignalInput => ({
    id,
    kind: "transaction_volume",
    provenance: "verified",
    scope: "local",
    confidence: null,
    sourceType: "independent",
    ...overrides,
  });

  it("the same production fact ingested twice cannot inflate the score", () => {
    const once = authorityProfile([signal("a")]);
    const twice = authorityProfile([signal("a"), signal("b")]);
    expect(twice.score).toBe(once.score);
  });

  it("derived signals are excluded from scoring with a stated reason", () => {
    const withDerived = authorityProfile([
      signal("a"),
      signal("d", { kind: "avg_deal_value", sourceType: "derived" }),
    ]);
    const without = authorityProfile([signal("a")]);
    expect(withDerived.score).toBe(without.score);
    expect(withDerived.excluded.some((e) => e.signalId === "d")).toBe(true);
  });

  it("independently verified production outscores the same self-reported claim", () => {
    const independent = authorityProfile([signal("a", { provenance: "verified" })]);
    const selfReported = authorityProfile([
      signal("a", { provenance: "publicly_sourced", sourceType: "self_reported" }),
    ]);
    expect(independent.score!).toBeGreaterThan(selfReported.score!);
  });
});

describe("visibility-gap archetype", () => {
  const base = {
    hasIndependentProduction: true,
    prospectRecShare: 0,
    topRivalRate: 0.45,
    adjustedFixability: 40,
  };

  it("verified authority + near-zero recommendation share triggers the archetype", () => {
    expect(detectArchetype(base)).toBe(ARCHETYPE_VERIFIED_UNDERREPRESENTED);
    expect(ARCHETYPE_BOOST).toBeGreaterThan(1);
  });

  it("each leg is required: no independent proof, visible prospect, dead market, or unfixable → no boost", () => {
    expect(detectArchetype({ ...base, hasIndependentProduction: false })).toBeNull();
    expect(detectArchetype({ ...base, prospectRecShare: 0.2 })).toBeNull();
    expect(detectArchetype({ ...base, prospectRecShare: null })).toBeNull();
    expect(detectArchetype({ ...base, topRivalRate: 0.05 })).toBeNull();
    expect(detectArchetype({ ...base, adjustedFixability: 10 })).toBeNull();
  });
});
