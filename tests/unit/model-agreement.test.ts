/**
 * Model agreement (spec 066): known-answer fixtures for the pure core —
 * every label at its precedence, sufficiency exclusion, spread arithmetic,
 * and the stable ordering.
 */
import { describe, expect, it } from "vitest";
import {
  computeModelAgreement,
  MIN_PROVIDER_SAMPLE,
  MODEL_AGREEMENT_VERSION,
} from "@/lib/competitors/agreement";

/** N responses per provider, ids `${provider}-${i}`. */
function responsesFor(providers: Record<string, number>) {
  return Object.entries(providers).flatMap(([provider, n]) =>
    Array.from({ length: n }, (_, i) => ({
      responseId: `${provider}-${i}`,
      provider,
    }))
  );
}

/** Mention rows: for a company, per provider, in the first `mentioned`
 * responses — the first `recommended` of those also recommended. */
function mentionsFor(
  companyId: string,
  per: Record<string, { mentioned: number; recommended?: number }>
) {
  return Object.entries(per).flatMap(([provider, counts]) =>
    Array.from({ length: counts.mentioned }, (_, i) => ({
      responseId: `${provider}-${i}`,
      companyId,
      mentioned: true,
      recommended: i < (counts.recommended ?? 0),
    }))
  );
}

const company = (companyId: string, isSelf = false) => ({
  companyId,
  companyName: companyId,
  isSelf,
});

const FOUR_PROVIDERS = {
  openai: 12,
  anthropic: 12,
  google: 12,
  perplexity: 12,
};

function agreementFor(
  per: Record<string, { mentioned: number; recommended?: number }>,
  providers: Record<string, number> = FOUR_PROVIDERS
) {
  const result = computeModelAgreement({
    companies: [company("c1")],
    responses: responsesFor(providers),
    mentions: mentionsFor("c1", per),
  });
  return result.rows[0]!;
}

describe("computeModelAgreement labels", () => {
  it("consensus_recommended when every eligible provider recommends", () => {
    const row = agreementFor({
      openai: { mentioned: 10, recommended: 4 },
      anthropic: { mentioned: 8, recommended: 2 },
      google: { mentioned: 6, recommended: 1 },
      perplexity: { mentioned: 9, recommended: 3 },
    });
    expect(row.label).toBe("consensus_recommended");
    expect(row.recommendedOn).toBe(4);
    expect(row.summary).toContain("4/4");
  });

  it("consensus beats divergence — the stronger claim wins precedence", () => {
    // Recommended everywhere, but rates span 10/12 vs 1/12 (spread > 0.35).
    const row = agreementFor({
      openai: { mentioned: 10, recommended: 5 },
      anthropic: { mentioned: 1, recommended: 1 },
      google: { mentioned: 6, recommended: 2 },
      perplexity: { mentioned: 8, recommended: 1 },
    });
    expect(row.spread).toBeGreaterThan(0.35);
    expect(row.label).toBe("consensus_recommended");
  });

  it("single_provider when only one assistant surfaces the company", () => {
    const row = agreementFor({ perplexity: { mentioned: 11 } });
    expect(row.label).toBe("single_provider");
    expect(row.summary).toContain("perplexity");
    expect(row.summary).toContain("11/12");
  });

  it("single_provider outranks divergent (one assistant IS maximal spread)", () => {
    const row = agreementFor({ openai: { mentioned: 12 } });
    expect(row.spread).toBe(1);
    expect(row.label).toBe("single_provider");
  });

  it("divergent when mention rates span the threshold across ≥2 providers", () => {
    const row = agreementFor({
      openai: { mentioned: 10 }, // 83%
      anthropic: { mentioned: 2 }, // 17%
      google: { mentioned: 4 },
      perplexity: { mentioned: 5 },
    });
    expect(row.label).toBe("divergent");
    expect(row.summary).toContain("openai");
    expect(row.summary).toContain("anthropic");
  });

  it("consensus_mentioned when present everywhere, endorsed only somewhere", () => {
    const row = agreementFor({
      openai: { mentioned: 6, recommended: 2 },
      anthropic: { mentioned: 5 },
      google: { mentioned: 7 },
      perplexity: { mentioned: 6 },
    });
    expect(row.label).toBe("consensus_mentioned");
    expect(row.summary).toContain("recommended on 1/4");
  });

  it("majority for the in-between shape, stated as counts", () => {
    // Present on 2 of 4, but with a spread below the divergence threshold
    // (4/12 vs 0 = 0.33): partial presence, not disagreement.
    const row = agreementFor({
      openai: { mentioned: 4 },
      anthropic: { mentioned: 3 },
    });
    expect(row.spread).toBeLessThan(0.35);
    expect(row.label).toBe("majority");
    expect(row.summary).toContain("2/4");
  });

  it("absent when no eligible provider mentions the company", () => {
    const row = agreementFor({});
    expect(row.label).toBe("absent");
    expect(row.mentionedOn).toBe(0);
  });

  it("insufficient under two sufficient providers — never a one-model consensus", () => {
    const row = agreementFor(
      { openai: { mentioned: 9, recommended: 9 } },
      { openai: 12, anthropic: MIN_PROVIDER_SAMPLE - 1 }
    );
    expect(row.label).toBe("insufficient");
    expect(row.eligibleProviders).toBe(1);
  });
});

describe("computeModelAgreement mechanics", () => {
  it("excludes insufficient providers from the verdict but keeps their reading", () => {
    // perplexity has N=5: its 5/5 mentions must not create divergence.
    const result = computeModelAgreement({
      companies: [company("c1")],
      responses: responsesFor({ openai: 12, anthropic: 12, perplexity: 5 }),
      mentions: mentionsFor("c1", {
        openai: { mentioned: 6 },
        anthropic: { mentioned: 6 },
        perplexity: { mentioned: 5 },
      }),
    });
    const row = result.rows[0]!;
    expect(row.eligibleProviders).toBe(2);
    expect(row.label).toBe("consensus_mentioned");
    const perplexity = row.readings.find((r) => r.provider === "perplexity")!;
    expect(perplexity.sufficient).toBe(false);
    expect(perplexity.mentioned).toBe(5);
  });

  it("ignores mentions on ineligible responses instead of inventing a provider", () => {
    const result = computeModelAgreement({
      companies: [company("c1")],
      responses: responsesFor({ openai: 12, anthropic: 12 }),
      mentions: [
        ...mentionsFor("c1", { openai: { mentioned: 3 } }),
        { responseId: "errored-99", companyId: "c1", mentioned: true, recommended: true },
      ],
    });
    const row = result.rows[0]!;
    expect(row.readings.find((r) => r.provider === "openai")?.mentioned).toBe(3);
    expect(row.recommendedOn).toBe(0);
  });

  it("orders the subject first, then by breadth of presence", () => {
    const result = computeModelAgreement({
      companies: [company("wide"), company("self", true), company("narrow")],
      responses: responsesFor({ openai: 12, anthropic: 12 }),
      mentions: [
        ...mentionsFor("wide", {
          openai: { mentioned: 5 },
          anthropic: { mentioned: 5 },
        }),
        ...mentionsFor("narrow", { openai: { mentioned: 2 } }),
      ],
    });
    expect(result.version).toBe(MODEL_AGREEMENT_VERSION);
    expect(result.rows.map((r) => r.companyId)).toEqual(["self", "wide", "narrow"]);
  });
});
