import { describe, expect, it, vi } from "vitest";
import { classifyResponseLlm } from "@/lib/parsing/classify-llm";
import type { AgentCaller } from "@/lib/ai/agent";

const PARVA = "11111111-1111-4111-8111-111111111111";
const ACME = "22222222-2222-4222-8222-222222222222";

const companies = [
  { id: PARVA, name: "Parva", aliases: ["parva.io"], domain: "parva.io" },
  { id: ACME, name: "Acme", aliases: [], domain: "acme.com" },
];
const identityContext = {
  [PARVA]: ["Parva is a link-in-bio tool built for real estate agents."],
};

/** Canned agent responses in call order. */
function caller(payloads: unknown[]): AgentCaller {
  let i = 0;
  return async () => {
    const payload = payloads[Math.min(i, payloads.length - 1)];
    i += 1;
    return { text: JSON.stringify(payload), tokensIn: 500, tokensOut: 120 };
  };
}

describe("classifyResponseLlm — entity resolution (the P0 fix)", () => {
  it("rejects a same-name different-entity match (the Mahabharata case)", async () => {
    const drafts = await classifyResponseLlm({
      responseText:
        "“Parva” usually means a “book” or “section” of a larger text. The Mahabharata is divided into 18 parvas.",
      promptText: "What is Parva and what does it do?",
      companies,
      identityContext,
      caller: caller([
        {
          companies: [
            {
              companyId: PARVA,
              isSameEntity: false,
              entityRationale: "Refers to Sanskrit epic sections, not the link-in-bio tool.",
              mentioned: false,
              recommended: false,
              listPosition: null,
              sentiment: "neutral",
              excerpt: null,
              confidence: 0.95,
            },
          ],
        },
      ]),
    });
    // No row at all — the parse service turns this into a retraction revision
    expect(drafts).toHaveLength(0);
  });

  it("keeps a genuine client mention with its recommendation status", async () => {
    const drafts = await classifyResponseLlm({
      responseText:
        "For realtors, Parva (parva.io) is a solid link-in-bio option. Visit https://parva.io to start.",
      promptText: "best link in bio tool for real estate agents?",
      companies,
      identityContext,
      caller: caller([
        {
          companies: [
            {
              companyId: PARVA,
              isSameEntity: true,
              entityRationale: "Matches the approved positioning and domain.",
              mentioned: true,
              recommended: true,
              listPosition: 2,
              sentiment: "positive",
              excerpt: "Parva (parva.io) is a solid link-in-bio option",
              confidence: 0.92,
            },
          ],
        },
      ]),
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      companyId: PARVA,
      mentioned: true,
      recommended: true,
      listPosition: 2,
      sentiment: "positive",
      needsReview: false,
    });
    // Cited URLs stay deterministic (domain match), never model-supplied
    expect(drafts[0]?.citedUrls).toEqual(["https://parva.io"]);
  });

  it("never calls the model when no alias matches (cost + recall discipline)", async () => {
    const spy = vi.fn();
    const drafts = await classifyResponseLlm({
      responseText: "Linktree and Beacons are popular choices.",
      promptText: "best link in bio tools?",
      companies,
      identityContext,
      caller: async (...args) => {
        spy(args);
        return { text: "{}", tokensIn: 0, tokensOut: 0 };
      },
    });
    expect(drafts).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("classifyResponseLlm — independent verification", () => {
  const lowConfidenceClassification = {
    companies: [
      {
        companyId: PARVA,
        isSameEntity: true,
        entityRationale: "Probably the tool.",
        mentioned: true,
        recommended: true,
        listPosition: null,
        sentiment: "positive",
        excerpt: "Parva may work",
        confidence: 0.55,
      },
    ],
  };

  it("flags review when the fresh-context verifier disagrees", async () => {
    const drafts = await classifyResponseLlm({
      responseText: "Parva may work, though it's unclear which Parva they mean.",
      promptText: "is Parva good?",
      companies,
      identityContext,
      caller: caller([
        lowConfidenceClassification,
        { agreesSameEntity: false, agreesRecommended: false, reason: "Ambiguous entity." },
      ]),
    });
    expect(drafts[0]?.needsReview).toBe(true);
    expect(drafts[0]?.confidence).toBeLessThanOrEqual(0.5);
  });

  it("verifier agreement does not remove the confidence-threshold review", async () => {
    const drafts = await classifyResponseLlm({
      responseText: "Parva may work for agents.",
      promptText: "is Parva good?",
      companies,
      identityContext,
      caller: caller([
        lowConfidenceClassification,
        { agreesSameEntity: true, agreesRecommended: true, reason: "Consistent." },
      ]),
    });
    // Still below docs/06 threshold → still human-reviewed
    expect(drafts[0]?.needsReview).toBe(true);
    expect(drafts[0]?.confidence).toBeCloseTo(0.55);
  });

  it("a failed verification forces review rather than trusting the classifier", async () => {
    let call = 0;
    const drafts = await classifyResponseLlm({
      responseText: "Parva may work for agents.",
      promptText: "is Parva good?",
      companies,
      identityContext,
      caller: async () => {
        call += 1;
        if (call === 1) {
          return {
            text: JSON.stringify(lowConfidenceClassification),
            tokensIn: 100,
            tokensOut: 50,
          };
        }
        throw new Error("verifier unavailable");
      },
    });
    expect(drafts[0]?.needsReview).toBe(true);
  });

  it("high-confidence rows skip verification entirely", async () => {
    let calls = 0;
    await classifyResponseLlm({
      responseText: "Parva is great for agents.",
      promptText: "best tool?",
      companies,
      identityContext,
      caller: async () => {
        calls += 1;
        return {
          text: JSON.stringify({
            companies: [
              {
                companyId: PARVA,
                isSameEntity: true,
                mentioned: true,
                recommended: true,
                listPosition: 1,
                sentiment: "positive",
                excerpt: "Parva is great",
                confidence: 0.9,
              },
            ],
          }),
          tokensIn: 100,
          tokensOut: 50,
        };
      },
    });
    expect(calls).toBe(1);
  });

  it("ignores company ids the model invented", async () => {
    const drafts = await classifyResponseLlm({
      responseText: "Parva is a tool for agents.",
      promptText: "what is Parva?",
      companies,
      identityContext,
      caller: caller([
        {
          companies: [
            {
              companyId: "99999999-9999-4999-8999-999999999999",
              isSameEntity: true,
              mentioned: true,
              recommended: true,
              listPosition: null,
              sentiment: "positive",
              excerpt: "x",
              confidence: 0.9,
            },
          ],
        },
      ]),
    });
    expect(drafts).toHaveLength(0);
  });
});
