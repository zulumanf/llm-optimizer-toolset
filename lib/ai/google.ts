import { GoogleGenAI } from "@google/genai";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";
import { parseGooglePayload } from "@/lib/ai/payloads";

/**
 * Search-grounded model ids carry this suffix, matching the convention the
 * OpenAI adapter established. Grounding changes what the model can see, so it
 * is a different instrument, not a different setting.
 */
const SEARCH_SUFFIX = "+search";

function isSearchModel(modelId: string): boolean {
  return modelId.endsWith(SEARCH_SUFFIX);
}

/** The underlying model id for a grounded variant. */
export function baseModelId(modelId: string): string {
  return isSearchModel(modelId) ? modelId.slice(0, -SEARCH_SUFFIX.length) : modelId;
}

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (!client) {
    if (!process.env.GOOGLE_API_KEY) {
      throw Object.assign(new Error("GOOGLE_API_KEY is not configured"), {
        status: 401,
      });
    }
    client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  }
  return client;
}

export const googleProvider: AIProvider = {
  id: "google",
  // Model ids VERIFIED BY CALLING THEM, 2026-07-30 — not by reading the model
  // list, which is not the same test. `gemini-2.5-flash` and `gemini-2.5-pro`
  // both appear in /v1beta/models on this account and both return
  // 404 "no longer available to new users" on generateContent. A run pinned to
  // a listed-but-uncallable model fails every cell and looks like an outage.
  //
  // Preview ids are unavoidable here: they are what this account can call. They
  // are NOT dated snapshots, so a Gemini run is less reproducible than an
  // OpenAI one (docs/12) — stated rather than papered over.
  //
  // NOTE: this adapter calls generateContent WITHOUT search grounding, so it
  // is the counterpart of a no-search OpenAI run, not of a +search one. It
  // returns no citations, and a run using it cannot answer "which sources did
  // the model read".
  models: [
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", provider: "google" },
    { id: "gemini-3-pro-preview", label: "Gemini 3 Pro (preview)", provider: "google" },
    // Search-grounded variants. A grounded run is a DIFFERENT instrument from
    // an ungrounded one (docs/07), so it gets a distinct model id rather than
    // a flag — a run records which id it used, and comparability depends on
    // that being unambiguous.
    {
      id: `gemini-3-flash-preview${SEARCH_SUFFIX}`,
      label: "Gemini 3 Flash + Google Search",
      provider: "google",
    },
    {
      id: `gemini-3-pro-preview${SEARCH_SUFFIX}`,
      label: "Gemini 3 Pro + Google Search",
      provider: "google",
    },
  ],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
    const grounded = isSearchModel(req.model);
    const response = await getClient().models.generateContent({
      model: baseModelId(req.model),
      contents: req.promptText,
      ...(grounded
        ? { config: { tools: [{ googleSearch: {} }] } }
        : {}),
    });

    // Serialised first: the SDK object exposes `.text` as a getter that does
    // not survive storage, so the parser must read what `raw_payload` will
    // actually hold — otherwise re-parsing captured evidence later sees
    // nothing. Parsing lives in lib/ai/payloads.ts so it is testable without a
    // network call, and an unrecognised shape is flagged rather than silently
    // becoming an empty answer (docs/09).
    const payload = JSON.parse(JSON.stringify(response));
    return { rawPayload: payload, ...parseGooglePayload(payload) };
  },
};
