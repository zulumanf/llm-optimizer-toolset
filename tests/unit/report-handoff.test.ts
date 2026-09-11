/**
 * Spec 129 pure layer: report serialization + hash, deterministic evidence
 * QA, agent gates, the delivery email and its lint, the delivery slot.
 */
import { describe, expect, it } from "vitest";
import {
  assertDeliveryMatchesManifest,
  deliverySlot,
  gateAgentVerdicts,
  lintReportDelivery,
  qaMismatchReport,
  renderReportDelivery,
  reportContentHash,
  serializeReportForReview,
} from "@/lib/prospects/report-handoff";
import { reportProspectReview } from "@/lib/automation/nodes/agent";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { manifestFor } from "../fixtures/fact-manifest";

const snapshot: MismatchEvidenceSnapshot = {
  templateVersion: "competitive_mismatch_reply_v1", runId: "11111111-1111-4111-8111-111111111111", provider: "openai",
  answerCount: 64, modelCount: 1, capturedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:00:00Z",
  scopeCopy: "Reno buyer and seller questions", audiences: ["buyer", "seller"],
  prospect: { companyId: "p", prospectId: null, name: "Kane and Partners", recommendationCount: 7, productionSignalId: "p", productionSourceUrl: "https://rt.example", productionYear: 2025, productionValue: 47_200_000, productionDisplay: "$47.2M closed" },
  competitor: { companyId: "c", prospectId: null, name: "Harbor View Group", recommendationCount: 14, productionSignalId: "c", productionSourceUrl: "https://rt.example", productionYear: 2025, productionValue: 29_400_000, productionDisplay: "$29.4M closed", productionRatio: 0.62, recommendationGap: 7 },
  metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
};

const q = (text: string, comp: number, pros: number, over: Partial<AuditMismatchBlock["questions"][number]> = {}): AuditMismatchBlock["questions"][number] => ({
  text, wellFormed: true, audience: "buyer", propertyType: null, neighborhood: null, luxury: false, answers: 8,
  competitorRecommended: comp, prospectRecommended: pros, prospectMentioned: pros,
  excerpts: comp ? [{ model: "gpt-5", capturedAt: "2026-08-30T00:00:00Z", responseId: "r1", quote: "Harbor View Group is a strong choice for Midtown buyers." }] : [],
  ...over,
});

const block: AuditMismatchBlock = {
  templateVersion: "private_ai_recommendation_report_v2",
  prospect: { name: "Kane and Partners", productionDisplay: "$47.2M closed", productionYear: 2025, recommendationCount: 7 },
  competitor: { name: "Harbor View Group", productionDisplay: "$29.4M closed", productionYear: 2025, recommendationCount: 14 },
  productionSource: "RealTrends (licensed, verified)", metricLabel: "closed volume", assistant: "OpenAI",
  assistantPhrase: "the OpenAI model behind ChatGPT", webSearch: true, answerCount: 64, questionCount: 8, repetitions: 8, capturedAt: "2026-08-30T00:00:00Z",
  questions: [q("Who are the best buyer agents in Midtown Reno?", 6, 2, { neighborhood: "Midtown" }), q("Which team should I use to sell my condo in Reno?", 8, 1, { audience: "seller", propertyType: "condominiums" }), q("Best luxury agents in Reno?", 0, 4, { luxury: true })],
  distinctQuestions: { prospect: 3, competitor: 2 },
  categories: [{ key: "audience:seller", label: "Seller questions", questions: 1, prospect: 1, competitor: 8 }],
  gaps: [{ key: "audience:seller", label: "Seller questions", questions: 1, prospect: 1, competitor: 8 }],
  competitorNeighborhoods: ["Midtown"],
  sources: [{ domain: "zillow.com", citations: 12, category: "portal" }], ownSiteCited: false,
  diagnosis: [{ area: "Seller questions", observed: "Harbor View Group was recommended 8 times.", mayMean: "Their seller pages are what the model finds.", investigate: "Which of your listings pages are public." }],
  priorities: [{ title: "Seller-side presence", body: "Check what the answers pointed to." }],
  contextQuestions: ["Are you actively trying to grow in Midtown?"],
  lessConcerned: [{ condition: "Referral-only business", status: "Unknown from public data" }],
  note: { paragraphs: ["I only flagged this because the numbers looked backwards to me."], question: "Is Midtown an area you want more of?" },
  ctaBridge: "Your context is the missing variable.",
};

