/**
 * docs/09 — provider response-shape tests.
 *
 * "Each `lib/ai/` adapter parses current known payload shapes; unknown shape →
 * captured raw + flagged, never silently dropped."
 *
 * The second clause is the one worth testing hardest: an empty `responseText`
 * from a recognised shape is a real measurement, and an empty `responseText`
 * from an unrecognised shape is a parser bug. If the tests cannot tell those
 * apart, neither can an operator reading a run.
 */
import { describe, expect, it } from "vitest";
import {
  parseAnthropicMessage,
  parseChatCompletion,
  parseGooglePayload,
  parseResponsesPayload,
} from "@/lib/ai/payloads";
import * as fx from "../fixtures/provider-payloads";

describe("OpenAI / Perplexity chat completions", () => {
  it("extracts text, tokens and a clean finish", () => {
    const parsed = parseChatCompletion(fx.openaiChat);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.responseText).toContain("JC Luxury Group");
    expect(parsed.refusal).toBe(false);
    expect(parsed.tokensIn).toBe(42);
    expect(parsed.tokensOut).toBe(21);
  });

  it("reads a refusal from message.refusal with null content", () => {
    const parsed = parseChatCompletion(fx.openaiRefusal);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.refusal).toBe(true);
    // A refusal is a measurement, so the empty text is correct, not a failure.
    expect(parsed.responseText).toBe("");
  });

  it("reads a refusal from a content_filter finish reason", () => {
    const parsed = parseChatCompletion(fx.openaiContentFilter);
    expect(parsed.refusal).toBe(true);
    expect(parsed.shapeRecognized).toBe(true);
  });

  it("treats a well-formed envelope with no choices as recognised and empty", () => {
    const parsed = parseChatCompletion({ choices: [], usage: { prompt_tokens: 5 } });
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.responseText).toBe("");
    expect(parsed.tokensIn).toBe(5);
  });

  it("flags a payload with no choices array", () => {
    const parsed = parseChatCompletion(fx.unknownEnvelope);
    expect(parsed.shapeRecognized).toBe(false);
    expect(parsed.shapeNote).toContain("choices");
  });

  it("flags structured content instead of coercing it to a string", () => {
    // "[object Object]" in a captured answer would silently corrupt every
    // downstream mention count.
    const parsed = parseChatCompletion(fx.openaiStructuredContent);
    expect(parsed.shapeRecognized).toBe(false);
    expect(parsed.responseText).toBe("");
  });

  it("flags non-object payloads", () => {
    for (const input of [null, undefined, "text", 42, []]) {
      const parsed = parseChatCompletion(input);
      // An array has no `choices`, so it is unrecognised too.
      expect(parsed.shapeRecognized, JSON.stringify(input)).toBe(false);
    }
  });

  it("defaults missing usage to zero rather than NaN", () => {
    const parsed = parseChatCompletion({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });
    expect(parsed.tokensIn).toBe(0);
    expect(parsed.tokensOut).toBe(0);
    expect(Number.isNaN(parsed.tokensIn)).toBe(false);
  });
});

describe("OpenAI Responses API (search-enabled)", () => {
  it("joins output_text blocks and ignores tool calls", () => {
    const parsed = parseResponsesPayload(fx.openaiResponses);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.responseText).toBe(
      "JC Luxury Group is cited by two Jersey City market reports."
    );
    // The web_search_call item must not leak into the captured answer.
    expect(parsed.responseText).not.toContain("web_search");
    expect(parsed.tokensIn).toBe(88);
    expect(parsed.tokensOut).toBe(34);
  });

  it("treats a tool-call-only response as recognised and empty", () => {
    const parsed = parseResponsesPayload(fx.openaiResponsesToolOnly);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.responseText).toBe("");
  });

  it("flags a payload with no output array", () => {
    const parsed = parseResponsesPayload(fx.openaiChat);
    expect(parsed.shapeRecognized).toBe(false);
    expect(parsed.shapeNote).toContain("output");
  });
});

describe("Anthropic messages", () => {
  it("joins text blocks and reads usage", () => {
    const parsed = parseAnthropicMessage(fx.anthropicMessage);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.responseText).toBe(
      "Two firms come up repeatedly for the Jersey City waterfront:\nJC Luxury Group and Harbor Point Partners."
    );
    expect(parsed.tokensIn).toBe(51);
    expect(parsed.tokensOut).toBe(29);
    expect(parsed.refusal).toBe(false);
  });

  it("excludes thinking blocks from the captured answer", () => {
    const parsed = parseAnthropicMessage(fx.anthropicWithThinking);
    expect(parsed.responseText).toBe(
      "JC Luxury Group operates on the Jersey City waterfront."
    );
    expect(parsed.responseText).not.toContain("The user is asking");
  });

  it("reads a refusal stop_reason as a measurement, not an error", () => {
    const parsed = parseAnthropicMessage(fx.anthropicRefusal);
    expect(parsed.refusal).toBe(true);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.responseText).toBe("");
  });

  it("flags a payload with no content array", () => {
    const parsed = parseAnthropicMessage(fx.unknownEnvelope);
    expect(parsed.shapeRecognized).toBe(false);
    expect(parsed.shapeNote).toContain("content");
  });
});

describe("Google generateContent", () => {
  it("reads text from candidates[].content.parts[]", () => {
    const parsed = parseGooglePayload(fx.googleGenerate);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.responseText).toBe(
      "JC Luxury Group is active in Jersey City and Hoboken."
    );
    expect(parsed.tokensIn).toBe(33);
    expect(parsed.tokensOut).toBe(17);
  });

  it("reads a blocked prompt as a refusal even with no candidates", () => {
    const parsed = parseGooglePayload(fx.googleBlocked);
    expect(parsed.shapeRecognized).toBe(true);
    expect(parsed.refusal).toBe(true);
    expect(parsed.responseText).toBe("");
  });

  it("flags a payload with neither candidates nor a block reason", () => {
    const parsed = parseGooglePayload(fx.unknownEnvelope);
    expect(parsed.shapeRecognized).toBe(false);
    expect(parsed.shapeNote).toContain("candidates");
  });

  it("joins multiple parts across candidates", () => {
    const parsed = parseGooglePayload({
      candidates: [{ content: { parts: [{ text: "one" }, { text: "two" }] } }],
      usageMetadata: {},
    });
    expect(parsed.responseText).toBe("one\ntwo");
  });
});

describe("the shape flag is what separates a bug from a measurement", () => {
  it("distinguishes an empty answer from an unparseable payload", () => {
    // Both produce responseText: "". Only one is a real measurement.
    const realEmpty = parseChatCompletion({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
      usage: {},
    });
    const brokenParse = parseChatCompletion(fx.unknownEnvelope);

    expect(realEmpty.responseText).toBe(brokenParse.responseText);
    expect(realEmpty.shapeRecognized).toBe(true);
    expect(brokenParse.shapeRecognized).toBe(false);
  });

  it("never reports tokens from a shape it could not read", () => {
    const parsed = parseChatCompletion(fx.unknownEnvelope);
    expect(parsed.tokensIn).toBe(0);
    expect(parsed.tokensOut).toBe(0);
  });
});
