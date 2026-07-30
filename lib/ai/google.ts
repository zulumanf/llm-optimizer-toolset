import { GoogleGenAI } from "@google/genai";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";
import { parseGooglePayload } from "@/lib/ai/payloads";

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
  ],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
    const response = await getClient().models.generateContent({
      model: req.model,
      contents: req.promptText,
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
