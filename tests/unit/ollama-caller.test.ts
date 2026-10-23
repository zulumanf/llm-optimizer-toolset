/**
 * Spec 158 H4: the Ollama internal-inference caller fails closed — timeout,
 * transport, HTTP, non-JSON and empty output — and refuses an unauthenticated
 * or plain-http REMOTE host before any request is made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OLLAMA_REQUEST_TIMEOUT_MS, ollamaCaller, ollamaRequestHeaders } from "@/lib/ai/internal/ollama";

const req = { system: "s", user: "u", model: "qwen3:8b" };
const okBody = { message: { content: '{"ok":true}' }, prompt_eval_count: 3, eval_count: 4, total_duration: 2_000_000 };

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ollamaRequestHeaders", () => {
  it("allows a local host without a key", () => {
    expect(ollamaRequestHeaders("http://127.0.0.1:11434", {})).toEqual({ "content-type": "application/json" });
    expect(ollamaRequestHeaders("http://localhost:11434", {})).toEqual({ "content-type": "application/json" });
  });
  it("refuses a remote host over http, even with a key", () => {
    expect(() => ollamaRequestHeaders("http://gpu.example.com:11434", { OLLAMA_API_KEY: "k" })).toThrow(/must use https/);
  });
  it("refuses a remote https host without a key", () => {
    expect(() => ollamaRequestHeaders("https://gpu.example.com", {})).toThrow(/requires OLLAMA_API_KEY/);
  });
  it("sends the key as a bearer token to a remote https host", () => {
    expect(ollamaRequestHeaders("https://gpu.example.com", { OLLAMA_API_KEY: " k1 " })).toEqual({ "content-type": "application/json", authorization: "Bearer k1" });
  });
});

describe("ollamaCaller", () => {
  it("passes an abort signal and returns the parsed result", async () => {
    vi.stubEnv("OLLAMA_URL", "http://127.0.0.1:11434");
    const fetchFn = stubFetch(async () => new Response(JSON.stringify(okBody), { status: 200 }));
    const out = await ollamaCaller(req);
    expect(out).toMatchObject({ text: '{"ok":true}', tokensIn: 3, tokensOut: 4, durationMs: 2 });
    const init = fetchFn.mock.calls[0]![1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(OLLAMA_REQUEST_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it("refuses a remote host before making any request", async () => {
    vi.stubEnv("OLLAMA_URL", "http://gpu.example.com:11434");
    const fetchFn = stubFetch(async () => new Response("{}"));
    await expect(ollamaCaller(req)).rejects.toThrow(/must use https/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails closed on timeout with a clear message", async () => {
    vi.stubEnv("OLLAMA_URL", "http://127.0.0.1:11434");
    stubFetch(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    await expect(ollamaCaller(req)).rejects.toMatchObject({ kind: "internal", message: expect.stringMatching(/did not answer within/) });
  });

  it("fails closed on connection failure, non-JSON, HTTP error and empty output", async () => {
    vi.stubEnv("OLLAMA_URL", "http://127.0.0.1:11434");
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(ollamaCaller(req)).rejects.toMatchObject({ kind: "internal", message: expect.stringMatching(/unavailable/) });
    stubFetch(async () => new Response("<html>", { status: 502 }));
    await expect(ollamaCaller(req)).rejects.toMatchObject({ kind: "internal", message: expect.stringMatching(/non-JSON/) });
    stubFetch(async () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }));
    await expect(ollamaCaller(req)).rejects.toMatchObject({ kind: "internal", message: expect.stringMatching(/HTTP 404/) });
    stubFetch(async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 }));
    await expect(ollamaCaller(req)).rejects.toMatchObject({ kind: "provider_auth" });
    stubFetch(async () => new Response(JSON.stringify({ message: { content: "  " } }), { status: 200 }));
    await expect(ollamaCaller(req)).rejects.toMatchObject({ kind: "internal", message: expect.stringMatching(/empty/) });
  });

  it("refuses a request with no explicit model", async () => {
    await expect(ollamaCaller({ system: "s", user: "u" })).rejects.toMatchObject({ kind: "validation" });
  });
});
