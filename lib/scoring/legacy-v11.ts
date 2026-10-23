/**
 * Scoring v1.1 — the LEGACY writer, kept verbatim for the cutover window
 * (release 151). Until `scoring_state.read_version` flips to v1.2, every
 * dashboard reads v1.1, so every NEW run must keep receiving v1.1 rows.
 * This is the pre-151 algorithm moved out of compute.ts unchanged:
 * provider-level grouping (models blended), the project company universe
 * (no cohort), all valid answers, owned citations as stored on mention rows.
 *
 * Retire it (scoring_state.write_legacy = false, then delete this file)
 * only after the cutover has been verified and has held.
 */
import type { Sentiment } from "@/lib/constants";
import {
  aggregateAcrossProviders,
  authorityScore,
  computeProviderMetrics,
  type MetricValues,
  type ScoredMetric,
} from "@/lib/scoring/metrics";

export const LEGACY_SCORING_VERSION = "v1.1";

export interface LegacyResponse {
  id: string;
  provider: string;
  hasAnyCitation: boolean;
}

export interface LegacyMention {
  responseId: string;
  companyId: string;
  recommended: boolean;
  listPosition: number | null;
  sentiment: Sentiment;
  citedUrls: string[];
}

export interface LegacyRow {
  companyId: string;
  metric: string;
  provider: string;
  value: number;
  sampleSize: number;
}

export function computeLegacyV11(input: {
  responses: LegacyResponse[];
  mentions: LegacyMention[];
  companyIds: string[];
}): LegacyRow[] {
  const { responses, mentions, companyIds } = input;
  const byProvider = new Map<string, Set<string>>();
  const responsesWithCitation = new Set<string>();
  for (const row of responses) {
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, new Set());
    byProvider.get(row.provider)!.add(row.id);
    if (row.hasAnyCitation) responsesWithCitation.add(row.id);
  }
  const rows: LegacyRow[] = [];
  for (const companyId of companyIds) {
    const perProviderValues: Record<string, MetricValues> = {};
    const perProviderAuthority: (number | null)[] = [];
    for (const [provider, responseIds] of byProvider) {
      const providerMentions = mentions.filter((m) => responseIds.has(m.responseId));
      const companyMentions = providerMentions.filter((m) => m.companyId === companyId);
      const mentionedResponses = new Set(companyMentions.map((m) => m.responseId));
      const values = computeProviderMetrics({
        n: responseIds.size,
        mentionedResponses: mentionedResponses.size,
        recommendedResponses: new Set(companyMentions.filter((m) => m.recommended).map((m) => m.responseId)).size,
        companyMentions: mentionedResponses.size,
        totalTrackedMentions: new Set(providerMentions.map((m) => `${m.companyId}|${m.responseId}`)).size,
        listPositions: companyMentions.map((m) => m.listPosition).filter((p): p is number => p !== null),
        firstPositionResponses: new Set(companyMentions.filter((m) => m.listPosition === 1).map((m) => m.responseId)).size,
        topThreeResponses: new Set(
          companyMentions.filter((m) => m.listPosition !== null && m.listPosition <= 3).map((m) => m.responseId)
        ).size,
        sentiments: companyMentions.map((m) => m.sentiment),
        citedResponses: new Set(companyMentions.filter((m) => m.citedUrls.length > 0).map((m) => m.responseId)).size,
        responsesWithAnyCitation: [...responseIds].filter((id) => responsesWithCitation.has(id)).length,
      });
      perProviderValues[provider] = values;
      for (const [metric, value] of Object.entries(values)) {
        if (value === null || value === undefined) continue;
        rows.push({ companyId, metric, provider, value, sampleSize: responseIds.size });
      }
      const authority = authorityScore(values);
      perProviderAuthority.push(authority);
      if (authority !== null) {
        rows.push({ companyId, metric: "authority_score", provider, value: authority, sampleSize: responseIds.size });
      }
    }
    const metricKeys = new Set<string>(Object.values(perProviderValues).flatMap((v) => Object.keys(v)));
    for (const metric of metricKeys) {
      const aggregate = aggregateAcrossProviders(Object.values(perProviderValues).map((v) => v[metric as ScoredMetric]));
      if (aggregate === null) continue;
      rows.push({ companyId, metric, provider: "all", value: aggregate, sampleSize: responses.length });
    }
    const aggregateAuthority = aggregateAcrossProviders(perProviderAuthority);
    if (aggregateAuthority !== null) {
      rows.push({ companyId, metric: "authority_score", provider: "all", value: aggregateAuthority, sampleSize: responses.length });
    }
  }
  return rows;
}
