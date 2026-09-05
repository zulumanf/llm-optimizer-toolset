/**
 * Spec 130 regression set: classifier identity with a verified alias, no
 * double count, recommendation ≠ mention, placeholder gate, HTML-only Gmail
 * bodies, and the report's correction/change-first copy.
 */
import { describe, expect, it } from "vitest";
import { classifyResponseLlm } from "@/lib/parsing/classify-llm";
import type { AgentCaller } from "@/lib/ai/agent";
import { qaDraftContent } from "@/lib/prospects/draft-qa";
import { lintFollowupCopy } from "@/lib/prospects/followup-templates";
import { gmailBodyText, htmlToText } from "@/lib/connectors/adapters/google";
import { stripQuotedReply, classifyReplyText } from "@/lib/prospects/reply-classify";
import { changeFirstRows, correctionNote, offerSection } from "@/lib/prospects/audit-mismatch";
import { ENGAGEMENT_OFFER, PRICING_REQUEST_RE } from "@/lib/prospects/constants";

const BLU = "85eba138-983b-4eec-b615-d56cf0c4dfe3";
const JOSH = "9081edd5-0ff0-4614-9358-bab85ac9caf4";
const companies = [
  { id: BLU, name: "Blu House Properties", aliases: ["Ryan John Ogle", "Ryan Ogle"], domain: null },
  { id: JOSH, name: "Josh May", aliases: [], domain: null },
];
const identityContext = {
  [BLU]: ["Real-estate team led by Ryan Ogle (RealTrends 2025, licensed dataset record). An answer that names Ryan Ogle as an agent refers to this team."],
};
function caller(payloads: unknown[], calls: string[] = []): AgentCaller {
  let i = 0;
  return async (req) => {
    calls.push(String((req as { user?: string }).user ?? ""));
    const payload = payloads[Math.min(i, payloads.length - 1)];
    i += 1;
    return { text: JSON.stringify(payload), tokensIn: 400, tokensOut: 100 };
  };
}
const verdict = (companyId: string, recommended: boolean, excerpt: string) => ({
  companyId, isSameEntity: true, entityRationale: "verified team lead", mentioned: true, recommended,
  listPosition: null, sentiment: "positive", excerpt, confidence: 0.9,
});

describe("classifier — lead agent named instead of the team", () => {
  const answer = "On Zillow’s Michigan Oaks agent page, Ryan Ogle (Blu House Properties / EXP) stands out with 11 team sales, and Josh May (RE/MAX of Grand Rapids) also shows multiple sales.";
  it("hands the classifier the verified relationship and credits the team once when both names appear", async () => {
    const calls: string[] = [];
    const drafts = await classifyResponseLlm({
      responseText: answer, promptText: "Who should I use to sell a townhome in Michigan Oaks?", companies, identityContext,
      caller: caller([{ companies: [verdict(BLU, true, "Ryan Ogle (Blu House Properties / EXP) stands out"), verdict(JOSH, false, "Josh May also shows multiple sales")] }], calls),
    });
    expect(calls[0]).toContain("led by Ryan Ogle");
    expect(drafts.filter((d) => d.companyId === BLU)).toHaveLength(1);
    expect(drafts.find((d) => d.companyId === BLU)?.recommended).toBe(true);
    expect(drafts.find((d) => d.companyId === JOSH)?.mentioned).toBe(true);
    expect(drafts.find((d) => d.companyId === JOSH)?.recommended).toBe(false);
  });
  it("without the alias the team is never a candidate: no LLM call, no row (the original bug)", async () => {
    let called = false;
    const drafts = await classifyResponseLlm({
      responseText: "Strong candidates include Ryan Ogle, Mark Brace and Josh May.", promptText: "q",
      companies: [{ ...companies[0]!, aliases: [] }], identityContext: {},
      caller: async () => { called = true; return { text: JSON.stringify({ companies: [] }), tokensIn: 1, tokensOut: 1 }; },
    });
    expect(called).toBe(false);
    expect(drafts).toHaveLength(0);
  });
  it("an unrelated agent with a similar surname is not a candidate for the team", async () => {
    let called = false;
    await classifyResponseLlm({
      responseText: "Darla Ogle leads Ogle Luxury Group in Santa Rosa Beach.", promptText: "q", companies, identityContext,
      caller: async () => { called = true; return { text: JSON.stringify({ companies: [] }), tokensIn: 1, tokensOut: 1 }; },
    });
    expect(called).toBe(false);
  });
});

describe("founder placeholder gate", () => {
  const base = {
    subject: "Re: Ryan - Grand Rapids", contactName: "Ryan Ogle", contactEmail: "ryan@thinkbluhouse.com", teamLeader: "Ryan John Ogle",
    brokerageAffiliation: "eXp Realty", audit: null, senderReplyTo: null, senderPostalAddress: null,
  };
  const body = (pricing: string) => `Ryan,\n\nPricing: ${pricing}\n\nFrancisco\n\n--\nFrancisco Zuluaga · Recommended First\nwww.RecommendedFirst.com\nBrooklyn, NY\nIf you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`;
  it("fails deterministic draft QA while [FOUNDER_PRICING] remains and passes once a number is in", () => {
    expect(qaDraftContent({ ...base, body: body("[FOUNDER_PRICING]") }).some((i) => i.check === "artifacts")).toBe(true);
    expect(qaDraftContent({ ...base, body: body("$2,500 for the first 90 days.") }).some((i) => i.check === "artifacts")).toBe(false);
  });
  it("fails the follow-up copy lint too", () => {
    expect(lintFollowupCopy(null, body("[FOUNDER_PRICING]")).some((i) => /placeholder/.test(i.detail))).toBe(true);
  });
});