describe("report serialization", () => {
  it("is deterministic, page-ordered, and hash-stable", () => {
    const a = serializeReportForReview(block, { prospectName: "Kane and Partners", market: "Reno" });
    expect(a).toBe(serializeReportForReview(block, { prospectName: "Kane and Partners", market: "Reno" }));
    expect(reportContentHash(a)).toBe(reportContentHash(a));
    expect(a.indexOf("## The finding")).toBeLessThan(a.indexOf("## The receipts"));
    const pattern = serializeReportForReview({ ...block, distinctQuestions: { prospect: 3, competitor: 3 } }, { prospectName: "Kane and Partners", market: "Reno" });
    expect(pattern).toContain("so the rows overlap and do not add up to 8");
    expect(a).toContain("## Appendix");
    expect(a.indexOf("## The receipts")).toBeLessThan(a.indexOf("## What I'd look at first"));
    expect(a).toContain("Harbor View Group 14 / 64");
    expect(a).toContain("Your team closed more volume. Harbor View Group was recommended more.");
    expect(a).toContain('"Harbor View Group is a strong choice for Midtown buyers."');
    expect(reportContentHash(serializeReportForReview({ ...block, priorities: [] }, { prospectName: "Kane and Partners", market: "Reno" }))).not.toBe(reportContentHash(a));
  });
});

describe("deterministic report QA against the frozen Touch 1 evidence", () => {
  it("passes a consistent block and fails every drift", () => {
    expect(qaMismatchReport(block, snapshot)).toEqual([]);
    expect(qaMismatchReport(null, snapshot)[0]!.check).toBe("report_block");
    const checks = (b: AuditMismatchBlock) => qaMismatchReport(b, snapshot).map((i) => i.detail).join(" ");
    expect(checks({ ...block, competitor: { ...block.competitor, recommendationCount: 13 } })).toContain("competitor recommendation count drifted");
    expect(checks({ ...block, answerCount: 65 })).toContain("denominator 65");
    expect(checks({ ...block, competitor: { ...block.competitor, name: "Other" } })).toContain("competitor Other");
    expect(checks({ ...block, prospect: { ...block.prospect, productionDisplay: "$48.2M closed" } })).toContain("prospect production drifted");
    expect(checks({ ...block, assistant: "ChatGPT" })).toContain("consumer app");
    expect(checks({ ...block, distinctQuestions: { prospect: 3, competitor: 5 } })).toContain("distinct competitor questions");
    expect(checks({ ...block, questions: block.questions.map((x) => ({ ...x, excerpts: [] })) })).toContain("no competitor excerpt");
    expect(checks({ ...block, priorities: [{ title: "Fix your prompts", body: "Improve citation acquisition." }] })).toContain("jargon");
    expect(checks({ ...block, note: { paragraphs: ["This is costing you deals."], question: null } })).toContain("prohibited phrase");
    expect(checks({ ...block, diagnosis: [{ area: "undefined questions", observed: "x", mayMean: "y", investigate: "z" }] })).toContain("placeholder");
    expect(checks({ ...block, diagnosis: [] })).toContain("no diagnosis");
    // Entity wording: the report must address the prospect the way RealTrends records them.
    expect(qaMismatchReport({ ...block, entityType: "team" }, snapshot, "team")).toEqual([]);
    expect(qaMismatchReport({ ...block, entityType: "team" }, snapshot, "individual").map((i) => i.check)).toContain("report_entity");
    expect(qaMismatchReport({ ...block, entityType: "individual", note: { paragraphs: ["Your team showed up less often."], question: null } }, snapshot, "individual").map((i) => i.detail).join()).toContain('addressed as "your team"');
  });
});

