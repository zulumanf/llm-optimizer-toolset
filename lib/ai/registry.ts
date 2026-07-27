import type { AIProvider, ModelInfo, ProviderId } from "@/lib/ai/types";
import { anthropicProvider } from "@/lib/ai/anthropic";
import { openaiProvider } from "@/lib/ai/openai";
import { googleProvider } from "@/lib/ai/google";
import { perplexityProvider } from "@/lib/ai/perplexity";
import { mockProvider } from "@/lib/ai/mock";
import { ClassifiedError } from "@/lib/errors";

const providers: Record<ProviderId, AIProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  perplexity: perplexityProvider,
  mock: mockProvider,
};

export function getProvider(id: ProviderId): AIProvider {
  const provider = providers[id];
  if (!provider) {
    throw new ClassifiedError("validation", `Unknown provider: ${id}`);
  }
  return provider;
}

export function listAllModels(): ModelInfo[] {
  return Object.values(providers).flatMap((p) => p.models);
}

export function isKnownModel(provider: ProviderId, model: string): boolean {
  return providers[provider]?.models.some((m) => m.id === model) ?? false;
}
