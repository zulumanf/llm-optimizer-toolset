/**
 * Provider payload parsers — pure, testable, no SDK and no network.
 *
 * Extracted from the four `lib/ai/*` adapters so `docs/09` can be satisfied:
 * *"each `lib/ai/` adapter parses current known payload shapes; unknown shape →
 * captured raw + flagged, never silently dropped."* While the parsing lived
 * inline inside `runPrompt`, the only way to exercise it was to call a real
 * provider, so it was never tested.
 *
 * The second half of that rule needed a code change, not just a test. Every
 * parser now returns `shapeRecognized`. Before this, a payload whose shape we
 * did not understand produced `responseText: ""` — indistinguishable from a
 * model that genuinely answered with nothing. One is a parser bug we must fix;
 * the other is a real measurement. Conflating them means a provider changing
 * its response format shows up as a silent run of empty answers.
 *
 * `rawPayload` is stored verbatim by the caller either way (PRINCIPLES #3), so
 * an unrecognised shape is always recoverable by re-parsing later.
 */

export interface ParsedPayload {
  responseText: string;
  /** Provider declined to answer — a valid measurement, never retried. */
  refusal: boolean;
  tokensIn: number;
  tokensOut: number;
  /**
   * False when the payload did not match any shape this parser knows. The
   * caller must surface it rather than treating the empty text as an answer.
   */
  shapeRecognized: boolean;
  /** Why the shape was not recognised, for the operator who has to fix it. */
  shapeNote?: string;
}

function unrecognized(note: string): ParsedPayload {
  return {
    responseText: "",
    refusal: false,
    tokensIn: 0,
    tokensOut: 0,
    shapeRecognized: false,
    shapeNote: note,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function intField(source: unknown, key: string): number {
  if (!isRecord(source)) return 0;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ------------------------------------------------- OpenAI / Perplexity chat

interface ChatChoice {
  message?: { content?: string | null; refusal?: string | null };
  finish_reason?: string;
}

/**
 * The OpenAI-compatible chat-completions shape, shared by the OpenAI and
 * Perplexity adapters (Perplexity serves the same contract).
 */
export function parseChatCompletion(payload: unknown): ParsedPayload {
  if (!isRecord(payload)) return unrecognized("payload is not an object");
  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return unrecognized("no `choices` array — not a chat-completions payload");
  }
  if (choices.length === 0) {
    // A well-formed envelope with no choices is a recognised shape carrying no
    // answer. That is a real (if unusual) measurement, not a parser failure.
    return {
      responseText: "",
      refusal: false,
      tokensIn: intField(payload.usage, "prompt_tokens"),
      tokensOut: intField(payload.usage, "completion_tokens"),
      shapeRecognized: true,
    };
  }

  const choice = choices[0] as ChatChoice;
  const content = choice?.message?.content;
  if (content !== undefined && content !== null && typeof content !== "string") {
    return unrecognized("`choices[0].message.content` is neither string nor null");
  }

  return {
    responseText: content ?? "",
    refusal:
      Boolean(choice?.message?.refusal) || choice?.finish_reason === "content_filter",
    tokensIn: intField(payload.usage, "prompt_tokens"),
    tokensOut: intField(payload.usage, "completion_tokens"),
    shapeRecognized: true,
  };
}

// ----------------------------------------------------- OpenAI Responses API

interface ResponsesItem {
  type?: string;
  content?: { type?: string; text?: string }[];
}

/**
 * The Responses API shape used by search-enabled models. Text lives in
 * `output[].content[]` entries of type `output_text`; the array also carries
 * tool-call items which are not text and must not be concatenated in.
 */
export function parseResponsesPayload(payload: unknown): ParsedPayload {
  if (!isRecord(payload)) return unrecognized("payload is not an object");
  const output = payload.output;
  if (!Array.isArray(output)) {
    return unrecognized("no `output` array — not a Responses API payload");
  }

  const messages = (output as ResponsesItem[]).filter((item) => item?.type === "message");
  const text = messages
    .flatMap((item) => item.content ?? [])
    .filter((block) => block?.type === "output_text")
    .map((block) => block.text ?? "")
    .join("\n");

  // Output items exist but none is a message: the model returned only tool
  // calls. Recognised, and genuinely empty of text.
  return {
    responseText: text,
    refusal: false,
    tokensIn: intField(payload.usage, "input_tokens"),
    tokensOut: intField(payload.usage, "output_tokens"),
    shapeRecognized: true,
  };
}

// ------------------------------------------------------------------ Anthropic

interface AnthropicBlock {
  type?: string;
  text?: string;
}

/** The Messages API shape: text blocks plus a `stop_reason`. */
export function parseAnthropicMessage(payload: unknown): ParsedPayload {
  if (!isRecord(payload)) return unrecognized("payload is not an object");
  const content = payload.content;
  if (!Array.isArray(content)) {
    return unrecognized("no `content` array — not a Messages API payload");
  }

  const text = (content as AnthropicBlock[])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

  return {
    responseText: text,
    refusal: payload.stop_reason === "refusal",
    tokensIn: intField(payload.usage, "input_tokens"),
    tokensOut: intField(payload.usage, "output_tokens"),
    shapeRecognized: true,
  };
}

// --------------------------------------------------------------------- Google

interface GoogleCandidate {
  content?: { parts?: { text?: string }[] };
}

/**
 * The Gemini `generateContent` shape. The SDK exposes a convenience `.text`
 * getter, but that is a property of the SDK object rather than of the stored
 * payload — so this reads `candidates[].content.parts[].text`, which is what
 * survives in `raw_payload` and what a re-parse would have to work from.
 */
export function parseGooglePayload(payload: unknown): ParsedPayload {
  if (!isRecord(payload)) return unrecognized("payload is not an object");

  const blockReason = isRecord(payload.promptFeedback)
    ? payload.promptFeedback.blockReason
    : undefined;
  const refusal = blockReason !== undefined && blockReason !== null;

  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) {
    // A blocked prompt legitimately carries feedback and no candidates.
    if (refusal) {
      return {
        responseText: "",
        refusal: true,
        tokensIn: intField(payload.usageMetadata, "promptTokenCount"),
        tokensOut: intField(payload.usageMetadata, "candidatesTokenCount"),
        shapeRecognized: true,
      };
    }
    return unrecognized("no `candidates` array and no block reason");
  }

  const text = (candidates as GoogleCandidate[])
    .flatMap((candidate) => candidate?.content?.parts ?? [])
    .map((part) => part?.text ?? "")
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    responseText: text,
    refusal,
    tokensIn: intField(payload.usageMetadata, "promptTokenCount"),
    tokensOut: intField(payload.usageMetadata, "candidatesTokenCount"),
    shapeRecognized: true,
  };
}

