import { describe, expect, it } from "vitest";
import { founderSalesBlock, renderFounderSalesBlock } from "@/lib/prospects/sales-block";
import { positiveReplyDueOn } from "@/lib/prospects/positive-replies";
import { classifyReplyText, replyObjections } from "@/lib/prospects/reply-classify";

const src = { auditId: "a1", publishedAt: new Date("2026-09-05T17:32:48Z") };
describe("founder sales block — one tangible step from the report's own change-first rows", () => {
  it("takes the first evidence-backed row verbatim and never invents one", () => {
    const b = founderSalesBlock({ changeFirst: [
      { title: "Identity consistency", observed: "Answers named Ryan Ogle 22 times and Blu House Properties 7 times, never together", change: "Make Ryan Ogle and Blu House Properties consistently connected on the profiles already appearing in the captured answers", where: "bluhouseproperties.com agent page; eXp agent profile; Zillow team page", whyFirst: "largest gap", test: "Re-run the same 256 questions after 6 weeks and count answers naming both" },
      { title: "Third-party profiles", observed: "x", change: "y", where: "z", whyFirst: "w", test: "t" },
    ] }, "Blu House Properties", src);
    expect(b?.changeFirst).toMatch(/consistently connected/);
    expect(b?.why).toMatch(/22 times/);
    expect(b?.where).toMatch(/eXp agent profile/);
    expect(b?.alsoConsider).toEqual(["Third-party profiles"]);
    const text = renderFounderSalesBlock(b!);
    expect(text).toMatch(/^WHAT I WOULD CHANGE FIRST\n/);
    expect(text).not.toMatch(/rank|guarantee|will cause/i);
  });
  it("no evidence-backed row → no block", () => {
    expect(founderSalesBlock({ changeFirst: [] }, "X", src)).toBeNull();
    expect(founderSalesBlock({ changeFirst: [{ title: "t", observed: "", change: "c", where: "", whyFirst: "", test: "" }] }, "X", src)).toBeNull();
  });
});

describe("positive reply due date — next business day in the operator's timezone", () => {
  it("Friday afternoon → Monday; a Labor-Day weekend reply → Tuesday", () => {
    expect(positiveReplyDueOn(new Date("2026-09-03T19:53:24Z"))).toBe("2026-09-04");
    expect(positiveReplyDueOn(new Date("2026-09-05T14:54:57Z"))).toBe("2026-09-08");
  });
});

describe("reply classifier — the three observed cases", () => {
  const steve = 'Yes\r\n\r\n*Top .00001 of all Triangle Agents*\r\n*Steve Wall*\r\n*Real Estate Advisor/Broker*\r\n\r\nOn Thu, Sep 3, 2026 at 9:03 AM Francisco <f@x.com> wrote:\r\n> Steve,\r\n> If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.\r\n';
  const ryanYes = "Send them and show me how you get me ranked higher. Don’t sell me. Show me something easy and tangible. Spell out your pricing and I will review and consider.";
  const ryanNo = "Hi Francisco, Thanks for the added information. That price is higher than I am willing to spend for this. I plan to take some time to learn more about the subject matter and focus on improving our ranking organically instead. I appreciate your offer and time. Best, Ryan";
  it("Steve's yes over our quoted unsubscribe footer is positive, even when recorded raw", () => {
    expect(classifyReplyText(steve)).toBe("positive_interest");
  });
  it("Ryan's HTML-only positive reply (as text) is positive", () => {
    expect(classifyReplyText(ryanYes)).toBe("positive_interest");
  });
  it("Ryan's price decline is a decline with PRICE_TOO_HIGH + PREFERS_DIY, and is never an opt-out", () => {
    expect(classifyReplyText(ryanNo)).toBe("decline");
    expect(replyObjections(ryanNo)).toEqual(expect.arrayContaining(["PRICE_TOO_HIGH", "PREFERS_DIY"]));
    expect(classifyReplyText(ryanNo)).not.toBe("unsubscribe");
  });
  it("a real opt-out still wins over everything", () => {
    expect(classifyReplyText("Too expensive. Please unsubscribe me.")).toBe("unsubscribe");
  });
});