describe("Gmail HTML-only bodies (the mis-ingested reply)", () => {
  const html = "<html><body><div dir=\"ltr\">Send them and show me how you get me ranked higher. Don’t sell me.<br><br>Spell out your pricing and I will review and consider.<br><br>Ryan Ogle - Blu House Properties</div><blockquote>On Sep 5, 2026, at 9:18 AM, francisco@recommendedfirst.com wrote:<br>Ryan, Earlier this week…</blockquote></body></html>";
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  it("strips tags and keeps line breaks", () => {
    const text = htmlToText(html);
    expect(text).toContain("Send them and show me how you get me ranked higher.");
    expect(text).not.toContain("<div");
  });
  it("falls back to text/html when no text/plain part exists, and the reply then classifies as positive interest", () => {
    const body = gmailBodyText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64(html) } }] });
    const stripped = stripQuotedReply(body);
    expect(stripped).toContain("Spell out your pricing");
    expect(stripped).not.toContain("Earlier this week");
    expect(classifyReplyText(stripped)).toBe("positive_interest");
  });
  it("still prefers text/plain when present", () => {
    const body = gmailBodyText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Yes") } }, { mimeType: "text/html", body: { data: b64("<p>Yes</p>") } }] });
    expect(body).toBe("Yes");
  });
});

describe("report correction note and change-first rows", () => {
  const correction = { original: { prospect: 11, competitor: 38 }, corrected: { prospect: 23, competitor: 38 }, aliasesCredited: ["Ryan Ogle"], correctedAt: "2026-09-05T18:00:00Z" };
  it("states the email's number and the corrected one, plainly", () => {
    const note = correctionNote({ correction, teamName: "Blu House Properties", competitor: "Josh May", answerCount: 256, entityType: "team" });
    expect(note).toContain("the email said 11");
    expect(note).toContain("23 of 256 for your team");
    expect(note).toContain("38 of 256 for Josh May, unchanged");
    expect(note).not.toMatch(/—|–/);
  });
  it("derives at most three evidence-backed rows and never promises a ranking", () => {
    const rows = changeFirstRows({
      prospect: { name: "Blu House Properties", productionDisplay: "$81.1M closed", productionYear: 2025, recommendationCount: 23 },
      competitor: { name: "Josh May", productionDisplay: "$65.5M closed", productionYear: 2025, recommendationCount: 38 },
      answerCount: 256, questionCount: 64, entityType: "team",
      correction: { ...correction, note: "" },
      appearances: [{ name: "Blu House Properties", answers: 23 }, { name: "Ryan Ogle", answers: 45 }],
      sources: [{ domain: "zillow.com", citations: 172, category: "platform" }, { domain: "realtor.com", citations: 140, category: "platform" }, { domain: "remax.com", citations: 9, category: "competitor" }],
      ownSiteCited: false,
      gaps: [{ key: "neighborhood", label: "Neighborhood questions", questions: 59, prospect: 7, competitor: 33 }],
      competitorNeighborhoods: ["Eastown", "John Ball Park", "Ridgemoor", "Michigan Oaks"],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.observed).toContain('"Ryan Ogle" in 45 of 256');
    expect(rows[1]!.observed).toContain("zillow.com and realtor.com");
    expect(rows[1]!.observed).toContain("own website did not appear");
    expect(rows[2]!.observed).toContain("Eastown, John Ball Park and Ridgemoor");
    const text = rows.map((r) => `${r.observed} ${r.change} ${r.test}`).join(" ");
    expect(text).not.toMatch(/will (get you )?rank|would have changed|causes/i);
    expect(text).toMatch(/Rerun the same 64 questions/);
  });
  it("omits rows without evidence", () => {
    const rows = changeFirstRows({
      prospect: { name: "X", productionDisplay: "$1M closed", productionYear: 2025, recommendationCount: 1 },
      competitor: { name: "Y", productionDisplay: "$1M closed", productionYear: 2025, recommendationCount: 2 },
      answerCount: 64, questionCount: 16, entityType: "individual", correction: null, appearances: [], sources: null, ownSiteCited: null, gaps: [], competitorNeighborhoods: [],
    });
    expect(rows).toEqual([]);
  });
});

describe("the offer section (only when pricing was asked for)", () => {
  it("states one number, the 90-day term, no long-term commitment and no ranking promise", () => {
    const o = offerSection();
    expect(o.price).toBe("$7,500/month for an initial 90-day engagement.");
    expect(o.includes).toEqual([...ENGAGEMENT_OFFER.includes]);
    expect(o.commitment).toContain("No long-term commitment after the first 90 days");
    expect(o.promise).toContain("can't promise a ranking");
    const text = `${o.title} ${o.price} ${o.includes.join(" ")} ${o.commitment} ${o.promise}`;
    expect(text).not.toMatch(/discount|founding|special|pilot|beta|starting at|depending|—|–/i);
  });
  it("recognises a pricing ask the way the learning log does", () => {
    expect(PRICING_REQUEST_RE.test("Spell out your pricing and I will review and consider.")).toBe(true);
    expect(PRICING_REQUEST_RE.test("Yes, send it over.")).toBe(false);
  });
});
