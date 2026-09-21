/**
 * OpenAI backend for INTERNAL inference.
 *
 * Benchmark measurement remains in lib/ai/openai.ts.
 * This adapter exists only for work performed FOR the platform.
 */
import OpenAI from "openai";
import { ClassifiedError } from "@/lib/errors";
import type {
  InternalInferenceCaller,
  InternalInferenceResult,
} from "@/lib/ai/internal-inference";

let client: OpenAI | undefined;

export const openaiInternalCaller: InternalInferenceCaller = async ({
  system,
  user,
  model,
}): Promise<InternalInferenceResult> => {
  if (!model || model.trim().length === 0) {
    throw new ClassifiedError(
      "validation",
      "OpenAI internal inference requires an explicit model."
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new ClassifiedError(
      "provider_auth",
      "OPENAI_API_KEY is not configured — OpenAI internal inference needs it."
    );
  }

  if (!client) {
    client = new OpenAI({ maxRetries: 1 });
  }

  const started = Date.now();

  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return {
    text: response.choices[0]?.message?.content ?? "",
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - started,
  };
};