describe("agent gates", () => {
  const review = { verdict: "send" as const, concerns: [], firstImpression: "Clear.", topQuestion: null, confidence: 0.8, confidenceNote: "n/a" };
  const sense = { concerns: [], overallReadsFair: true, confidence: 0.8, confidenceNote: "n/a" };
  it("passes only on send + no blocking/concern + confidence", () => {
    expect(gateAgentVerdicts(review, sense).passed).toBe(true);
    expect(gateAgentVerdicts({ ...review, verdict: "fix" }, sense).reasons.join()).toContain('verdict "fix"');
    expect(gateAgentVerdicts({ ...review, concerns: [{ severity: "blocking", area: "jargon", detail: "Uses 'prompt'", quote: null }] }, sense).passed).toBe(false);
    expect(gateAgentVerdicts({ ...review, concerns: [{ severity: "polish", area: "tone", detail: "slightly long", quote: null }] }, sense).passed).toBe(true);
    expect(gateAgentVerdicts({ ...review, confidence: 0.5 }, sense).passed).toBe(false);
    expect(gateAgentVerdicts(review, { ...sense, concerns: [{ severity: "concern", area: "overreach", detail: "x", quote: null }] }).passed).toBe(false);
    expect(gateAgentVerdicts(review, { ...sense, overallReadsFair: false }).passed).toBe(false);
    expect(gateAgentVerdicts(null, sense).reasons).toContain("prospect review did not complete");
    expect(gateAgentVerdicts(review, null).reasons).toContain("sense check did not complete");
  });
  it("the review schema maps an unknown area to other and requires the verdict", () => {
    const parsed = reportProspectReview.safeParse({ verdict: "send", concerns: [{ severity: "polish", area: "vibes", detail: "x" }], firstImpression: "ok", confidence: 0.7, confidenceNote: "n" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.concerns[0]!.area).toBe("other");
    expect(reportProspectReview.safeParse({ concerns: [], firstImpression: "ok", confidence: 0.7, confidenceNote: "n" }).success).toBe(false);
  });
});

const TAIL = ["Brooklyn, NY", 'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.'];
const URL = "https://app.recommendedfirst.com/audit/kane-and-partners/y9BnX64cZtgN08Q0";

describe("delivery email (spec 137 template v2, manifest-fed)", () => {
  const manifest = manifestFor(snapshot, "team");
  it("renders one link and ONE compiled comparison sentence whose figures are all manifest figures, and passes lint + assertion", () => {
    const team = renderReportDelivery({ firstName: "Ryan", brandedUrl: URL, manifest, footerTail: TAIL });
    expect(team.body).toContain(`\n${URL}\n`);
    expect(team.body).toContain("The biggest thing that stood out: Harbor View Group closed roughly 62% of your team's volume, but was recommended 2x as often in the same 64-answer test.");
    expect(team.summary.factIds).toEqual(["FACT_COMPETITOR_NAME", "FACT_PRODUCTION_RATIO", "FACT_RECOMMENDATION_MULTIPLE", "FACT_DENOMINATOR"]);
    expect(lintReportDelivery(team.body, URL)).toEqual([]);
    expect(assertDeliveryMatchesManifest(team.body, URL, manifest)).toEqual([]);
    expect(team.body).not.toMatch(/[—–]/);
    const agent = renderReportDelivery({ firstName: "Ryan", brandedUrl: URL, manifest: manifestFor(snapshot, "individual"), footerTail: TAIL });
    expect(agent.body).toContain("of your volume");
    expect(agent.body).not.toMatch(/your team/i);
  });
  it("an invented quantitative sentence fails the manifest assertion deterministically", () => {
    const r = renderReportDelivery({ firstName: "Ryan", brandedUrl: URL, manifest, footerTail: TAIL });
    const tampered = r.body.replace("I also included", "You were recommended in 9 of 100 answers. I also included");
    const issues = assertDeliveryMatchesManifest(tampered, URL, manifest);
    expect(issues.map((i) => i.detail).join()).toContain("9, 100");
    // The footer's postal/zip digits are outside the assertion (below the signature).
    expect(assertDeliveryMatchesManifest(r.body.replace("Brooklyn, NY", "Brooklyn, NY 11201"), URL, manifest)).toEqual([]);
  });
  it("lint rejects a missing or doubled link, a second link, and follow-up copy violations", () => {
    const r = renderReportDelivery({ firstName: "Ryan", brandedUrl: URL, manifest, footerTail: TAIL });
    expect(lintReportDelivery(r.body.replace(URL, "the report"), URL)[0]!.detail).toContain("exactly once");
    expect(lintReportDelivery(`${r.body}\n${URL}`, URL)[0]!.detail).toContain("exactly once");
    expect(lintReportDelivery(r.body.replace("Francisco\n", "Francisco https://calendly.com/x\n"), URL).length).toBeGreaterThan(0);
    expect(lintReportDelivery(r.body.replace("Absolutely.", "Absolutely — finally"), URL).map((i) => i.detail).join()).toContain("em dash");
  });
});

describe("delivery slot", () => {
  const NY = "America/New_York";
  it("answers within 4–12 minutes during waking hours, else the next local morning", () => {
    const noon = new Date("2026-09-04T16:00:00Z"); // 12:00 ET
    const s = deliverySlot(noon, NY, "h1");
    const delay = (s.getTime() - noon.getTime()) / 60_000;
    expect(delay).toBeGreaterThanOrEqual(4);
    expect(delay).toBeLessThanOrEqual(12);
    expect(deliverySlot(noon, NY, "h1").toISOString()).toBe(s.toISOString());
    const night = new Date("2026-09-05T02:30:00Z"); // 22:30 ET Friday
    const m = deliverySlot(night, NY, "h1");
    expect(m.toISOString().slice(0, 13)).toBe("2026-09-05T12"); // Sat 08:xx ET, weekends allowed
    const early = new Date("2026-09-05T08:00:00Z"); // 04:00 ET
    expect(deliverySlot(early, NY, "h1").toISOString().slice(0, 13)).toBe("2026-09-05T12");
  });
});
