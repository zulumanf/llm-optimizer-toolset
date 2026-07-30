/**
 * Recorded provider payload shapes (docs/09: "provider response-shape tests").
 *
 * These are the envelopes each provider actually returns, trimmed to the
 * fields the adapters read and sanitised of account identifiers. They are
 * fixtures, not mocks of our own code: when a provider changes its format, the
 * fix is to add the new shape here alongside the old one, so the parser keeps
 * handling both and a historical `raw_payload` stays re-parseable.
 *
 * The `unknown*` fixtures exist to prove the *other* half of the rule — a
 * shape we do not recognise must be flagged, never read as an empty answer.
 */

// ---------------------------------------------------- OpenAI chat completions

export const openaiChat = {
  id: "chatcmpl-fixture",
  object: "chat.completion",
  model: "gpt-5.4-2026-03-05",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content:
          "For Jersey City waterfront condos, Northvale Demo Group and Harbor Point Partners are frequently recommended.",
        refusal: null,
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 42, completion_tokens: 21, total_tokens: 63 },
};

/** A refusal expressed through `message.refusal` rather than finish_reason. */
export const openaiRefusal = {
  id: "chatcmpl-refusal",
  object: "chat.completion",
  model: "gpt-5.4-2026-03-05",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null, refusal: "I can't help with that." },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 30, completion_tokens: 0, total_tokens: 30 },
};

/** A refusal expressed through the content filter instead. */
export const openaiContentFilter = {
  id: "chatcmpl-filtered",
  object: "chat.completion",
  choices: [
    { index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 0 },
};

// ------------------------------------------------------ OpenAI Responses API

export const openaiResponses = {
  id: "resp-fixture",
  object: "response",
  model: "gpt-5.4-2026-03-05",
  output: [
    // A tool call precedes the message and carries no text — concatenating it
    // in would corrupt the captured answer.
    { type: "web_search_call", id: "ws_1", status: "completed" },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Northvale Demo Group is cited by two Jersey City market reports.",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/jc-market-report",
              title: "Jersey City market report",
            },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 88, output_tokens: 34 },
};

/** Search ran but produced only tool calls — recognised, genuinely no text. */
export const openaiResponsesToolOnly = {
  id: "resp-tools-only",
  object: "response",
  output: [{ type: "web_search_call", id: "ws_1", status: "completed" }],
  usage: { input_tokens: 40, output_tokens: 0 },
};

// ------------------------------------------------------------------ Anthropic

export const anthropicMessage = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [
    { type: "text", text: "Two firms come up repeatedly for the Jersey City waterfront:" },
    { type: "text", text: "Northvale Demo Group and Harbor Point Partners." },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 51, output_tokens: 29 },
};

export const anthropicRefusal = {
  id: "msg_refusal",
  type: "message",
  role: "assistant",
  content: [],
  stop_reason: "refusal",
  usage: { input_tokens: 18, output_tokens: 0 },
};

/** Thinking blocks are not text and must not be concatenated into the answer. */
export const anthropicWithThinking = {
  id: "msg_thinking",
  type: "message",
  role: "assistant",
  content: [
    { type: "thinking", thinking: "The user is asking about Jersey City brokerages." },
    { type: "text", text: "Northvale Demo Group operates on the Jersey City waterfront." },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 60, output_tokens: 40 },
};

// --------------------------------------------------------------------- Google

export const googleGenerate = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ text: "Northvale Demo Group is active in Jersey City and Hoboken." }],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: { promptTokenCount: 33, candidatesTokenCount: 17, totalTokenCount: 50 },
};

/** A blocked prompt: feedback present, no candidates. Recognised, a refusal. */
export const googleBlocked = {
  promptFeedback: { blockReason: "SAFETY" },
  usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 0 },
};

// ------------------------------------------------------------ unknown shapes

/** What a provider migration looks like: a valid JSON envelope we don't know. */
export const unknownEnvelope = {
  id: "resp-v3",
  object: "response.v3",
  result: { message: { body: "the format changed underneath us" } },
  usage: { input: 10, output: 5 },
};

/** Content of an unexpected type — must not be coerced into a string. */
export const openaiStructuredContent = {
  id: "chatcmpl-structured",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: [{ type: "text", text: "blocks, not a string" }] },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
};
