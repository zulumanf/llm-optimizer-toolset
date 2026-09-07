import { describe, expect, it } from "vitest";
import {
  qaStrongCorrection,
  renderStrongCorrection,
  STRONG_CORRECTION_TEMPLATE_VERSION,
} from "@/lib/prospects/correction-templates";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const FOOTER = [
  "--",
  "Francisco Zuluaga · Recommended First",
  "www.RecommendedFirst.com",
  "Brooklyn, NY",
  'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.',
];

function snap(p: number, c: number, over: Partial<{ ratio: number; pd: string; cd: string }> = {}): MismatchEvidenceSnapshot {
  return {
    runId: "run-1",
    provider: "openai",
    answerCount: 256,
    capturedAt: "2026-08-31T09:41:00Z",
    prospect: { companyId: "p", name: "Jill & Jacque Real Estate", recommendationCount: p, productionDisplay: over.pd ?? "$88.5M closed", productionSignalId: "rt-1" },
    competitor: { companyId: "c", name: "Kelly Shaw Team", recommendationCount: c, productionDisplay: over.cd ?? "$23.7M closed", productionRatio: over.ratio ?? 0.27, recommendationGap: c - p },
  } as unknown as MismatchEvidenceSnapshot;
}

/** A Touch 1 body that states the original claim the way the template does. */
function touch1(o: MismatchEvidenceSnapshot): string {
  return [
    "Jill,",
    `Kelly Shaw Team came up in ${o.competitor.recommendationCount} of ${o.answerCount} answers; your team in ${o.prospect.recommendationCount} of ${o.answerCount} answers.`,
    ...FOOTER,
  ].join("\n");
}

const render = (o: MismatchEvidenceSnapshot, n: MismatchEvidenceSnapshot, entityType: "team" | "individual" = "team") =>
  renderStrongCorrection({ firstName: "Jill", marketName: "St. Louis, MO", entityType, original: o, corrected: n, footer: FOOTER });

