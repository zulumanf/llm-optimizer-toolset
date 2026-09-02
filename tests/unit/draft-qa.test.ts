import { describe, expect, it } from "vitest";
import { qaDraftContent, type DraftQaInput } from "@/lib/prospects/draft-qa";

const AUDIT_URL = "https://app.recommendedfirst.com/audit/acme-team/tok123456789";

function base(): DraftQaInput {
  return {
    subject: "A Wilmington benchmark result about Acme Team",
    body:
      `Hi Jane,\n\nI was benchmarking teams (354 monitored responses).\n\n` +
      `Acme Team was mentioned in 0 of 354 monitored responses (0%).\n\n` +
      `${AUDIT_URL}\n\nReply "show me".\n\n—\nFrancisco Zuluaga · Recommended First\n` +
      `www.RecommendedFirst.com\n1399 Myrtle Ave, Brooklyn, NY 11237\nIf you'd rather not hear from us, reply "unsubscribe".`,
    contactName: "Jane Smith",
    contactEmail: "jane@acmerealty.com",
    teamLeader: null,
    brokerageAffiliation: null,
    audit: {
      sampleSize: 354,
      preparedByEmail: "francisco@recommendedfirst.com",
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      validUrls: [AUDIT_URL],
    },
    senderReplyTo: "francisco@recommendedfirst.com",
    senderPostalAddress: "1399 Myrtle Ave, Brooklyn, NY 11237",
  };
}

const checks = (input: DraftQaInput): string[] => qaDraftContent(input).map((i) => i.check);

describe("qaDraftContent", () => {
  it("passes a clean draft", () => {
    expect(qaDraftContent(base())).toEqual([]);
  });

  it("flags conflicting sample sizes in one body (the 512-vs-354 defect)", () => {
    const input = base();
    input.body = input.body.replace("(354 monitored responses)", "(512 monitored responses)");
    expect(checks(input)).toContain("count_consistency");
  });

  it("flags a cited sample that disagrees with the published finding", () => {
    const input = base();
    input.audit!.sampleSize = 512;
    expect(checks(input)).toContain("count_consistency");
  });

  it("flags a brokerage-domain contact with no recorded affiliation", () => {
    const input = base();
    input.contactEmail = "jane@compass.com";
    expect(checks(input)).toContain("brokerage_recorded");
    input.brokerageAffiliation = "Compass";
    expect(checks(input)).not.toContain("brokerage_recorded");
  });

  it("flags a missing compliance footer", () => {
    const input = base();
    input.body = input.body.replace("1399 Myrtle Ave, Brooklyn, NY 11237\n", "");
    expect(checks(input)).toContain("compliance_footer");
  });

  it("flags a greeting that matches neither contact nor team leader", () => {
    const input = base();
    input.body = input.body.replace("Hi Jane,", "Hi Robert,");
    expect(checks(input)).toContain("greeting");
    const there = base();
    there.body = there.body.replace("Hi Jane,", "Hi there,");
    expect(checks(there)).not.toContain("greeting");
  });

  it("flags an audit URL that is not the prospect's live link", () => {
    const input = base();
    input.body = input.body.replace(AUDIT_URL, "https://app.recommendedfirst.com/audit/other-team/wrongtoken99");
    expect(checks(input)).toContain("audit_link");
  });

  it("flags a preparedBy that is not the sender identity", () => {
    const input = base();
    input.audit!.preparedByEmail = "zulumanf@gmail.com";
    expect(checks(input)).toContain("prepared_by");
  });

  it("flags an audit expiring within 7 days and template artifacts", () => {
    const input = base();
    input.audit!.expiresAt = new Date(Date.now() + 2 * 86_400_000);
    input.body += "\nvalue: undefined";
    const found = checks(input);
    expect(found).toContain("audit_link");
    expect(found).toContain("artifacts");
  });
});

// ---------------------------------------------------------------- spec 124

