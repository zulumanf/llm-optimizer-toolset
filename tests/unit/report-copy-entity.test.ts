/**
 * Spec 139 — customer-facing report copy: entity-aware wording is
 * deterministic (team / individual / brokerage), team production is never
 * attributed to the recipient, "AI recommends" and audit wording are gone
 * from the template, the figure title is defensible, and the email names a
 * walkthrough only when a releasable video exists.
 */
import { describe, expect, it } from "vitest";
import { changeFirstRows, entityRef } from "@/lib/prospects/audit-mismatch";
import { lintReportAssertions, renderReportDelivery, serializeReportForReview, DELIVERY_VARIANTS, deliveryVariantOf } from "@/lib/prospects/report-handoff";
import { narrative } from "@/lib/prospects/audit-mismatch";
import { sendIntentKey } from "@/lib/prospects/fulfillment-lane";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { manifestFor } from "../fixtures/fact-manifest";

const snapshot: MismatchEvidenceSnapshot = {
  templateVersion: "competitive_mismatch_reply_v1", runId: "run-1", provider: "openai", answerCount: 256, modelCount: 1,
  capturedAt: "2026-08-31T00:00:00Z", completedAt: null, scopeCopy: "Reno questions", audiences: ["buyer", "seller"],
  prospect: { companyId: "p", prospectId: null, name: "Kirsch Team", recommendationCount: 2, productionSignalId: "rp", productionSourceUrl: "", productionYear: 2025, productionValue: 56_900_000, productionDisplay: "$56.9M closed" },
  competitor: { companyId: "c", prospectId: null, name: "The Hertz Team", recommendationCount: 25, productionSignalId: "rc", productionSourceUrl: "", productionYear: 2025, productionValue: 24_900_000, productionDisplay: "$24.9M closed", productionRatio: 0.44, recommendationGap: 23 },
  metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
};
const block = (entityType: AuditMismatchBlock["entityType"]): AuditMismatchBlock => ({
  templateVersion: "private_ai_recommendation_report_v2", entityType,
  prospect: { name: "Kirsch Team", productionDisplay: "$56.9M closed", productionYear: 2025, recommendationCount: 2 },
  competitor: { name: "The Hertz Team", productionDisplay: "$24.9M closed", productionYear: 2025, recommendationCount: 25 },
  productionSource: "RealTrends", metricLabel: "closed volume", assistant: "OpenAI", assistantPhrase: "the OpenAI model behind ChatGPT", webSearch: true,
  answerCount: 256, questionCount: 32, repetitions: 8, capturedAt: "2026-08-31T00:00:00Z", questions: [], distinctQuestions: { prospect: 2, competitor: 9 },
  categories: [], gaps: [], competitorNeighborhoods: [], sources: null, ownSiteCited: null, diagnosis: [], priorities: [], contextQuestions: [], lessConcerned: [],
  note: { paragraphs: [], question: null }, ctaBridge: null,
});
const rowsFor = (entityType: "team" | "individual" | "brokerage") => changeFirstRows({
  prospect: block(entityType).prospect, competitor: block(entityType).competitor, answerCount: 256, questionCount: 32, entityType, correction: null, appearances: [],
  sources: [{ domain: "zillow.com", citations: 1190, category: "platform" }, { domain: "realtor.com", citations: 300, category: "platform" }], ownSiteCited: false,
  gaps: [], competitorNeighborhoods: [],
});

describe("entity-aware wording", () => {
  it("1/2: a TEAM report says 'your team' and never attributes team production or counts to the recipient by name", () => {
    const s = serializeReportForReview(block("team"), { prospectName: "Kirsch Team", market: "Reno" });
    expect(s).toContain("RealTrends has your team ahead. In our test, The Hertz Team was recommended more often.");
    expect(s).toContain("Recommended in the test (Reno): Your team 2 / 256 · The Hertz Team 25 / 256");
    expect(s).not.toMatch(/\bLaura\b/);
    const change = rowsFor("team").map((r) => `${r.change} ${r.where} ${r.test}`).join(" ");
    expect(change).toContain("Bring your team's profiles on those sites in line");
    expect(change).toContain("profile pages for your team.");
    expect(change).toContain("how your team is named");
    expect(change).not.toMatch(/\bAudit\b|in the audit/);
  });
  it("3: an INDIVIDUAL report uses 'you' throughout", () => {
    const s = serializeReportForReview(block("individual"), { prospectName: "Laura Kirsch", market: "Reno" });
    expect(s).toContain("RealTrends has you ahead.");
    expect(s).toContain("you are ahead of The Hertz Team");
    expect(s).not.toMatch(/your team/);
    const change = rowsFor("individual").map((r) => `${r.change} ${r.where} ${r.test}`).join(" ");
    expect(change).toContain("Bring your profiles on those sites in line");
    expect(change).toContain("how you are named");
    expect(change).not.toMatch(/team/);
  });
  it("4: a BROKERAGE never falls back to team language", () => {
    expect(entityRef("brokerage")).toMatchObject({ ref: "your brokerage", yours: "your brokerage's", team: false, isAre: "is" });
    const change = rowsFor("brokerage").map((r) => `${r.change} ${r.where} ${r.test}`).join(" ");
    expect(change).toContain("Bring your brokerage's profiles on those sites in line");
    expect(change).not.toMatch(/your team|lead agent/);
    expect(rowsFor("brokerage").map((r) => r.where).join(" ")).toContain("profile pages for your brokerage.");
    expect(entityRef(null).ref).toBe("your team");
  });
});

