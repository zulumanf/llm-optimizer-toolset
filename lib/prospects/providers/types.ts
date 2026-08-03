/**
 * Prospect source adapters (spec 041). The contract every discovery provider
 * implements — licensed data feeds, permitted directories, search results —
 * so no single vendor is ever "the" provider. Adapter output is wrapped in a
 * SourceRecord envelope; it lands as review candidates, never directly as
 * prospects.
 */
import type { ProvenanceLabel, ProspectType } from "@/lib/prospects/constants";

export interface RawProspect {
  businessName: string;
  prospectType?: ProspectType;
  teamLeader?: string;
  brokerageAffiliation?: string;
  website?: string;
  email?: string;
  phone?: string;
  neighborhoods?: string[];
  specialties?: string[];
  priceSegment?: string;
}

/** The provenance envelope on every imported fact (target pipeline). */
export interface SourceRecord<T> {
  data: T;
  provider: string;
  sourceType: string;
  sourceUrl?: string;
  /** ISO timestamp of retrieval. */
  retrievedAt: string;
  /** Adapter's 0–1 confidence in the record as a whole. */
  confidence: number;
  /** How the platform should label facts from this record. */
  provenance: ProvenanceLabel;
}

export interface ProspectDiscoveryInput {
  marketName: string;
  segment?: string;
  limit?: number;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

export interface ProspectSourceAdapter {
  readonly id: string;
  discoverProspects(input: ProspectDiscoveryInput): Promise<SourceRecord<RawProspect>[]>;
  validateConfiguration(): Promise<ProviderHealth>;
}
