/**
 * The connector registry: capability → adapter resolution.
 *
 * Mirrors `lib/ai/registry.ts` deliberately, so this codebase has one
 * integration idiom rather than two.
 */
import type { Connector, ConnectorCapability, ConnectorStatus } from "@/lib/connectors/types";
import { ClassifiedError } from "@/lib/errors";
import {
  csvConnector,
  fixtureConnector,
  internalNotificationConnector,
  localFileStoreConnector,
  manualConnector,
} from "@/lib/connectors/adapters/internal";
import {
  ga4Connector,
  gmailConnector,
  googleCalendarConnector,
  searchConsoleConnector,
} from "@/lib/connectors/adapters/google";
import {
  followUpBossConnector,
  hubspotConnector,
  salesforceConnector,
} from "@/lib/connectors/adapters/crm";
import {
  slackConnector,
  stripeConnector,
  webflowConnector,
  wordpressConnector,
} from "@/lib/connectors/adapters/business";

const CONNECTORS: Connector<never>[] = [
  fixtureConnector,
  csvConnector,
  manualConnector,
  internalNotificationConnector,
  localFileStoreConnector,
  ga4Connector,
  searchConsoleConnector,
  gmailConnector,
  googleCalendarConnector,
  hubspotConnector,
  followUpBossConnector,
  salesforceConnector,
  stripeConnector,
  wordpressConnector,
  webflowConnector,
  slackConnector,
] as unknown as Connector<never>[];

const BY_PROVIDER = new Map(CONNECTORS.map((connector) => [connector.provider, connector]));

export function listConnectors(): Connector<never>[] {
  return [...CONNECTORS];
}

export function getConnector(provider: string): Connector<never> {
  const connector = BY_PROVIDER.get(provider);
  if (!connector) {
    throw new ClassifiedError(
      "not_found",
      `No connector adapter for provider "${provider}". Registered: ${[...BY_PROVIDER.keys()].join(", ")}.`
    );
  }
  return connector;
}

export function hasConnector(provider: string): boolean {
  return BY_PROVIDER.has(provider);
}

/** Every provider that implements a capability, best status first. */
export function providersFor(capability: ConnectorCapability): string[] {
  const rank: Record<ConnectorStatus, number> = {
    verified: 0,
    implemented_unverified: 1,
    contract_only: 2,
  };
  return CONNECTORS.filter((c) => c.capabilities.includes(capability))
    .sort((a, b) => rank[a.status] - rank[b.status])
    .map((c) => c.provider);
}

/**
 * Honest counts for the UI. `verified` is the only number that means "we have
 * run this"; the others are stated separately rather than summed into a single
 * reassuring total.
 */
export function connectorStatusCounts(): Record<ConnectorStatus, number> {
  const counts: Record<ConnectorStatus, number> = {
    verified: 0,
    implemented_unverified: 0,
    contract_only: 0,
  };
  for (const connector of CONNECTORS) counts[connector.status] += 1;
  return counts;
}

/** Capabilities no registered adapter implements — an honest coverage gap. */
export function unsupportedCapabilities(all: readonly ConnectorCapability[]): ConnectorCapability[] {
  return all.filter((capability) => providersFor(capability).length === 0);
}
