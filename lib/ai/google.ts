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
  // Model ids pinned 2026-07-27 — UNVERIFIED (post-knowledge-cutoff drift
  // possible); confirm against Google's model list before the first real run
  models: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google" },
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
