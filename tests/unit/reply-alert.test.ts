/** Spec 170 — operator alert for replies worth answering within the hour. */
import { describe, expect, it } from "vitest";
import { buildReplyAlert } from "@/lib/prospects/reply-alert";

const base = { prospectName: "Ken Hoover Team", marketName: "Kansas City", bodyText: "Yes, show me.", prospectUrl: "https://app.test/prospects/p1" };

describe("buildReplyAlert", () => {
  it("alerts on positive interest, questions, proof requests and referrals", () => {
    for (const c of ["positive_interest", "question", "proof_request", "referral"] as const) {
      expect(buildReplyAlert({ ...base, classification: c })).not.toBeNull();
    }
    const a = buildReplyAlert({ ...base, classification: "positive_interest" })!;
    expect(a.subject).toBe("[Positive reply] Ken Hoover Team (Kansas City): answer within the hour");
    expect(a.body).toContain("Yes, show me.");
    expect(a.body).toContain("https://app.test/prospects/p1");
  });
  it("stays quiet for unsubscribes, declines and not-interested", () => {
    for (const c of ["unsubscribe", "not_interested", "decline", "objection"] as const) {
      expect(buildReplyAlert({ ...base, classification: c })).toBeNull();
    }
  });
  it("trims long replies to an excerpt", () => {
    const a = buildReplyAlert({ ...base, classification: "question", bodyText: "x".repeat(2000) })!;
    expect(a.body.length).toBeLessThan(900);
  });
});

describe("spec 172: companyDomains", () => {
  it("lists business domains once and skips free-mail providers", async () => {
    const { companyDomains } = await import("@/lib/prospects/reply-sync");
    expect(companyDomains(["matt@talktotucker.com", "Kate@TalkToTucker.com", "joe@gmail.com", "a@kw.com"])).toEqual(["kw.com", "talktotucker.com"]);
  });
});
