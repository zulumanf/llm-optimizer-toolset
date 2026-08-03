/**
 * Quota exhaustion vs rate limiting, and search-grounded model ids.
 *
 * Both come from the same failed run. A Gemini run fired 40 cells, hit a
 * per-minute limit, then a daily quota, and the executor treated every 429 the
 * same way — so it worked through 20 more cells that could not possibly
 * succeed. And no non-OpenAI provider could return citations at all, which is
 * the half of a measurement that says where to intervene.
 */
import { describe, expect, it } from "vitest";
import { classifyProviderError, isQuotaExhausted } from "@/lib/ai/retry";
import { googleProvider } from "@/lib/ai/google";
import { anthropicProvider } from "@/lib/ai/anthropic";
import { openaiProvider } from "@/lib/ai/openai";

describe("quota exhaustion is not a rate limit", () => {
  /** The verbatim body Gemini returned during the failed run. */
  const REAL_GEMINI_QUOTA =
    "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits";

  it("recognises the error that actually burned a run", () => {
    expect(isQuotaExhausted(REAL_GEMINI_QUOTA)).toBe(true);
  });

  it("still treats a short Retry-After as a rate limit", () => {
    // A provider that tells us when to come back is throttling, not refusing —
    // even when the prose mentions quota.
    expect(isQuotaExhausted(REAL_GEMINI_QUOTA, 5_000)).toBe(false);
  });

  it("classifies a spent quota as terminal, not retryable", () => {
    const err = Object.assign(new Error(REAL_GEMINI_QUOTA), { status: 429 });
    const classified = classifyProviderError(err);
    expect(classified.kind).toBe("provider_quota_exhausted");
    // Retrying a spent daily quota just spends wall-clock and looks like flake.
    expect(classified.retryable).toBe(false);
  });

  it("leaves an ordinary rate limit retryable", () => {
    const err = Object.assign(new Error("Rate limit reached for requests"), { status: 429 });
    const classified = classifyProviderError(err);
    expect(classified.kind).toBe("provider_rate_limit");
    expect(classified.retryable).toBe(true);
  });

  it("recognises the other providers' phrasing", () => {
    expect(isQuotaExhausted("You exceeded your current quota (insufficient_quota)")).toBe(true);
    expect(isQuotaExhausted("Your credit balance is too low to access the API")).toBe(true);
    expect(isQuotaExhausted("Daily limit reached for this model")).toBe(true);
  });

  it("does not mistake an unrelated 429 for a spent quota", () => {
    const err = Object.assign(new Error("Too many concurrent requests"), { status: 429 });
    expect(classifyProviderError(err).kind).toBe("provider_rate_limit");
  });

  /** The verbatim body OpenAI returned during the failed 2026-08-03 run —
   * a creditless account, sent WITH a Retry-After header. */
  const REAL_OPENAI_NO_CREDITS =
    "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";

  it("billing exhaustion beats a Retry-After header — waiting does not refill an account", () => {
    expect(isQuotaExhausted(REAL_OPENAI_NO_CREDITS)).toBe(true);
    expect(isQuotaExhausted(REAL_OPENAI_NO_CREDITS, 5_000)).toBe(true);
    expect(isQuotaExhausted("(credit_balance_exhausted)", 1_000)).toBe(true);
    expect(isQuotaExhausted("insufficient_quota for this org", 1_000)).toBe(true);
  });
});

describe("search-grounded models are distinct instruments", () => {
  it("offers a grounded variant for every provider that supports one", () => {
    for (const provider of [openaiProvider, googleProvider, anthropicProvider]) {
      const grounded = provider.models.filter((m) => m.id.endsWith("+search"));
      expect(grounded.length, provider.id).toBeGreaterThan(0);
    }
  });

  it("keeps the grounded id distinct from the plain one", () => {
    // A run records the model id it used. If grounding were a flag rather than
    // an id, two runs with different retrieval would be indistinguishable
    // afterwards (docs/07).
    for (const provider of [openaiProvider, googleProvider, anthropicProvider]) {
      const ids = new Set(provider.models.map((m) => m.id));
      for (const model of provider.models) {
        if (!model.id.endsWith("+search")) continue;
        const base = model.id.replace("+search", "");
        expect(ids.has(base), `${model.id} needs its ungrounded counterpart`).toBe(true);
        expect(model.id).not.toBe(base);
      }
    }
  });

  it("labels grounded variants so an operator can tell them apart", () => {
    for (const provider of [openaiProvider, googleProvider, anthropicProvider]) {
      for (const model of provider.models.filter((m) => m.id.endsWith("+search"))) {
        expect(model.label.toLowerCase(), model.id).toMatch(/search/);
      }
    }
  });
});
