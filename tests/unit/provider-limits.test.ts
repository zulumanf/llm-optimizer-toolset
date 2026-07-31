/**
 * Per-provider rate limiting.
 *
 * The bug these pin: a 40-prompt Gemini run failed all 40 cells in six seconds.
 * The key was valid; the free tier allows five requests per minute and the
 * executor fired four at a time with no pacing. In the runs list that is
 * indistinguishable from a provider outage.
 */
import { describe, expect, it, vi } from "vitest";
import {
  concurrencyFor,
  createRateGate,
  limitsFor,
  PROVIDER_LIMITS,
} from "@/lib/ai/limits";

describe("declared limits", () => {
  it("paces Google under its documented free-tier quota", () => {
    // The API reported "limit: 5" per minute per model. 13s ≈ 4.6/min.
    const google = limitsFor("google");
    expect(google.concurrency).toBe(1);
    expect(60_000 / google.minIntervalMs).toBeLessThan(5);
  });

  it("does not throttle providers with no observed constraint", () => {
    expect(limitsFor("openai").minIntervalMs).toBe(0);
    expect(limitsFor("mock").minIntervalMs).toBe(0);
  });

  it("falls back safely for an unknown provider", () => {
    const unknown = limitsFor("some-new-provider");
    expect(unknown.concurrency).toBeGreaterThan(0);
    expect(unknown.minIntervalMs).toBe(0);
  });

  it("explains every limit, so a guess is distinguishable from a measurement", () => {
    for (const [provider, limits] of Object.entries(PROVIDER_LIMITS)) {
      expect(limits.note, provider).toBeTruthy();
    }
  });
});

describe("effective concurrency", () => {
  it("is bounded by the strictest provider in the run", () => {
    // A mixed run must not run four-wide because OpenAI could.
    expect(concurrencyFor(["openai", "google"], 4)).toBe(1);
    expect(concurrencyFor(["openai"], 4)).toBe(4);
  });

  it("never drops below one, whatever the ceiling", () => {
    expect(concurrencyFor(["google"], 0)).toBe(1);
  });

  it("uses the ceiling when a run has no providers yet", () => {
    expect(concurrencyFor([], 4)).toBe(4);
  });
});

describe("the rate gate", () => {
  it("does not delay a provider with no interval", async () => {
    const gate = createRateGate();
    const started = Date.now();
    await gate("openai");
    await gate("openai");
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("spaces successive calls for a rate-limited provider", async () => {
    vi.useFakeTimers();
    try {
      const gate = createRateGate();
      await gate("google"); // first is immediate
      const second = gate("google");
      let settled = false;
      void second.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false); // still waiting out the interval

      await vi.advanceTimersByTimeAsync(13_000);
      await second;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues concurrent callers instead of letting them share one slot", async () => {
    // The actual failure mode: every worker read the same timestamp, decided it
    // was free, and fired simultaneously.
    vi.useFakeTimers();
    try {
      const gate = createRateGate();
      const order: number[] = [];
      const calls = [0, 1, 2].map((i) =>
        gate("google").then(() => order.push(i))
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([0]);

      await vi.advanceTimersByTimeAsync(13_000);
      expect(order).toEqual([0, 1]);

      await vi.advanceTimersByTimeAsync(13_000);
      await Promise.all(calls);
      expect(order).toEqual([0, 1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps each provider on its own clock", async () => {
    vi.useFakeTimers();
    try {
      const gate = createRateGate();
      await gate("google");
      // OpenAI must not inherit Google's backoff.
      let openaiDone = false;
      void gate("openai").then(() => {
        openaiDone = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(openaiDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
