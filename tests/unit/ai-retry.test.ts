import { describe, expect, it, vi } from "vitest";
import { classifyProviderError, withRetry } from "@/lib/ai/retry";
import { ClassifiedError } from "@/lib/errors";

const httpError = (status: number, message = "err") =>
  Object.assign(new Error(message), { status });

describe("classifyProviderError", () => {
  it("classifies 429 as retryable rate limit and honors retry-after", () => {
    const err = Object.assign(new Error("slow down"), {
      status: 429,
      headers: { "retry-after": "7" },
    });
    const classified = classifyProviderError(err);
    expect(classified.kind).toBe("provider_rate_limit");
    expect(classified.retryable).toBe(true);
    expect(classified.retryAfterMs).toBe(7000);
  });

  it("classifies 401/403 as terminal auth errors", () => {
    expect(classifyProviderError(httpError(401)).retryable).toBe(false);
    expect(classifyProviderError(httpError(403)).kind).toBe("provider_auth");
  });

  it("classifies other 4xx as terminal validation", () => {
    const classified = classifyProviderError(httpError(400));
    expect(classified.kind).toBe("validation");
    expect(classified.retryable).toBe(false);
  });

  it("classifies 5xx and unknown errors as retryable internal", () => {
    expect(classifyProviderError(httpError(503)).retryable).toBe(true);
    expect(classifyProviderError(new Error("socket hang up")).retryable).toBe(true);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, { sleepFn: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors up to 3 attempts, then throws classified", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(503, "unavailable"));
    await expect(withRetry(fn, { sleepFn: noSleep })).rejects.toMatchObject({
      kind: "internal",
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("recovers when a later attempt succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue("recovered");
    await expect(withRetry(fn, { sleepFn: noSleep })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fails fast on terminal errors without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(401, "bad key"));
    const promise = withRetry(fn, { sleepFn: noSleep });
    await expect(promise).rejects.toBeInstanceOf(ClassifiedError);
    await expect(
      withRetry(fn, { sleepFn: noSleep })
    ).rejects.toMatchObject({ kind: "provider_auth" });
    expect(fn).toHaveBeenCalledTimes(2); // one call per withRetry invocation
  });
});