import { qaMismatchClaims, type MismatchQaLive } from "@/lib/prospects/draft-qa";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { MISMATCH_TEMPLATE_VERSION, MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";

const MISMATCH_BODY =
  `Jane —\n\nLast week I ran Jersey City buyer and seller questions through ` +
  `the OpenAI model behind ChatGPT. It recommended Harbor View Group more often ` +
  `than your team, even though RealTrends has you ahead on closed volume.\n\n` +
  `Your team: $47.2M closed · recommended in 7 of 64 answers\n` +
  `Harbor View Group: $29.4M closed · recommended in 14 of 64 answers\n\n` +
  `When people use ChatGPT to research who to work with, they can see them before they see you.\n\n` +
  `I have the exact questions and the side-by-side. Want me to send them?\n\n—\n` +
  `Francisco Zuluaga · Recommended First\nwww.RecommendedFirst.com\n` +
  `1399 Myrtle Ave, Brooklyn, NY 11237\n` +
  `If you'd rather not hear from us, reply "unsubscribe".`;

function mismatchBase(): DraftQaInput {
  const input = base();
  input.subject = "Jane — Jersey City";
  input.body = MISMATCH_BODY;
  input.evidence = { denominator: 64 };
  return input;
}

describe("qaDraftContent — competitive mismatch drafts (spec 124)", () => {
  it("accepts the direct 'Name —' greeting and validates the name", () => {
    expect(qaDraftContent(mismatchBase())).toEqual([]);
    const wrong = mismatchBase();
    wrong.body = wrong.body.replace("Jane —", "Robert —");
    expect(checks(wrong)).toContain("greeting");
  });

  it("validates the denominator against the draft's own evidence, not the audit sample", () => {
    // Audit sample is 354; the mismatch body correctly cites the OpenAI-only 64.
    expect(checks(mismatchBase())).not.toContain("count_consistency");
    const drifted = mismatchBase();
    drifted.evidence = { denominator: 96 };
    expect(checks(drifted)).toContain("count_consistency");
  });

  it("still flags two different denominators in one body", () => {
    const conflicted = mismatchBase();
    conflicted.body = conflicted.body.replace("in 14 of 64 answers", "in 14 of 512 answers");
    expect(checks(conflicted)).toContain("count_consistency");
  });
});

const SNAPSHOT: MismatchEvidenceSnapshot = {
  templateVersion: MISMATCH_TEMPLATE_VERSION,
  runId: "run-1",
  provider: "openai",
  answerCount: 64,
  modelCount: 1,
  capturedAt: "2026-08-26T09:00:00.000Z",
  completedAt: "2026-08-26T09:00:00.000Z",
  scopeCopy: "Jersey City buyer and seller questions",
  audiences: ["buyer", "seller"],
  prospect: {
    companyId: "c1",
    prospectId: "p1",
    name: "Acme Team",
    recommendationCount: 7,
    productionSignalId: "sig-p",
    productionSourceUrl: "https://www.realtrends.com/x",
    productionYear: 2025,
    productionValue: 47_200_000,
    productionDisplay: "$47.2M closed",
  },
  competitor: {
    companyId: "c2",
    prospectId: "p2",
    name: "Harbor View Group",
    recommendationCount: 14,
    productionSignalId: "sig-c",
    productionSourceUrl: "https://www.realtrends.com/y",
    productionYear: 2025,
    productionValue: 29_400_000,
    productionDisplay: "$29.4M closed",
    productionRatio: 0.62,
    recommendationGap: 7,
  },
  metricType: "closed_volume",
  thresholds: MISMATCH_THRESHOLDS,
};

const LIVE: MismatchQaLive = {
  eligible: true,
  eligibleCompetitorCompanyIds: ["c2"],
  prospectRecommendationCount: 7,
  competitorRecommendationCount: 14,
  answerCount: 64,
  benchmarkAgeDays: 3,
};

describe("qaMismatchClaims — every claim re-proven at approval and dispatch", () => {
  it("passes when the frozen claims still hold", () => {
    expect(qaMismatchClaims(MISMATCH_BODY, SNAPSHOT, LIVE)).toEqual([]);
  });
  it("fails when the body no longer states a frozen claim", () => {
    const issues = qaMismatchClaims(
      MISMATCH_BODY.replace("in 7 of 64 answers", "in 9 of 64 answers"),
      SNAPSHOT,
      LIVE
    );
    expect(issues.map((i) => i.check)).toContain("mismatch_render");
  });
  it("fails when live counts have drifted from the frozen ones", () => {
    const issues = qaMismatchClaims(MISMATCH_BODY, SNAPSHOT, {
      ...LIVE,
      competitorRecommendationCount: 9,
    });
    expect(issues.map((i) => i.check)).toContain("mismatch_stale");
  });
  it("fails when eligibility is gone or the competitor left the eligible set", () => {
    const issues = qaMismatchClaims(MISMATCH_BODY, SNAPSHOT, {
      ...LIVE,
      eligibleCompetitorCompanyIds: ["c9"],
    });
    expect(issues.map((i) => i.check)).toContain("mismatch_eligibility");
  });
  it("fails when the benchmark has aged past the hard maximum", () => {
    const issues = qaMismatchClaims(MISMATCH_BODY, SNAPSHOT, {
      ...LIVE,
      benchmarkAgeDays: MISMATCH_THRESHOLDS.maxBenchmarkAgeDays + 1,
    });
    expect(issues.map((i) => i.check)).toContain("mismatch_recency");
  });
});

describe("qaDraftContent — public signature domain (cohort 001 directive)", () => {
  it("fails a footer that shows the operator-console host", () => {
    const input = base();
    input.body = input.body.replace(
      "www.RecommendedFirst.com",
      "app.recommendedfirst.com"
    );
    expect(checks(input)).toContain("signature_domain");
  });

  it("fails a footer that omits the public website", () => {
    const input = base();
    input.body = input.body.replace("www.RecommendedFirst.com\n", "");
    expect(checks(input)).toContain("signature_domain");
  });
});
