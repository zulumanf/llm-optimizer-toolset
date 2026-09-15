/**
 * Spec 136 — evidence release verification. Property-level regression for
 * the Blu House failure, the 30-item matrix, the gold set, and the pure
 * verdict composition. No DB: the shadow recount and the verdict are pure.
 */
import { describe, expect, it } from "vitest";
import {
  composeReleaseVerdict,
  derivedClaimFigures,
  identityNamesFor,
  rawOccurrence,
  releaseGateDetail,
  shadowRecount,
  EVIDENCE_RELEASE_VERSION,
  RELEASE_CHECK_NAMES,
  type ProductionRecord,
  type ReleaseSideInput,
  type ReleaseVerdictInput,
  type ShadowCompany,
  type ShadowMention,
  type ShadowResponse,
} from "@/lib/prospects/evidence-release";
import type { EntityResolutionStatus, LeadAgentRelationship } from "@/lib/prospects/entity-aliases";
import { classifyEntityResolution } from "@/lib/prospects/entity-aliases";
import { PARSER_VERSION_LLM } from "@/lib/constants";
import { BLU, GOLD_CASES, GOLD_COMPANIES, JOSH } from "../fixtures/evidence-release-gold";

// ------------------------------------------------------------------ fixtures

const HARBOR = "h0000000-0000-4000-8000-000000000001";
const PA = "pa000000-0000-4000-8000-000000000001";
const PB = "pb000000-0000-4000-8000-000000000001";

const resp = (id: string, promptId: string, text: string | null, o: Partial<ShadowResponse> = {}): ShadowResponse => ({
  id, promptId, provider: "openai", error: false, promptText: "Who should I hire to sell a home in Grand Rapids?", responseText: text, ...o,
});
const men = (responseId: string, companyId: string, o: Partial<ShadowMention> = {}): ShadowMention => ({
  responseId, companyId, revision: 1, mentioned: true, recommended: true, needsReview: false, parserVersion: PARSER_VERSION_LLM, ...o,
});
const blu: ShadowCompany = { id: BLU, name: "Blu House Properties", aliases: ["Ryan John Ogle", "Ryan Ogle"], identityNames: ["Ryan John Ogle", "Ryan Ogle"] };
const harbor: ShadowCompany = { id: HARBOR, name: "Harbor View Group", aliases: ["Dana Harbor"], identityNames: ["Dana Harbor"] };

/** Four valid OpenAI answers: Blu credited once (r1), Harbor three times. */
const corpus = () => ({
  provider: "openai",
  holdoutPromptIds: new Set<string>(),
  companies: [blu, harbor],
  responses: [
    resp("r1", PA, "Ryan Ogle at Blu House Properties stands out; Harbor View Group is also strong."),
    resp("r2", PB, "Harbor View Group is the top pick."),
    resp("r3", PA, "Consider Harbor View Group or a boutique team."),
    resp("r4", PB, "Darla Ogle leads Ogle Luxury Group in Santa Rosa Beach."),
  ],
  mentions: [men("r1", BLU), men("r1", HARBOR), men("r2", HARBOR), men("r3", HARBOR)],
});

const verifiedEntity = (companyId: string, name: string, level: EntityResolutionStatus["level"]): EntityResolutionStatus => ({
  companyId, companyName: name, verified: true, level, reason: "team lead aliases applied",
});
const record = (id: string, o: Partial<ProductionRecord> = {}): ProductionRecord => ({
  id, source: "realtrends_records", entityType: "team", productionYear: 2025, volumeUsd: 81_103_589, sides: 120, ...o,
});

