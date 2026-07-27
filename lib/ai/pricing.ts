/**
 * Pinned per-model pricing in USD per million tokens (docs/11: money as
 * integers — cost math uses micro-dollars, where µ$ = tokens × $/MTok).
 *
 * Sources — verify before the first real paid run and update lastVerified:
 * - Anthropic: https://platform.claude.com/docs/en/pricing (verified 2026-07-27
 *   via the claude-api reference: opus-5 $5/$25, sonnet-5 $3/$15 sticker)
 * - OpenAI: https://openai.com/api/pricing (NOT yet verified — placeholder
 *   values; the run cost display flags unverified pricing)
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  verified: boolean;
  lastVerified: string;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    verified: true,
    lastVerified: "2026-07-27",
  },
  "claude-sonnet-5": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    verified: true,
    lastVerified: "2026-07-27",
  },
  "gpt-5.1": {
    inputPerMTok: 3,
    outputPerMTok: 12,
    verified: false,
    lastVerified: "2026-07-27",
  },
  "gpt-5": {
    inputPerMTok: 2,
    outputPerMTok: 8,
    verified: false,
    lastVerified: "2026-07-27",
  },
  "gemini-2.5-pro": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    verified: false,
    lastVerified: "2026-07-27",
  },
  "gemini-2.5-flash": {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    verified: false,
    lastVerified: "2026-07-27",
  },
  sonar: {
    inputPerMTok: 1,
    outputPerMTok: 1,
    verified: false,
    lastVerified: "2026-07-27",
  },
  "sonar-pro": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    verified: false,
    lastVerified: "2026-07-27",
  },
  "mock-model": {
    inputPerMTok: 1,
    outputPerMTok: 1,
    verified: true,
    lastVerified: "2026-07-27",
  },
};

/** Cost of a call in integer micro-dollars (µ$ = tokens × $/MTok). */
export function costMicroUsd(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return Math.round(
    tokensIn * pricing.inputPerMTok + tokensOut * pricing.outputPerMTok
  );
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}