describe("strong correction rendering", () => {
  it("competitor count increased, prospect unchanged: the canonical Jill & Jacque email", () => {
    const o = snap(0, 5), n = snap(0, 10);
    const r = render(o, n);
    expect(r.version).toBe(STRONG_CORRECTION_TEMPLATE_VERSION);
    expect(r.change).toBe("competitor");
    expect(r.body).toBe([
      "Jill,", "",
      "I rechecked the St. Louis results before following up and caught one correction.", "",
      "I originally had Kelly Shaw Team at 5 of 256 answers. The correct count from the same 256 answers is 10.", "",
      "Your team is still 0 of 256.", "",
      "So the mismatch is actually larger than I first showed:", "",
      "Your team: $88.5M closed · 0 of 256",
      "Kelly Shaw Team: $23.7M closed · 10 of 256", "",
      "I wanted to correct that before sending you anything else.", "",
      "Want me to send the exact questions?", "",
      ...FOOTER,
    ].join("\n"));
    expect(qaStrongCorrection("Re: Jill - St. Louis", r.body, o, n, { touch1Body: touch1(o), entityType: "team", entityConfidence: "high" })).toEqual([]);
  });

  it("prospect and competitor both changed: one sentence, both numbers, corrected block", () => {
    const o = snap(1, 5), n = snap(6, 10);
    const r = render(o, n);
    expect(r.change).toBe("both");
    expect(r.body).toContain("I originally had your team at 1 of 256 and Kelly Shaw Team at 5. The correct count from the same 256 answers is 6 versus 10.");
    expect(r.body).toContain("With the corrected numbers:");
    expect(r.body).not.toContain("larger than I first showed");
    expect(r.body).toContain("Your team: $88.5M closed · 6 of 256");
    expect(qaStrongCorrection(null, r.body, o, n, { touch1Body: touch1(o), entityType: "team", entityConfidence: "high" })).toEqual([]);
  });

  it("mismatch became larger: says so", () => {
    const r = render(snap(0, 6), snap(0, 25));
    expect(r.gapIncreased).toBe(true);
    expect(r.body).toContain("So the mismatch is actually larger than I first showed:");
  });

  it("mismatch became smaller but still eligible: shows the comparison without editorializing", () => {
    const o = snap(0, 10), n = snap(4, 10);
    const r = render(o, n);
    expect(r.gapIncreased).toBe(false);
    expect(r.body).toContain("I originally had your team at 0 of 256 answers. The correct count from the same 256 answers is 4.");
    expect(r.body).toContain("Kelly Shaw Team is still 10 of 256.");
    expect(r.body).toContain("With the corrected count, the comparison is:");
    expect(r.body).not.toContain("larger");
    expect(qaStrongCorrection(null, r.body, o, n, { touch1Body: touch1(o), entityType: "team", entityConfidence: "high" })).toEqual([]);
  });

  it("individual wording: You / you, never your team", () => {
    const o = snap(0, 5), n = snap(0, 10);
    const r = render(o, n, "individual");
    expect(r.body).toContain("You are still 0 of 256.");
    expect(r.body).toContain("You: $88.5M closed · 0 of 256");
    expect(r.body).not.toMatch(/your team/i);
    expect(qaStrongCorrection(null, r.body, o, n, { touch1Body: touch1(o), entityType: "individual", entityConfidence: "high" })).toEqual([]);
  });

  it("team wording: Your team / your team", () => {
    const r = render(snap(1, 5), snap(6, 10), "team");
    expect(r.body).toContain("I originally had your team at 1 of 256");
    expect(r.body).toContain("Your team: $88.5M closed · 6 of 256");
  });

  it("QA refuses the larger-mismatch phrase when the gap did not increase", () => {
    const o = snap(0, 10), n = snap(4, 10);
    const forged = render(o, n).body.replace("With the corrected count, the comparison is:", "So the mismatch is actually larger than I first showed:");
    const issues = qaStrongCorrection(null, forged, o, n, { touch1Body: touch1(o), entityType: "team", entityConfidence: "high" });
    expect(issues.map((i) => i.check)).toContain("correction_claim");
  });

  it("historical claim preserved: the original numbers are stated and must match the delivered Touch 1", () => {
    const o = snap(0, 5), n = snap(0, 10);
    const r = render(o, n);
    expect(r.body).toContain("I originally had Kelly Shaw Team at 5 of 256 answers");
    // A Touch 1 that stated something else fails closed.
    const issues = qaStrongCorrection(null, r.body, o, n, { touch1Body: touch1(snap(0, 7)), entityType: "team", entityConfidence: "high" });
    expect(issues.map((i) => i.check)).toContain("correction_history");
  });

  it("no technical jargon, no takeaway phrase, no em dash in any variant", () => {
    for (const [o, n] of [[snap(0, 5), snap(0, 10)], [snap(1, 5), snap(6, 10)], [snap(0, 10), snap(4, 10)]] as const) {
      const body = render(o, n).body;
      expect(body).not.toMatch(/entity|alias|reconcil|pipeline|bug|system error|takeaway/i);
      expect(body).not.toContain("—");
    }
    const o = snap(0, 5), n = snap(0, 10);
    const jargon = render(o, n).body.replace("caught one correction", "caught an entity-matching issue");
    expect(qaStrongCorrection(null, jargon, o, n, { touch1Body: touch1(o), entityType: "team", entityConfidence: "high" }).map((i) => i.check)).toContain("correction_jargon");
    const dash = render(o, n).body.replace("caught one correction", "caught one correction — see below");
    expect(qaStrongCorrection(null, dash, o, n, { touch1Body: touch1(o), entityType: "team", entityConfidence: "high" }).map((i) => i.check)).toContain("correction_punctuation");
  });

  it("refuses a corrected comparison that fails the mismatch gate or a non-high entity confidence", () => {
    const o = snap(0, 5), n = snap(9, 10);
    const r = render(o, n);
    const gate = qaStrongCorrection(null, r.body, o, n, { touch1Body: touch1(o), entityType: "team", entityConfidence: "high" });
    expect(gate.map((i) => i.check)).toContain("correction_eligibility");
    const conf = qaStrongCorrection(null, render(o, snap(0, 10)).body, o, snap(0, 10), { touch1Body: touch1(o), entityType: "team", entityConfidence: "medium" });
    expect(conf.map((i) => i.check)).toContain("correction_entity");
  });
});
