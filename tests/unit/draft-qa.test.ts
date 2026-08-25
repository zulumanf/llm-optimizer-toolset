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
      `1399 Myrtle Ave, Brooklyn, NY 11237\nIf you'd rather not hear from us, reply "unsubscribe".`,
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