function baseInput(): ReleaseVerdictInput {
  const shadow = shadowRecount(corpus());
  const side = (role: "prospect" | "competitor", c: ShadowCompany, stated: number, lead: string, prod: ProductionRecord): ReleaseSideInput => ({
    role, companyId: c.id, name: c.name,
    stated: { recommendationCount: stated, productionSignalId: prod.id, productionYear: 2025, productionValue: prod.volumeUsd },
    entity: verifiedEntity(c.id, c.name, "team"),
    relationship: { leadName: lead, provenanced: true },
    identityNames: [c.name, ...c.aliases],
    production: prod,
    primaryCount: shadow.companies[c.id]!.recommended,
    shadow: shadow.companies[c.id]!,
  });
  return {
    snapshot: { runId: "run-1", provider: "openai", answerCount: 4, metricType: "closed_volume" },
    expectedProvider: "openai",
    knownParserVersions: [PARSER_VERSION_LLM],
    run: { found: true, status: "partial", completedAt: new Date("2026-08-31T11:13:56Z"), expectedCells: 4, validCells: 4, errorCells: 0, otherProviderCells: 4 },
    primaryDenominator: 4,
    shadowDenominator: shadow.denominator,
    correction: null,
    prospect: side("prospect", blu, 1, "Ryan John Ogle", record("rt-blu")),
    competitor: side("competitor", harbor, 3, "Dana Harbor", record("rt-harbor", { volumeUsd: 65_529_015 })),
    benchmarkMarket: { projectMarketId: "mkt-jc", launchMarketId: "mkt-jc", projectLabel: "Jersey City, NJ", launchLabel: "Jersey City, NJ" },
  };
}

const reasonsOf = (i: ReleaseVerdictInput) => composeReleaseVerdict(i).reasons;

describe("BENCHMARK_MARKET_VERIFIED (hardening 2026-09-14)", () => {
  it("a market-level project answering for a prospect from another market blocks; same market or per-prospect project passes", () => {
    const base = baseInput();
    expect(reasonsOf(base)).not.toContain("BENCHMARK_MARKET_MISMATCH");
    const nc = { ...base, benchmarkMarket: { projectMarketId: "mkt-wilmington-de", launchMarketId: "mkt-wilmington-nc", projectLabel: "Wilmington, DE", launchLabel: "Wilmington, NC" } };
    expect(reasonsOf(nc)).toContain("BENCHMARK_MARKET_MISMATCH");
    expect(composeReleaseVerdict(nc).verified).toBe(false);
    const noLaunch = { ...base, benchmarkMarket: { ...base.benchmarkMarket, launchMarketId: null } };
    expect(reasonsOf(noLaunch)).toContain("BENCHMARK_MARKET_MISMATCH");
    const perProspect = { ...base, benchmarkMarket: { projectMarketId: null, launchMarketId: "mkt-x", projectLabel: null, launchLabel: null } };
    expect(reasonsOf(perProspect)).not.toContain("BENCHMARK_MARKET_MISMATCH");
  });
});

// ------------------------------------------------- Blu House property test

