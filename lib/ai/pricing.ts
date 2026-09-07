/**
 * Pinned per-model pricing in USD per million tokens (docs/11: money as
 * integers — cost math uses micro-dollars, where µ$ = tokens × $/MTok).
 *
 * Sources — verify before the first real paid run and update lastVerified:
 * - Anthropic: https://platform.claude.com/docs/en/pricing (verified 2026-07-27
 *   via the claude-api reference: opus-5 $5/$25, sonnet-5 $3/$15 sticker)
 * - OpenAI: verified 2026-07-27 (model ids against the account's live
 *   /v1/models; prices gpt-5.4 $2.50/$15, gpt-5.4-mini $0.75/$4.50 per
 *   web-published pricing pages)
 * - Google/Perplexity: NOT verified — placeholder values; the run cost
 *   display flags unverified pricing
 */
import { ClassifiedError } from "@/lib/errors";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Flat per-call fee in micro-dollars (spec 117) — e.g. OpenAI bills the
   * web_search tool per call, on top of tokens. Omitted = 0. */
  perCallFeeMicroUsd?: number;
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
  "gpt-5.4-2026-03-05": {
    inputPerMTok: 2.5,
    outputPerMTok: 15,
    verified: true,
    lastVerified: "2026-07-27",
  },
  "gpt-5.4-mini-2026-03-17": {
    inputPerMTok: 0.75,
    outputPerMTok: 4.5,
    verified: true,
    lastVerified: "2026-07-27",
  },
  // "+search" = same snapshot through the Responses API with the web_search
  // tool (lib/ai/openai.ts). Token prices identical; OpenAI bills the search
  // tool separately per call — carried as perCallFeeMicroUsd (spec 117).
  // $0.01/call is an ESTIMATE (2026-08-25 ledger showed ~2× real spend vs
  // token-only math): verify on the OpenAI billing dashboard, correct the
  // number, and flip verified.
  "gpt-5.4-2026-03-05+search": {
    inputPerMTok: 2.5,
    outputPerMTok: 15,
    perCallFeeMicroUsd: 10_000,
    verified: false,
    lastVerified: "2026-07-28",
  },
  "gpt-5.4-mini-2026-03-17+search": {
    inputPerMTok: 0.75,
    outputPerMTok: 4.5,
    perCallFeeMicroUsd: 10_000,
    verified: false,
    lastVerified: "2026-07-28",
  },
  // Anthropic "+search": token prices assumed identical to the base snapshot;
  // the web_search tool is billed separately and, like the adapter itself,
  // has never been executed on this account — unverified until the first
  // real call (scripts/verify-providers.ts).
  "claude-opus-5+search": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    verified: false,
    lastVerified: "2026-07-31",
  },
  "claude-sonnet-5+search": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    verified: false,
    lastVerified: "2026-07-31",
  },
  // Gemini 3 preview ids — the ones this account can actually call
  // (lib/ai/google.ts pins them; the 2.5 ids return 404 and their pricing
  // rows are gone with them). Prices are carried over from the 2.5 sticker
  // as placeholders: NOT verified, and preview pricing may differ. Grounded
  // (+search) variants: Google bills grounding separately; that fee is not
  // in our cost math — same caveat as OpenAI's search tool.
  "gemini-3-flash-preview": {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    verified: false,
    lastVerified: "2026-07-31",
  },
  "gemini-3-pro-preview": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    verified: false,
    lastVerified: "2026-07-31",
  },
  "gemini-3-flash-preview+search": {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    verified: false,
    lastVerified: "2026-07-31",
  },
  "gemini-3-pro-preview+search": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    verified: false,
    lastVerified: "2026-07-31",
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

/** True when a model has a pricing entry — run validation refuses models
 * without one, so a run can never start with an unenforceable budget. */
export function hasPricing(model: string): boolean {
  return model in PRICING;
}

/**
 * Cost of a call in integer micro-dollars (µ$ = tokens × $/MTok).
 *
 * An unknown model THROWS. The old behavior — return 0 — silently disabled
 * every budget cap downstream (`spent` never grew) and recorded real spend
 * as $0. Run validation checks `hasPricing` before any cell executes, so in
 * the run path this throw is a broken-invariant alarm, not a control flow.
 */
export function costMicroUsd(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const pricing = PRICING[model];
  if (!pricing) {
    throw new ClassifiedError(
      "internal",
      `No pricing entry for model "${model}". Add it to lib/ai/pricing.ts — refusing to record this call as $0, which would disable budget caps.`
    );
  }
  return Math.round(
    tokensIn * pricing.inputPerMTok +
      tokensOut * pricing.outputPerMTok +
      (pricing.perCallFeeMicroUsd ?? 0)
  );
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}
