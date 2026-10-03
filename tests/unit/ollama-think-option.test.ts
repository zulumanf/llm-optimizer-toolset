/**
 * Spec 146A — the optional reasoning-mode switch is inert unless a caller sets
 * it: every existing internal request body is unchanged. Timings are reported,
 * never invented, and tooling's response schema is the one runAgent sends.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ollamaCaller } from "@/lib/ai/internal/ollama";
import { responseSchemaFor, runAgent } from "@/lib/ai/agent";
import type { InternalInferenceRequest } from "@/lib/ai/internal-inference";

vi.mock("@/lib/ai/ledger", () => ({ recordLlmCall: async () => undefined }));

function stubFetch() {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { content: '{"ok":true}' } }), { status: 200 });
    })
  );
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollamaCaller think option", () => {
  it("omits think entirely when not set", async () => {
    const bodies = stubFetch();
    await ollamaCaller({ system: "s", user: "u", model: "qwen3:30b" });
    expect(bodies[0]).not.toHaveProperty("think");
    expect(bodies[0]).toEqual({
      model: "qwen3:30b",
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      options: { temperature: 0 },
    });
  });

  it("sends think only when a caller sets it", async () => {
    const bodies = stubFetch();
    await ollamaCaller({ system: "s", user: "u", model: "qwen3:30b", think: false });
    expect(bodies[0]!.think).toBe(false);
  });
});

describe("ollamaCaller timings", () => {
  it("reports the backend's timing breakdown without changing the result text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: { content: '{"ok":true}', thinking: "abcde" },
            prompt_eval_count: 900,
            eval_count: 120,
            total_duration: 25_400_000_000,
            load_duration: 150_000_000,
            prompt_eval_duration: 2_000_000_000,
            eval_duration: 23_000_000_000,
          }),
          { status: 200 }
        )
      )
    );
    const result = await ollamaCaller({ system: "s", user: "u", model: "qwen3:30b" });
    expect(result).toEqual({
      text: '{"ok":true}',
      tokensIn: 900,
      tokensOut: 120,
      durationMs: 25_400,
      timings: { loadMs: 150, promptEvalMs: 2_000, generationMs: 23_000, reasoningChars: 5 },
    });
  });

  it("leaves absent timings undefined rather than inventing them", async () => {
    stubFetch();
    const result = await ollamaCaller({ system: "s", user: "u", model: "qwen3:30b" });
    expect(result.durationMs).toBeUndefined();
    expect(result.timings).toEqual({
      loadMs: undefined,
      promptEvalMs: undefined,
      generationMs: undefined,
      reasoningChars: 0,
    });
  });
});

describe("responseSchemaFor", () => {
  it("is the schema runAgent sends", async () => {
    const schema = z.object({ ok: z.boolean() });
    const seen: InternalInferenceRequest[] = [];
    await runAgent({
      agentVersion: "t-v1",
      system: "s",
      user: "u",
      schema,
      model: "m",
      backend: "ollama",
      caller: async (req) => {
        seen.push(req);
        return { text: '{"ok":true}', tokensIn: 1, tokensOut: 1 };
      },
    });
    expect(seen[0]!.responseSchema).toEqual(responseSchemaFor(schema));
  });
});

describe("runAgent think forwarding", () => {
  const schema = z.object({ ok: z.boolean() });

  it("does not pass think to the caller unless set", async () => {
    const seen: InternalInferenceRequest[] = [];
    const caller = async (req: InternalInferenceRequest) => {
      seen.push(req);
      return { text: '{"ok":true}', tokensIn: 1, tokensOut: 1 };
    };
    await runAgent({ agentVersion: "t-v1", system: "s", user: "u", schema, model: "m", backend: "ollama", caller });
    expect(seen[0]).not.toHaveProperty("think");

    await runAgent({ agentVersion: "t-v1", system: "s", user: "u", schema, model: "m", backend: "ollama", caller, think: false });
    expect(seen[1]!.think).toBe(false);
  });
});