describe("Blu House property — team lead recommendations credit the canonical team exactly once", () => {
  const rel: LeadAgentRelationship = {
    companyId: BLU, companyName: "Blu House Properties", existingAliases: [], entityType: "team", teamLead: "Ryan John Ogle",
    realtrendsRecordId: "rt-blu", productionYear: 2025, contactName: "Ryan Ogle", contactId: "ct-1",
  };
  const answers = [
    resp("a1", PA, "Blu House Properties is a great choice."),
    resp("a2", PA, "Ryan Ogle (EXP) stands out with 11 team sales."),
    resp("a3", PB, "Ryan Ogle at Blu House Properties … Ryan Ogle's team also covers Ada."),
    resp("a4", PB, "Darla Ogle leads Ogle Luxury Group."),
  ];
  it("verified lead alias contributes to the identity set with provenance", () => {
    const names = identityNamesFor({ name: "Blu House Properties", aliases: [] }, rel);
    expect(names).toEqual(expect.arrayContaining(["Blu House Properties", "Ryan John Ogle", "Ryan Ogle"]));
    expect(identityNamesFor({ name: "Blu House Properties", aliases: [] }, null)).toEqual(["Blu House Properties"]);
    expect(identityNamesFor({ name: "Blu House Properties", aliases: [] }, { ...rel, realtrendsRecordId: null, entityType: null })).toEqual(["Blu House Properties"]);
  });
  it("credits team-name-only, lead-name-only and both-in-one-answer once each; the same-surname stranger never", () => {
    const s = shadowRecount({
      provider: "openai", holdoutPromptIds: new Set(), companies: [blu],
      responses: answers, mentions: [men("a1", BLU), men("a2", BLU), men("a3", BLU)],
    });
    expect(s.companies[BLU]).toMatchObject({ recommended: 3, rawOccurrenceResponses: 3, coverageGaps: [] });
    expect(s.denominator).toBe(4);
  });
  it("FAILS CLOSED when the lead relationship is omitted from the identity set (the original bug cannot pass silently)", () => {
    // Registry state before spec 130: no alias, parser never saw "Ryan Ogle".
    const withoutLead: ShadowCompany = { ...blu, aliases: [], identityNames: [] };
    const blind = shadowRecount({ provider: "openai", holdoutPromptIds: new Set(), companies: [withoutLead], responses: answers, mentions: [men("a1", BLU)] });
    expect(blind.companies[BLU]!.recommended).toBe(1); // internally consistent…
    // …but the release check searches the licensed relationship's names regardless of registry aliases:
    const searched: ShadowCompany = { ...withoutLead, identityNames: identityNamesFor({ name: blu.name, aliases: [] }, rel) };
    const audited = shadowRecount({ provider: "openai", holdoutPromptIds: new Set(), companies: [searched], responses: answers, mentions: [men("a1", BLU)] });
    expect(audited.companies[BLU]!.coverageGaps.sort()).toEqual(["a2", "a3"]);
    const i = baseInput();
    i.prospect = { ...i.prospect, stated: { ...i.prospect.stated, recommendationCount: 1 }, primaryCount: 1, shadow: audited.companies[BLU]!,
      entity: classifyEntityResolution({ companyId: BLU, companyName: blu.name, prospectType: "team", rel, operatorVerified: null }) };
    const v = composeReleaseVerdict(i);
    expect(v.verified).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(["ALIAS_COVERAGE_UNVERIFIED", "PROSPECT_ENTITY_UNVERIFIED"]));
  });
  it("an ambiguous (single-token) lead fails closed as AMBIGUOUS_IDENTITY", () => {
    const i = baseInput();
    i.prospect.entity = classifyEntityResolution({ companyId: BLU, companyName: blu.name, prospectType: "team", rel: { ...rel, teamLead: "Ryan" }, operatorVerified: null });
    expect(reasonsOf(i)).toContain("AMBIGUOUS_IDENTITY");
  });
  it("relationship without licensed provenance is not verified", () => {
    const i = baseInput();
    i.prospect.relationship = { leadName: "Ryan John Ogle", provenanced: false };
    expect(reasonsOf(i)).toContain("RELATIONSHIP_UNVERIFIED");
  });
});

// ----------------------------------------------------------- gold set

describe("gold regression set", () => {
  for (const g of GOLD_CASES) {
    it(`${g.id}: ${g.description}`, () => {
      const company = GOLD_COMPANIES[g.companyId]!;
      const s = shadowRecount({
        provider: "openai", holdoutPromptIds: new Set(), companies: [company],
        responses: [resp("g", PA, g.response.responseText, { promptText: g.response.promptText })],
        mentions: g.mention ? [men("g", g.companyId, g.mention)] : [],
      });
      const r = s.companies[g.companyId]!;
      expect(rawOccurrence(g.response.responseText, company.identityNames.concat(company.name, company.aliases))).toBe(g.expected.occurrence);
      expect(r.recommended).toBe(g.expected.credit);
      expect(r.coverageGaps.length > 0).toBe(g.expected.coverageGap);
    });
  }
  it("is small and every case carries provenance", () => {
    expect(GOLD_CASES.length).toBeGreaterThanOrEqual(10);
    expect(GOLD_CASES.length).toBeLessThan(40);
    for (const g of GOLD_CASES) expect(g.provenance.length).toBeGreaterThan(10);
  });
});

// ------------------------------------------------------ regression matrix

