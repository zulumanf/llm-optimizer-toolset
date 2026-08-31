import { describe, expect, it } from "vitest";
import {
  classifyReplyText,
  CONVERSATION_CLASSIFICATIONS,
} from "@/lib/prospects/reply-classify";

const cases: [string, string][] = [
  // Positive interest — the KPI this template optimizes.
  ["yes", "positive_interest"],
  ["Yes please", "positive_interest"],
  ["sure", "positive_interest"],
  ["Sure, why not", "positive_interest"],
  ["ok", "positive_interest"],
  ["send it", "positive_interest"],
  ["Send it over", "positive_interest"],
  ["send the comparison", "positive_interest"],
  ["Please send the side-by-side", "positive_interest"],
  ["what did you find?", "positive_interest"],
  ["Interested. What did you find", "positive_interest"],
  ["let's see it", "positive_interest"],
  ["I'd like to see that", "positive_interest"],
  ["show me", "positive_interest"],
  ["I'm curious — tell me more", "positive_interest"],
  // Rejection.
  ["Not interested", "not_interested"],
  ["no thanks", "not_interested"],
  ["We're all set, thanks", "not_interested"],
  ["I'll pass", "not_interested"],
  // Compliance.
  ["unsubscribe", "unsubscribe"],
  ["Please remove me from your list", "unsubscribe"],
  ["stop emailing me", "unsubscribe"],
  ["opt me out", "unsubscribe"],
  // Autoresponders.
  ["I am out of the office until Sept 3", "out_of_office"],
  ["On vacation, back Monday. This is an automatic reply.", "out_of_office"],
  ["I'm away from my desk with limited access to email", "out_of_office"],
  // Referral.
  ["You should talk to my marketing director", "referral"],
  ["Forwarding this to our ops lead", "referral"],
  // Proof requests.
  ["How did you get these numbers?", "proof_request"],
  ["Where did the data come from?", "proof_request"],
  ["is this real", "proof_request"],
  // Objection.
  ["That's not accurate, we closed way more than that", "objection"],
  ["We already work with an SEO agency", "objection"],
  // Question fallback.
  ["Does this cover Hoboken too?", "question"],
  // Unclear.
  ["Thanks", "unclear"],
  ["", "unclear"],
];

describe("classifyReplyText", () => {
  it.each(cases)("%j → %s", (text, expected) => {
    expect(classifyReplyText(text)).toBe(expected);
  });

  it("out-of-office and unsubscribe never count as conversations", () => {
    expect(CONVERSATION_CLASSIFICATIONS).not.toContain("out_of_office");
    expect(CONVERSATION_CLASSIFICATIONS).not.toContain("unsubscribe");
    expect(CONVERSATION_CLASSIFICATIONS).toContain("positive_interest");
    expect(CONVERSATION_CLASSIFICATIONS).toContain("not_interested");
  });
});
