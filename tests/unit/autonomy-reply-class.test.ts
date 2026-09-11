/**
 * Spec 137 — reply preprocessing + autonomy classification matrix (tests
 * 1–12). Pure. Precision over coverage: the allowlist is narrow, every
 * exclusion escalates with a named reason.
 */
import { describe, expect, it } from "vitest";
import { classifyForAutonomy, preprocessReply } from "@/lib/prospects/reply-preprocess";
import { classifyReplyText } from "@/lib/prospects/reply-classify";

const eligible = (t: string) => expect(classifyForAutonomy(t).autonomyClass, t).toBe("autonomy_eligible");
const escalate = (t: string, why?: string | RegExp) => {
  const c = classifyForAutonomy(t);
  expect(c.autonomyClass, t).toBe("escalate");
  if (why) expect(c.reason, t).toMatch(why);
};

describe("autonomy classification: eligible forms", () => {
  it("1–4: Yes / Send it / Sure / I'd like to see it", () => {
    eligible("Yes");
    eligible("Send it");
    eligible("Sure");
    eligible("I'd like to see it");
  });
  it("plain variants with greeting, name and closing", () => {
    eligible("Hi Francisco, yes please send it. Thanks, Ryan");
    eligible("Sure, send it.");
    eligible("Show me");
    eligible("Please send");
    eligible("Yes!");
    eligible("Ok send it over");
    eligible("Sounds good, send it");
    eligible("I'm interested");
  });
});

describe("autonomy classification: escalations", () => {
  it("5–7: pricing, cost and guarantee language escalate even when positive", () => {
    escalate("Yes, how much?", /pricing|question/);
    escalate("Sure, what does it cost?", /pricing|question/);
    escalate("Yes, but can you guarantee it?", /guarantee|question|hedged/);
    escalate("Yes. What's your fee?", /pricing|question/);
  });
  it("scope, methodology, complaint and implementation questions escalate", () => {
    escalate("Yes but what would you actually change?", /scope|question|hedged/);
    escalate("Send it. How did you run this?", /methodology|question|proof_request/);
    escalate("Sure, though I think the numbers are wrong", /methodology|hedged/);
    escalate("Yes, and can this integrate with my website?", /implementation|question/);
  });
  it("12: hedged intent escalates; long positive replies escalate", () => {
    escalate("Maybe", /reply class|hedged/);
    escalate("Yes, if it's quick", /hedged/);
    escalate("Yes " + "and I have been thinking about this a lot lately because ".repeat(4), /longer|hedged|not a plain/);
  });
  it("11: OOO is never positive; 9: a real unsubscribe is a suppression class", () => {
    escalate("I am out of the office until Monday with limited access to email.", /autoresponder|reply class/);
    expect(classifyReplyText("Please unsubscribe me")).toBe("unsubscribe");
    escalate("Please unsubscribe me", /reply class unsubscribe/);
  });
});

describe("reply preprocessing", () => {
  it("8: our quoted unsubscribe footer under a Yes stays positive and eligible", () => {
    const body = [
      "Yes", "",
      "On Tue, Sep 1, 2026 at 9:07 AM Francisco Zuluaga <francisco@recommendedfirst.com> wrote:",
      "> Ryan,", "> Earlier this week I ran Reno buyer and seller questions...",
      '> If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.',
    ].join("\n");
    expect(classifyReplyText(body)).toBe("positive_interest");
    expect(preprocessReply(body).human).toBe("Yes");
    eligible(body);
  });
  it("10: an HTML-only body already reduced to text classifies from its words", () => {
    const body = "Sure, send it\n\nSent from my iPhone";
    const pre = preprocessReply(body);
    expect(pre.human).toBe("Sure, send it");
    expect(pre.strippedTrailer).toBe(true);
    eligible(body);
  });
  it("signature and legal trailers are stripped; the raw body is untouched by the caller", () => {
    const body = ["Yes please", "", "Best,", "Ryan Ogle", "Team Lead | Blu House Properties", "Cell: 616-555-0100", "",
      "CONFIDENTIALITY NOTICE: This email and any attachments are intended only for the addressee. Wire fraud is on the rise."].join("\n");
    const pre = preprocessReply(body);
    expect(pre.human).toBe("Yes please");
    eligible(body);
    // A legal trailer that mentions a guarantee does not escalate a plain yes.
    const legal = "Yes\n\nDisclaimer: nothing herein is a guarantee or a contract; price and terms subject to change.";
    expect(preprocessReply(legal).human).toBe("Yes");
    eligible(legal);
  });
  it("an all-quoted or redacted body has no human text and escalates", () => {
    escalate("> yes\n> send it", /no human|reply class/);
    escalate("[redacted attachment]", /no human|reply class/);
  });
});