describe("shadow recount — counting semantics (matrix 1–6, 8, 12–18)", () => {
  const run = (extraResponses: ShadowResponse[], extraMentions: ShadowMention[], o: Partial<ReturnType<typeof corpus>> = {}) =>
    shadowRecount({ ...corpus(), responses: [...corpus().responses, ...extraResponses], mentions: [...corpus().mentions, ...extraMentions], ...o });

  it("1. team name only → one credit", () => {
    expect(run([resp("x", PA, "Blu House Properties is excellent.")], [men("x", BLU)]).companies[BLU]!.recommended).toBe(2);
  });
  it("2. team lead name only → one credit through the verified alias; without a row it is a coverage gap", () => {
    expect(run([resp("x", PA, "Ryan Ogle is excellent.")], [men("x", BLU)]).companies[BLU]!.recommended).toBe(2);
    expect(run([resp("x", PA, "Ryan Ogle is excellent.")], []).companies[BLU]!.coverageGaps).toEqual(["x"]);
  });
  it("3/14. team + lead in one answer, and repeated alias mentions → exactly one credit", () => {
    const s = run([resp("x", PA, "Ryan Ogle of Blu House Properties; Ryan Ogle again; Blu House Properties again.")], [men("x", BLU)]);
    expect(s.companies[BLU]!.recommended).toBe(2);
  });
  it("4. unrelated same-surname agent never matches", () => {
    const s = shadowRecount(corpus());
    expect(s.companies[BLU]!.rawOccurrenceResponses).toBe(1);
    expect(s.companies[BLU]!.coverageGaps).toEqual([]);
  });
  it("5/6. verified nickname counts; unverified nickname is not matched or merged", () => {
    const caul: ShadowCompany = { id: "caul", name: "The Caul Group", aliases: ["Tina Caul"], identityNames: ["Matina F Caul", "Tina Caul"] };
    const yes = shadowRecount({ provider: "openai", holdoutPromptIds: new Set(), companies: [caul], responses: [resp("x", PA, "Tina Caul's team is great.")], mentions: [men("x", "caul")] });
    expect(yes.companies.caul!.recommended).toBe(1);
    const no = shadowRecount({ provider: "openai", holdoutPromptIds: new Set(), companies: [caul], responses: [resp("x", PA, "Teenie Caul is great.")], mentions: [] });
    expect(no.companies.caul).toMatchObject({ recommended: 0, rawOccurrenceResponses: 0, coverageGaps: [] });
  });
  it("8/12. brokerage mention and mere mention are not recommendations", () => {
    const compass: ShadowCompany = { id: "cmp", name: "Compass", aliases: [], identityNames: [] };
    const s = shadowRecount({ provider: "openai", holdoutPromptIds: new Set(), companies: [compass, blu],
      responses: [resp("x", PA, "Ryan Ogle (Compass) is listed among many.")],
      mentions: [men("x", "cmp", { recommended: false }), men("x", BLU, { recommended: false })] });
    expect(s.companies.cmp!.recommended).toBe(0);
    expect(s.companies[BLU]!.recommended).toBe(0);
    expect(s.companies[BLU]!.coverageGaps).toEqual([]);
  });
  it("13. prompt echo is excluded from the numerator (whole-word rule)", () => {
    const s = run([resp("x", PA, "Yes, Blu House Properties.", { promptText: "Is Blu House Properties any good?" })], [men("x", BLU)]);
    expect(s.companies[BLU]!.recommended).toBe(1);
    expect(s.companies[BLU]!.echoExcluded).toBe(1);
    const inside = run([resp("y", PA, "Compass is good.", { promptText: "encompassing question about Compass" })], []);
    expect(inside.denominator).toBe(5);
  });
  it("15. only the current revision counts", () => {
    const flipped = run([resp("x", PA, "Blu House Properties!")], [men("x", BLU, { revision: 1 }), men("x", BLU, { revision: 2, recommended: false })]);
    expect(flipped.companies[BLU]!.recommended).toBe(1);
    const restored = run([resp("x", PA, "Blu House Properties!")], [men("x", BLU, { revision: 1, recommended: false }), men("x", BLU, { revision: 3 })]);
    expect(restored.companies[BLU]!.recommended).toBe(2);
  });
  it("16. errored cells are excluded from denominator and numerator", () => {
    const s = run([resp("x", PA, null, { error: true })], [men("x", BLU)]);
    expect(s.denominator).toBe(4);
    expect(s.excluded.errors).toBe(1);
    expect(s.companies[BLU]!.recommended).toBe(1);
  });
  it("17. holdout prompts are excluded (canonical methodology)", () => {
    const s = run([], [], { holdoutPromptIds: new Set([PB]) });
    expect(s.denominator).toBe(2);
    expect(s.excluded.holdout).toBe(2);
    expect(s.companies[HARBOR]!.recommended).toBe(2);
  });
  it("18. other providers never enter numerator or denominator", () => {
    const s = run([resp("x", PA, "Blu House Properties!", { provider: "perplexity" })], [men("x", BLU)]);
    expect(s.denominator).toBe(4);
    expect(s.excluded.otherProvider).toBe(1);
    expect(s.companies[BLU]!.recommended).toBe(1);
  });
  it("distinct questions are counted per prompt, not per answer", () => {
    expect(shadowRecount(corpus()).companies[HARBOR]).toMatchObject({ recommended: 3, distinctQuestions: 2 });
  });
});

