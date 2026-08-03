/**
 * Prospect-source registry (spec 041). Mirrors lib/ai/registry: adapters are
 * looked up by id, and the mock is refused outside tests unless a development
 * environment explicitly opts in — fixtures must never masquerade as market
 * research in production.
 */
import { ClassifiedError } from "@/lib/errors";
import { mockProviderAllowed } from "@/lib/ai/registry";
import { mockProspectSource } from "@/lib/prospects/providers/mock";
import type { ProspectSourceAdapter } from "@/lib/prospects/providers/types";

const ADAPTERS: Record<string, ProspectSourceAdapter> = {
  mock: mockProspectSource,
};

export const PROSPECT_SOURCE_IDS = Object.keys(ADAPTERS);

export function getProspectSource(id: string): ProspectSourceAdapter {
  const adapter = ADAPTERS[id];
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