describe("report wording", () => {
  it("5/6/7: no generic 'AI recommends', a recommendation-frequency figure title, no customer-facing 'audit'", () => {
    const s = serializeReportForReview(block("team"), { prospectName: "Kirsch Team", market: "Reno" });
    expect(s).not.toMatch(/AI recommends|AI recommendations/);
    expect(s).toContain("Figure 01 · Production vs recommendation frequency");
    expect(s).toContain("PRIVATE AI RECOMMENDATION REPORT");
    expect(s.toLowerCase()).not.toMatch(/\baudit\b/);
  });
});

describe("assertion lint (the deterministic half of the release-review policy)", () => {
  it("8: the corrected report template and its hypotheses pass; asserted causes, promised outcomes and rank promises block", () => {
    const b = block("team");
    const story = narrative({ prospect: b.prospect, competitor: b.competitor, answerCount: 256, questions: [], categories: [], market: "Reno", entityType: "team", gaps: [{ key: "neighborhood", label: "Neighborhood questions", questions: 6, prospect: 0, competitor: 9 }], competitorNeighborhoods: ["Damonte Ranch"], sources: [{ domain: "zillow.com", citations: 1190, category: "platform" }], ownSiteCited: false, distinctQuestions: { prospect: 2, competitor: 9 } } as never);
    const full = serializeReportForReview({ ...b, ...story, priorities: [{ title: "Portal profiles", body: "Bring your team's profiles in line; run the same test again afterwards to compare." }] }, { prospectName: "Kirsch Team", market: "Reno" });
    expect(lintReportAssertions(full)).toEqual([]);
    expect(full).toMatch(/not a reason|do not say why/);
    expect(lintReportAssertions("The Hertz Team is recommended because their Zillow profile is stronger.")[0]!.check).toBe("report_asserted_cause");
    expect(lintReportAssertions("Fixing the profiles will rank your team first.")[0]!.check).toBe("report_promised_outcome");
    expect(lintReportAssertions("We guarantee more recommendations.")[0]!.check).toBe("report_guarantee");
    expect(lintReportAssertions("This is a measured snapshot, not a guarantee of every future AI answer.")).toEqual([]);
  });
});

describe("delivery email and video", () => {
  const manifest = manifestFor(snapshot, "team");
  const TAIL = ["Brooklyn, NY", 'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.'];
  const URL = "https://app.recommendedfirst.com/report/kirsch-team/k";
  it("11/12: the walkthrough sentence appears only when a releasable video exists; the comparison sentence is the manifest's", () => {
    const without = renderReportDelivery({ firstName: "Laura", brandedUrl: URL, manifest, footerTail: TAIL });
    expect(without.body).not.toMatch(/walkthrough/i);
    expect(without.body).toContain("Absolutely. I put together the exact questions and side-by-side results here:");
    const withVideo = renderReportDelivery({ firstName: "Laura", brandedUrl: URL, manifest, footerTail: TAIL, videoIncluded: true });
    expect(withVideo.body).toContain("Absolutely. I put together a quick walkthrough along with the exact questions and side-by-side results here:");
    expect(withVideo.body.split(URL).length).toBe(2);
    for (const r of [without, withVideo]) {
      expect(r.body).toContain("The biggest thing that stood out: The Hertz Team closed roughly 44% of your team's volume, but was recommended 12.5x as often in the same 256-answer test.");
      expect(r.body).toContain("Take a look when you get a chance. If anything jumps out, just reply here.");
    }
  });
  it("the two variants are distinct send intents; the same variant is one intent", () => {
    const base = { prospectId: "p", replyId: "r", manifestHash: manifest.manifestHash, messageType: "positive_reply_report_delivery" as const, templateVersion: "v2" };
    expect(sendIntentKey({ ...base, variant: DELIVERY_VARIANTS.reportOnly })).not.toBe(sendIntentKey({ ...base, variant: DELIVERY_VARIANTS.reportAndVideo }));
    expect(deliveryVariantOf(true)).toBe("report_and_video");
  });
});