describe("release verdict — fail-closed composition (matrix 7, 9–11, 19–30)", () => {
  it("20. a fully verified claim passes every named check, in the required order", () => {
    const v = composeReleaseVerdict(baseInput());
    expect(v.verified).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.checks.map((c) => c.name)).toEqual([...RELEASE_CHECK_NAMES]);
    expect(v.version).toBe(EVIDENCE_RELEASE_VERSION);
    expect(releaseGateDetail(v)).toMatch(/^EVIDENCE_RELEASE_VERIFIED/);
    expect(releaseGateDetail(v)).toContain('"primary":{"prospect":1,"competitor":3,"denominator":4}');
  });
  it("7. individual vs individual is comparable; 24. team production vs individual production is not", () => {
    const i = baseInput();
    i.prospect.entity = verifiedEntity(BLU, "Ryan Ogle", "individual");
    i.competitor.entity = verifiedEntity(HARBOR, "Dana Harbor", "individual");
    i.prospect.production = record("rt-blu", { entityType: "individual" });
    i.competitor.production = record("rt-harbor", { entityType: "individual", volumeUsd: 65_529_015 });
    expect(reasonsOf(i)).toEqual([]);
    i.competitor.production = record("rt-harbor", { entityType: "team", volumeUsd: 65_529_015 });
    expect(reasonsOf(i)).toContain("ENTITY_LEVEL_MISMATCH");
  });
  it("9. office/brokerage without an operator record is unverified; levels are never conflated", () => {
    const i = baseInput();
    i.competitor.entity = classifyEntityResolution({ companyId: HARBOR, companyName: "Harbor View", prospectType: "brokerage", rel: null, operatorVerified: null });
    const r = reasonsOf(i);
    expect(r).toContain("COMPETITOR_ENTITY_UNVERIFIED");
    expect(r).toContain("ENTITY_LEVEL_MISMATCH");
  });
  it("10. zero with no raw occurrences is a verified zero", () => {
    const i = baseInput();
    const s = shadowRecount({ ...corpus(), mentions: corpus().mentions.filter((m) => m.companyId !== BLU), responses: corpus().responses.filter((r) => r.id !== "r1") });
    i.prospect = { ...i.prospect, stated: { ...i.prospect.stated, recommendationCount: 0 }, primaryCount: 0, shadow: s.companies[BLU]! };
    i.competitor = { ...i.competitor, primaryCount: 2, stated: { ...i.competitor.stated, recommendationCount: 2 }, shadow: s.companies[HARBOR]! };
    i.snapshot.answerCount = 3; i.primaryDenominator = 3; i.shadowDenominator = 3; i.run.validCells = 3; i.run.expectedCells = 3;
    const v = composeReleaseVerdict(i);
    expect(v.verified).toBe(true);
    expect(v.checks.find((c) => c.name === "ZERO_COUNT_VERIFIED")?.detail).toMatch(/0 raw occurrences, 0 unreconciled/);
  });
  it("11. zero with a raw verified-alias occurrence and no row is ZERO_NOT_VERIFIED", () => {
    const i = baseInput();
    const s = shadowRecount({ ...corpus(), mentions: corpus().mentions.filter((m) => m.companyId !== BLU) });
    i.prospect = { ...i.prospect, stated: { ...i.prospect.stated, recommendationCount: 0 }, primaryCount: 0, shadow: s.companies[BLU]! };
    const r = reasonsOf(i);
    expect(r).toContain("ZERO_NOT_VERIFIED");
    expect(r).toContain("ALIAS_COVERAGE_UNVERIFIED");
  });
  it("19. denominator is recomputed: stated ≠ shadow or primary ≠ shadow fails", () => {
    const a = baseInput(); a.snapshot.answerCount = 256;
    expect(reasonsOf(a)).toContain("DENOMINATOR_MISMATCH");
    const b = baseInput(); b.primaryDenominator = 5;
    expect(reasonsOf(b)).toContain("DENOMINATOR_MISMATCH");
    const c = baseInput(); c.shadowDenominator = null;
    expect(reasonsOf(c)).toContain("DENOMINATOR_MISMATCH");
  });
  it("21. primary/shadow disagreement fails closed — neither value is chosen", () => {
    const i = baseInput();
    i.competitor.primaryCount = 4;
    i.competitor.stated.recommendationCount = 4;
    const v = composeReleaseVerdict(i);
    expect(v.verified).toBe(false);
    expect(v.reasons).toEqual(["PRIMARY_SHADOW_COUNT_MISMATCH"]);
    expect(v.diagnostics.primary.competitor).toBe(4);
    expect(v.diagnostics.shadow.competitor).toBe(3);
    expect(releaseGateDetail(v)).toContain("primary 4, shadow 3");
  });
  it("stated count that the primary no longer reproduces fails (STATED_COUNT_MISMATCH)", () => {
    const i = baseInput();
    i.prospect.stated.recommendationCount = 2;
    expect(reasonsOf(i)).toEqual(["STATED_COUNT_MISMATCH"]);
    i.prospect.stated.recommendationCount = 11; // above the denominator: semantics bound trips too
    expect(reasonsOf(i)).toEqual(["STATED_COUNT_MISMATCH", "RECOMMENDATION_SEMANTICS_UNVERIFIED"]);
  });
  it("22/23. production period, metric and value mismatches fail; nothing is normalized", () => {
    const y = baseInput(); y.competitor.production = record("rt-harbor", { productionYear: 2024, volumeUsd: 65_529_015 });
    expect(reasonsOf(y)).toContain("PRODUCTION_PERIOD_MISMATCH");
    const m = baseInput(); m.snapshot.metricType = "sides";
    expect(reasonsOf(m)).toEqual(expect.arrayContaining(["PRODUCTION_METRIC_MISMATCH"]));
    const v = baseInput(); v.prospect.stated.productionValue = 81_000_000;
    expect(reasonsOf(v)).toContain("PRODUCTION_VALUE_MISMATCH");
    const missing = baseInput(); missing.competitor.production = null;
    expect(reasonsOf(missing)).toContain("PRODUCTION_RECORD_UNVERIFIED");
  });
  it("25/27. a correction in force that states other counts blocks release; the corrected claim passes", () => {
    const i = baseInput();
    i.correction = { id: "corr-1", correctedAt: new Date("2026-09-06T00:00:00Z"), prospectCount: 3, competitorCount: 3 };
    expect(reasonsOf(i)).toContain("PENDING_CORRECTION");
    i.correction = { id: "corr-1", correctedAt: new Date("2026-09-06T00:00:00Z"), prospectCount: 1, competitorCount: 3 };
    expect(reasonsOf(i)).toEqual([]);
  });
  it("26. verification never mutates its input (frozen snapshot stays frozen)", () => {
    const i = baseInput();
    const before = JSON.stringify(i);
    composeReleaseVerdict(Object.freeze(i));
    expect(JSON.stringify(i)).toBe(before);
  });
  it("28. run completeness follows the canonical policy: partial status with every claimed-provider cell valid passes; a missing cell blocks", () => {
    const ok = baseInput(); ok.run.status = "partial";
    expect(reasonsOf(ok)).toEqual([]);
    const missing = baseInput(); missing.run = { ...missing.run, expectedCells: 256, validCells: 255, errorCells: 1 };
    expect(reasonsOf(missing)).toContain("BENCHMARK_INCOMPLETE");
    const running = baseInput(); running.run.status = "running";
    expect(reasonsOf(running)).toContain("BENCHMARK_INCOMPLETE");
    const gone = baseInput(); gone.run = { found: false, status: null, completedAt: null, expectedCells: 0, validCells: 0, errorCells: 0, otherProviderCells: 0 };
    gone.primaryDenominator = null; gone.shadowDenominator = null; gone.prospect.primaryCount = null; gone.competitor.primaryCount = null;
    expect(reasonsOf(gone)).toEqual(expect.arrayContaining(["FROZEN_RUN_MISSING", "PROVIDER_MISMATCH", "BENCHMARK_INCOMPLETE", "DENOMINATOR_MISMATCH", "STATED_COUNT_MISMATCH"]));
  });
  it("18. provider mixing: a claim on a provider other than the campaign's fails PROVIDER_MISMATCH", () => {
    const i = baseInput(); i.snapshot.provider = "perplexity";
    expect(reasonsOf(i)).toContain("PROVIDER_MISMATCH");
  });
  it("29. the competitor receives the same rigor as the prospect", () => {
    const e = baseInput(); e.competitor.entity = { ...e.competitor.entity!, verified: false, reason: "no authoritative identity record" };
    expect(reasonsOf(e)).toContain("COMPETITOR_ENTITY_UNVERIFIED");
    const g = baseInput(); g.competitor.shadow = { ...g.competitor.shadow!, coverageGaps: ["r9"] };
    expect(reasonsOf(g)).toContain("ALIAS_COVERAGE_UNVERIFIED");
    const z = baseInput(); z.competitor.identityNames = [];
    expect(reasonsOf(z)).toContain("ALIAS_COVERAGE_UNVERIFIED");
  });
  it("30. recommendation semantics: unknown parser version, recommended-without-mention, or count > denominator fail", () => {
    const a = baseInput(); a.prospect.shadow = { ...a.prospect.shadow!, parserVersions: ["mention-parser-v9"] };
    expect(reasonsOf(a)).toContain("RECOMMENDATION_SEMANTICS_UNVERIFIED");
    const b = baseInput(); b.prospect.shadow = { ...b.prospect.shadow!, recommendedWithoutMentioned: 1 };
    expect(reasonsOf(b)).toContain("RECOMMENDATION_SEMANTICS_UNVERIFIED");
  });
  it("unresolved human-review rows block release", () => {
    const i = baseInput(); i.competitor.shadow = { ...i.competitor.shadow!, unresolvedReview: 2 };
    expect(reasonsOf(i)).toEqual(["UNRESOLVED_EVIDENCE_ISSUE"]);
  });
  it("reasons are deterministic codes, never a collapsed QA_FAILED", () => {
    const i = baseInput();
    i.prospect.entity = null; i.competitor.production = null; i.run.validCells = 3;
    const v = composeReleaseVerdict(i);
    expect(v.reasons).toEqual(["PROSPECT_ENTITY_UNVERIFIED", "ENTITY_LEVEL_MISMATCH", "PRODUCTION_RECORD_UNVERIFIED", "BENCHMARK_INCOMPLETE"]);
    expect(releaseGateDetail(v)).toMatch(/^EVIDENCE_RELEASE_BLOCKED: PROSPECT_ENTITY_UNVERIFIED, ENTITY_LEVEL_MISMATCH/);
  });
});

