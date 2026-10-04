/**
 * Provider preflight (2026-09-14): billing refusals map to CAPACITY_BLOCKED,
 * auth to AUTH_ERROR, transient to RETRYABLE — the qualification code
 * never sees a billing state, only a provider-agnostic one.
 */
import { describe, expect, it } from "vitest";
import {
  classifyProviderError,
  PREFLIGHT_TTL_MINUTES,
  preflightStateFor,
  probeOpenAI,
  probePerplexity,
} from "../../scripts/provider-preflight";

describe("provider preflight classification", () => {
  it("credit exhaustion and quota refusals are CAPACITY_BLOCKED (parks benchmarks, never retried in a loop)", () => {
    expect(classifyProviderError({ status: 429, message: "You have no credits remaining", code: "insufficient_quota" })).toBe("CAPACITY_BLOCKED");
    expect(classifyProviderError({ status: 401, message: "You exceeded your current quota" })).toBe("CAPACITY_BLOCKED");
    expect(classifyProviderError({ status: 402, message: "payment required" })).toBe("CAPACITY_BLOCKED");
  });
  it("a bad key is AUTH_ERROR, a missing model is MODEL_UNAVAILABLE, everything else is retryable", () => {
    expect(classifyProviderError({ status: 401, message: "Incorrect API key provided" })).toBe("AUTH_ERROR");
    expect(classifyProviderError({ status: 404, message: "The model `x` does not exist" })).toBe("MODEL_UNAVAILABLE");
    expect(classifyProviderError({ status: 503, message: "overloaded" })).toBe("RETRYABLE_ERROR");
    expect(classifyProviderError(null)).toBe("AVAILABLE");
  });
  it("caches the verdict briefly so a blocked provider is not hammered", () => {
    expect(PREFLIGHT_TTL_MINUTES).toBeGreaterThanOrEqual(15);
  });
});

describe("provider preflight probes fail closed", () => {
  const NOW = () => new Date("2026-10-03T12:00:00Z");
  const respond = (status: number, body = "") =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;
  const deps = (fetchImpl: typeof fetch, env: Record<string, string | undefined> = { OPENAI_API_KEY: "k", PERPLEXITY_API_KEY: "k" }) =>
    ({ env, fetch: fetchImpl, now: NOW });

  for (const probe of [probeOpenAI, probePerplexity]) {
    describe(probe.name, () => {
      it("a missing key is AUTH_ERROR and makes no network call", async () => {
        let called = false;
        const spy = (async () => { called = true; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
        const r = await probe(deps(spy, {}));
        expect(r.state).toBe("AUTH_ERROR");
        expect(r.reason).toMatch(/not set/);
        expect(called).toBe(false);
      });

      it("only an authenticated 2xx is AVAILABLE", async () => {
        expect((await probe(deps(respond(200, "{}")))).state).toBe("AVAILABLE");
      });

      it("401 invalid auth and 403 permission refusals are AUTH_ERROR", async () => {
        expect((await probe(deps(respond(401, "Incorrect API key provided")))).state).toBe("AUTH_ERROR");
        expect((await probe(deps(respond(403, "permission denied for this project")))).state).toBe("AUTH_ERROR");
      });

      it("402 billing and 429 quota are CAPACITY_BLOCKED", async () => {
        expect((await probe(deps(respond(402, "payment required")))).state).toBe("CAPACITY_BLOCKED");
        expect((await probe(deps(respond(429, "insufficient_quota")))).state).toBe("CAPACITY_BLOCKED");
      });

      it("a 400 that only says the 1-token output cap was hit proves auth + billing; any other 400 does not", async () => {
        const capped = respond(400, '{"error":{"message":"Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens."}}');
        expect((await probe(deps(capped))).state).toBe("AVAILABLE");
        expect((await probe(deps(respond(400, '{"error":{"message":"Unsupported parameter: max_tokens"}}')))).state).not.toBe("AVAILABLE");
        expect((await probe(deps(respond(400, "")))).state).not.toBe("AVAILABLE");
      });

      it("server errors and network faults are not available", async () => {
        expect((await probe(deps(respond(500, "boom")))).state).toBe("RETRYABLE_ERROR");
        const offline = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
        const r = await probe(deps(offline));
        expect(r.state).toBe("RETRYABLE_ERROR");
        expect(r.state).not.toBe("AVAILABLE");
      });

      it("never reports the key in its reason", async () => {
        const r = await probe(deps(respond(401, "bad"), { OPENAI_API_KEY: "sk-secret-123", PERPLEXITY_API_KEY: "sk-secret-123" }));
        expect(JSON.stringify(r)).not.toContain("sk-secret-123");
      });
    });
  }

  it("a non-2xx status never maps to AVAILABLE", () => {
    for (const status of [400, 401, 402, 403, 404, 408, 429, 500, 502, 503]) {
      expect(preflightStateFor(status, "")).not.toBe("AVAILABLE");
    }
  });
});
