/**
 * Prospect-source registry (spec 041). Mirrors lib/ai/registry: adapters are
 * looked up by id, and the mock is refused outside tests unless a development
 * environment explicitly opts in — fixtures must never masquerade as market
 * research in production.
 */
import { ClassifiedError } from "@/lib/errors";
import { mockProviderAllowed } from "@/lib/ai/registry";
import { mockProspectSource } from "@/lib/prospects/providers/mock";
import { perplexityProspectSource } from "@/lib/prospects/providers/perplexity";
import type { ProspectSourceAdapter } from "@/lib/prospects/providers/types";

const ADAPTERS: Record<string, ProspectSourceAdapter> = {
  mock: mockProspectSource,
  perplexity: perplexityProspectSource,
};

export const PROSPECT_SOURCE_IDS = Object.keys(ADAPTERS);

/** Test seam (docs/09: tests never touch the network): swap an adapter for
 * one with an injected fake transport. Never used in production code. */
const overrides: Record<string, ProspectSourceAdapter> = {};
export function setProspectSourceForTests(
  id: string,
  adapter: ProspectSourceAdapter | null
): void {
  if (adapter) overrides[id] = adapter;
  else delete overrides[id];
}

export function getProspectSource(id: string): ProspectSourceAdapter {
  const adapter = overrides[id] ?? ADAPTERS[id];
  if (!adapter) {
    throw new ClassifiedError("not_found", `Unknown prospect source "${id}".`);
  }
  if (id === "mock" && !mockProviderAllowed()) {
    throw new ClassifiedError(
      "validation",
      "The mock prospect source is disabled outside tests. Configure a real data provider, or set ALLOW_MOCK_PROVIDER=1 in a development environment that explicitly wants fixture prospects."
    );
  }
  return adapter;
}