describe("derived claim figures are deterministic code, never LLM arithmetic", () => {
  it("ratio %, multiple and gap", () => {
    const f = derivedClaimFigures({
      prospect: { recommendationCount: 2, productionValue: 56.9 } as never,
      competitor: { recommendationCount: 25, productionValue: 24.9 } as never,
    });
    expect(f).toEqual({ productionRatioPct: 43.76, recommendationMultiple: 12.5, absoluteGap: 23 });
    expect(derivedClaimFigures({ prospect: { recommendationCount: 0, productionValue: 0 } as never, competitor: { recommendationCount: 4, productionValue: 1 } as never }))
      .toEqual({ productionRatioPct: null, recommendationMultiple: null, absoluteGap: 4 });
  });
});

describe("raw occurrence rule mirrors the parser boundary", () => {
  it("whole-word, case-insensitive, not inside domains", () => {
    expect(rawOccurrence("call ryan ogle today", ["Ryan Ogle"])).toBe(true);
    expect(rawOccurrence("see ryanogle.com", ["Ryan Ogle"])).toBe(false);
    expect(rawOccurrence("Josh Mayer is great", ["Josh May"])).toBe(false);
    expect(rawOccurrence(null, ["Josh May"])).toBe(false);
    expect(rawOccurrence("Josh May.", ["Josh May"])).toBe(true);
    expect(rawOccurrence("Josh May (RE/MAX)", ["RE/MAX (NJ)"])).toBe(false);
  });
  it("Josh May fixture from the incident: named but not recommended is not credited", () => {
    const s = shadowRecount({ provider: "openai", holdoutPromptIds: new Set(), companies: [GOLD_COMPANIES[JOSH]!],
      responses: [resp("x", PA, "Josh May (RE/MAX of Grand Rapids) also shows multiple sales.")], mentions: [men("x", JOSH, { recommended: false })] });
    expect(s.companies[JOSH]).toMatchObject({ recommended: 0, rawOccurrenceResponses: 1, coverageGaps: [] });
  });
});
