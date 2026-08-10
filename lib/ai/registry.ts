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

function truthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/**
 * The mock provider fabricates answers. If one of its canned strings ever
 * reached `responses`, the parser would score it like a measurement and
 * nothing downstream could tell the difference — the exact failure
 * PRINCIPLES.md forbids ("never fabricate results"). So mock is opt-in:
 * the test runner gets it implicitly, everything else must say
 * ALLOW_MOCK_PROVIDER=1 out loud (the local-only seed script does).
 */
export function mockProviderAllowed(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    truthyEnv(process.env.VITEST) ||
    truthyEnv(process.env.ALLOW_MOCK_PROVIDER)
  );
}

/**
 * May mock captures count as MEASUREMENTS? A stricter question than
 * mockProviderAllowed — running the mock (seeds, demos) is a development
 * convenience; folding its canned answers into score rows is fabricated
 * evidence (spec 050). The two were one flag, so ALLOW_MOCK_PROVIDER=1 in a
 * deployed process quietly produced fake client metrics. Now scoring needs
 * the test runner or an explicit ALLOW_MOCK_SCORING=1, and the real-auth
 * posture (AUTH_MODE=supabase) refuses regardless of flags — no environment
 * that authenticates real users ever scores fabrications.
 */
export function mockScoringAllowed(): boolean {
  if (process.env.AUTH_MODE === "supabase") return false;
  return (
    process.env.NODE_ENV === "test" ||
    truthyEnv(process.env.VITEST) ||
    truthyEnv(process.env.ALLOW_MOCK_SCORING)
  );
}

export function getProvider(id: ProviderId): AIProvider {
  if (id === "mock" && !mockProviderAllowed()) {
    throw new ClassifiedError(
      "validation",
      "The mock provider is disabled outside tests. Configure a real provider API key, or set ALLOW_MOCK_PROVIDER=1 in a development environment that explicitly wants fabricated answers."
    );
  }
  const provider = providers[id];
  if (!provider) {
    throw new ClassifiedError("validation", `Unknown provider: ${id}`);
  }
  return provider;
}

export function listAllModels(): ModelInfo[] {
  return Object.values(providers)
    .filter((p) => p.id !== "mock" || mockProviderAllowed())
    .flatMap((p) => p.models);
}

export function isKnownModel(provider: ProviderId, model: string): boolean {
  if (provider === "mock" && !mockProviderAllowed()) return false;
  return providers[provider]?.models.some((m) => m.id === model) ?? false;
}
