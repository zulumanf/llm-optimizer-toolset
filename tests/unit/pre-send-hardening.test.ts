/**
 * Spec 150 — pre-send outreach hardening (pure layer): finding-specific
 * freshness, valid-evidence provider attribution, deterministic copy,
 * entity wording, postal-address completeness, audit-expiry policy.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateFindingEvidence,
  unsupportedProviderMentions,
  type FindingEvidenceRow,
} from "@/lib/prospects/finding-evidence";
import {
  entityPluralNoun,
  entityTypeFromProspectType,
  findingOutreachObservation,
  generateReplyFirstEmail,
  providerModelPhrase,
} from "@/lib/prospects/outreach";
import {
  AUDIT_PROSE_LEAKS,
  lintEntityWording,
  lintOutreachLeakage,
  qaDraftContent,
  type DraftQaInput,
} from "@/lib/prospects/draft-qa";
import { isCompletePostalAddress } from "@/lib/outreach/sender-identity";

const NOW = new Date("2026-10-03T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const P = "00000000-0000-4000-8000-0000000000a1";
const row = (over: Partial<FindingEvidenceRow> = {}): FindingEvidenceRow => ({
  findingId: "f1",
  findingProspectId: P,
  findingStatus: "approved",
  benchmarkId: "b1",
  benchmarkProspectId: P,
  runId: "r1",
  runStatus: "completed",
  runCompletedAt: daysAgo(5),
  ...over,
});
const OPENAI_ONLY = [{ provider: "openai", validAnswers: 64 }, { provider: "perplexity", validAnswers: 0 }];

describe("finding-specific freshness", () => {
  it("a finding from a 5-day-old run passes", () => {
    const v = evaluateFindingEvidence(P, row(), OPENAI_ONLY, NOW);
    expect(v.ok).toBe(true);
  });

  it("a finding from a 49-day-old run fails — its own run decides", () => {
    const v = evaluateFindingEvidence(P, row({ runCompletedAt: daysAgo(49.7) }), OPENAI_ONLY, NOW);
    expect(v).toMatchObject({ ok: false, code: "RUN_STALE" });
    if (!v.ok) expect(v.detail).toMatch(/A newer benchmark does not refresh it/);
  });

  it("fails closed on every broken link in the chain", () => {
    expect(evaluateFindingEvidence(P, null, OPENAI_ONLY, NOW)).toMatchObject({ ok: false, code: "FINDING_NOT_FOUND" });
    expect(evaluateFindingEvidence(P, row({ findingProspectId: "other" }), OPENAI_ONLY, NOW)).toMatchObject({ code: "FINDING_FOREIGN" });
    expect(evaluateFindingEvidence(P, row({ findingStatus: "rejected" }), OPENAI_ONLY, NOW)).toMatchObject({ code: "FINDING_NOT_APPROVED" });
    expect(evaluateFindingEvidence(P, row({ benchmarkId: null }), OPENAI_ONLY, NOW)).toMatchObject({ code: "BENCHMARK_MISSING" });
    expect(evaluateFindingEvidence(P, row({ benchmarkProspectId: "other" }), OPENAI_ONLY, NOW)).toMatchObject({ code: "BENCHMARK_FOREIGN" });
    expect(evaluateFindingEvidence(P, row({ runId: null }), OPENAI_ONLY, NOW)).toMatchObject({ code: "RUN_MISSING" });
    expect(evaluateFindingEvidence(P, row({ runStatus: "running" }), OPENAI_ONLY, NOW)).toMatchObject({ code: "RUN_NOT_FINISHED" });
    expect(evaluateFindingEvidence(P, row({ runCompletedAt: null }), OPENAI_ONLY, NOW)).toMatchObject({ code: "RUN_TIMESTAMP_MISSING" });
  });

  it("a partial run is finished; the 14-day boundary is inclusive", () => {
    expect(evaluateFindingEvidence(P, row({ runStatus: "partial", runCompletedAt: daysAgo(14) }), OPENAI_ONLY, NOW).ok).toBe(true);
    expect(evaluateFindingEvidence(P, row({ runCompletedAt: daysAgo(14.01) }), OPENAI_ONLY, NOW).ok).toBe(false);
  });
});

describe("provider attribution from valid evidence only", () => {
  it("a configured provider with zero valid answers is excluded", () => {
    const v = evaluateFindingEvidence(P, row(), OPENAI_ONLY, NOW);
    expect(v.ok && v.evidence.validProviders).toEqual(["openai"]);
    expect(v.ok && v.evidence.providerNames).toEqual(["OpenAI"]);
  });

  it("no valid evidence (or only unknown providers) fails closed", () => {
    expect(evaluateFindingEvidence(P, row(), [{ provider: "perplexity", validAnswers: 0 }], NOW)).toMatchObject({ code: "NO_VALID_PROVIDER_EVIDENCE" });
    expect(evaluateFindingEvidence(P, row(), [{ provider: "acme_llm", validAnswers: 9 }], NOW)).toMatchObject({ code: "NO_VALID_PROVIDER_EVIDENCE" });
  });

  it("flags a body naming a provider without evidence; consumer counterpart of a valid provider is fine", () => {
    expect(unsupportedProviderMentions("ran in OpenAI and Perplexity", ["openai"])).toEqual(["Perplexity"]);
    expect(unsupportedProviderMentions("the OpenAI model behind ChatGPT", ["openai"])).toEqual([]);
    expect(unsupportedProviderMentions("the OpenAI model behind ChatGPT", ["perplexity"])).toEqual(["OpenAI", "ChatGPT"]);
  });

  it("one-provider evidence produces one-provider wording; display names, never ids", () => {
    expect(providerModelPhrase(["OpenAI"])).toBe("an OpenAI model");
    expect(providerModelPhrase(["Perplexity"])).toBe("a Perplexity model");
    expect(providerModelPhrase(["OpenAI", "Perplexity"])).toBe("models from OpenAI and Perplexity");
  });
});

describe("deterministic outreach observation (never audit prose)", () => {
  const base = { prospectName: "Leilani Chin", competitorNames: [], anchorSignalLabel: null };

  it("authority_visibility_gap uses the signal label and counts, without the page's framing sentence", () => {
    const o = findingOutreachObservation({
      ...base,
      kind: "authority_visibility_gap",
      metrics: { sample_size: 64, recommendation_rate: 0.140625, verified_signals: 3 },
      anchorSignalLabel: "RealTrends America's Best: #11 — Jersey City, NJ — individuals by closed volume ($12.34M closed sales volume)",
    });
    expect(o.ok && o.sentence).toBe(
      "Leilani Chin has a documented record (RealTrends America's Best: #11 — Jersey City, NJ — individuals by closed volume ($12.34M closed sales volume)), yet was recommended in 9 of 64 answers."
    );
    for (const leak of AUDIT_PROSE_LEAKS) expect(o.ok && o.sentence).not.toContain(leak);
  });

  it("competitor_contrast names the competitor from its id list; accepts camelCased metric keys", () => {
    const o = findingOutreachObservation({
      ...base,
      prospectName: "Brett Sikora",
      kind: "competitor_contrast",
      metrics: { sampleSize: 64, prospectRecommendationRate: 0.140625, competitorRecommendationRate: 0.421875 },
      competitorNames: ["The Jill Biggs Group"],
    });
    expect(o.ok && o.sentence).toBe("The Jill Biggs Group was recommended in 27 of 64 answers; Brett Sikora was recommended in 9 of 64.");
  });

  it("absence and citation_gap render; missing data or unknown kinds fail closed", () => {
    expect(findingOutreachObservation({ ...base, kind: "absence", metrics: { sample_size: 64, mention_rate: 0 } })).toMatchObject({ ok: true });
    expect(findingOutreachObservation({ ...base, kind: "citation_gap", metrics: { sample_size: 64 }, competitorNames: ["A", "B"] })).toMatchObject({ ok: true });
    expect(findingOutreachObservation({ ...base, kind: "competitor_contrast", metrics: { sample_size: 64, prospect_recommendation_rate: 0.1, competitor_recommendation_rate: 0.4 } }).ok).toBe(false);
    expect(findingOutreachObservation({ ...base, kind: "authority_visibility_gap", metrics: { sample_size: 64, recommendation_rate: 0.1 } }).ok).toBe(false);
    expect(findingOutreachObservation({ ...base, kind: "absence", metrics: {} }).ok).toBe(false);
    expect(findingOutreachObservation({ ...base, kind: "brand_new_kind", metrics: { sample_size: 64 } }).ok).toBe(false);
  });
});

describe("entity-type wording", () => {
  const draft = (prospectType: string) =>
    generateReplyFirstEmail({
      prospectName: "Leilani Chin",
      teamLeader: "Leilani Chin",
      marketName: "Jersey City",
      prospectType,
      providerNames: ["OpenAI"],
      observation: "Leilani Chin was mentioned in 9 of 64 answers.",
      sampleSize: 64,
      auditUrl: null,
    });

  it("an individual agent is never one of several teams", () => {
    const d = draft("individual_agent");
    expect(d.body).toContain("recommend Jersey City agents");
    expect(d.body).not.toMatch(/\bteams?\b/);
    expect(lintEntityWording(d.body, "individual_agent")).toEqual([]);
  });

  it("team wording stays correct; unknown types never guess", () => {
    expect(draft("team").body).toContain("recommend Jersey City teams");
    expect(entityPluralNoun("brokerage")).toBe("brokerages");
    expect(entityPluralNoun("developer")).toBe("real estate firms");
    expect(entityTypeFromProspectType("individual_agent")).toBe("individual");
    expect(entityTypeFromProspectType("team")).toBe("team");
    expect(entityTypeFromProspectType("brokerage")).toBeNull();
  });

  it("the linter refuses the observed defect and the mirror case", () => {
    expect(lintEntityWording("I was benchmarking several leading Jersey City teams across", "individual_agent")).toHaveLength(1);
    expect(lintEntityWording("recommended them more often than your team", "individual_agent")).toHaveLength(1);
    expect(lintEntityWording("Your team: $73.6M closed", "team")).toEqual([]);
    expect(lintEntityWording("You: $12.3M closed", "team")).toHaveLength(1);
  });

  it("the generated reply-first body carries no raw ids, audit prose or placeholders", () => {
    const d = draft("individual_agent");
    expect(lintOutreachLeakage(d.subject, d.body)).toEqual([]);
    expect(d.body).toContain("using an OpenAI model (64 monitored answers)");
  });
});

describe("copy leakage linter", () => {
  it("refuses the two production defects verbatim", () => {
    const p2 = "I was benchmarking several leading Jersey City teams across buyer and seller questions in openai and perplexity (64 monitored responses).\n\nSeparately, across 64 monitored responses, X was recommended in 9 of 64. Both measurements are shown with their sources; the contrast is the observation.";
    const checks = lintOutreachLeakage("subject", p2).map((i) => i.check);
    expect(checks.filter((c) => c === "copy_leakage").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses placeholders and internal labels, but not URLs or email addresses with underscores", () => {
    expect(lintOutreachLeakage("s", "Hi {prospect_reference},").map((i) => i.check)).toContain("artifacts");
    expect(lintOutreachLeakage("s", "rate recommendation_rate was 0.1").map((i) => i.check)).toContain("copy_leakage");
    expect(lintOutreachLeakage("s", 'metrics {"sampleSize": 64}').map((i) => i.check)).toContain("copy_leakage");
    expect(lintOutreachLeakage("s", "See https://app.example.com/audit/brett_sikora/k_1 or mail ana_r@x.com")).toEqual([]);
  });
});

describe("postal-address hard gate", () => {
  it("city/state-only, state-only, empty and missing fail", () => {
    for (const a of ["Brooklyn, NY", "NY", "", "   ", null, undefined, "Brooklyn, NY 11201"]) {
      expect(isCompletePostalAddress(a)).toBe(false);
    }
  });

  it("a complete street address or PO Box passes", () => {
    expect(isCompletePostalAddress("123 Grand St, Jersey City, NJ 07302")).toBe(true);
    expect(isCompletePostalAddress("PO Box 123, Brooklyn, NY 11201")).toBe(true);
    expect(isCompletePostalAddress("1399 Myrtle Ave\nBrooklyn, NY 11237")).toBe(true);
  });

  const qaBase = (over: Partial<DraftQaInput> = {}): DraftQaInput => ({
    subject: "A Jersey City benchmark result",
    body: "Hi Ana,\n\nBody.\n\n—\nDana · AVOS\nwww.RecommendedFirst.com\nBrooklyn, NY\nIf you'd rather not hear from us, reply \"unsubscribe\".",
    contactName: "Ana Rivera",
    contactEmail: "ana@example.com",
    teamLeader: "Ana Rivera",
    brokerageAffiliation: null,
    audit: null,
    senderReplyTo: null,
    senderPostalAddress: "Brooklyn, NY",
    ...over,
  });

  it("draft QA refuses an incomplete configured address even when the body carries it", () => {
    expect(qaDraftContent(qaBase()).map((i) => i.check)).toContain("sender_postal_address");
    expect(qaDraftContent(qaBase({ senderPostalAddress: null })).map((i) => i.check)).toContain("sender_postal_address");
  });
});

describe("audit-expiry policy (existing, now pinned)", () => {
  const url = "https://app.example.com/audit/ana/k1";
  const withLink = (audit: DraftQaInput["audit"]): DraftQaInput => ({
    subject: "A Jersey City benchmark result",
    body: `Hi Ana,\n\nThe full benchmark is here: ${url}\n\n—\nDana\nwww.RecommendedFirst.com\n123 Grand St, Jersey City, NJ 07302\nreply "unsubscribe".`,
    contactName: "Ana Rivera",
    contactEmail: "ana@example.com",
    teamLeader: "Ana Rivera",
    brokerageAffiliation: null,
    audit,
    senderReplyTo: null,
    senderPostalAddress: "123 Grand St, Jersey City, NJ 07302",
  });

  it("an audit expiring within 7 days, or already expired, refuses", () => {
    const soon = qaDraftContent(withLink({ sampleSize: null, preparedByEmail: null, expiresAt: new Date(Date.now() + 86_400_000), validUrls: [url] }));
    expect(soon.map((i) => i.check)).toContain("audit_link");
    const gone = qaDraftContent(withLink({ sampleSize: null, preparedByEmail: null, expiresAt: new Date(Date.now() - 3_600_000), validUrls: [url] }));
    expect(gone.map((i) => i.check)).toContain("audit_link");
  });

  it("a link to an audit that is no longer published refuses", () => {
    expect(qaDraftContent(withLink(null)).map((i) => i.check)).toContain("audit_link");
  });

  it("a live audit more than 7 days out passes the link check", () => {
    const ok = qaDraftContent(withLink({ sampleSize: null, preparedByEmail: null, expiresAt: new Date(Date.now() + 30 * 86_400_000), validUrls: [url] }));
    expect(ok.map((i) => i.check)).not.toContain("audit_link");
  });
});
