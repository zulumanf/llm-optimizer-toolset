/**
 * Scoring v1.2 (spec 151 A2–A6), pure. Given one run's included answers and
 * current mention rows, produce:
 *
 *  - `estimates`: one row per (company, metric, INSTRUMENT) with numerator,
 *    denominator, distinct prompts, Wilson and prompt-clustered intervals.
 *    Never blended across instruments.
 *  - `compat`: rows for the legacy `scores` table. A provider-level row is
 *    written only when that provider ran exactly one instrument (so it IS
 *    that instrument); 'all' is the unweighted mean across instruments and
 *    is the only labelled aggregate.
 *
 * Changes vs v1.1 (docs/06 changelog):
 *  1. per-instrument grouping (provider + requested model + location + sampling);
 *  2. echo exclusion in the ESTIMATES (organic scope) — an answer to a
 *     prompt that names the company is not organic visibility for it. The
 *     compatibility `scores` rows keep the v1.1 all-answers scope;
 *  3. share-of-voice denominator restricted to the frozen cohort when one
 *     exists;
 *  4. owned citations re-derived at score time with the dot-boundary rule.
 */
import type { Sentiment } from "@/lib/constants";
import { instrumentKey, samplingOf } from "@/lib/ai/served-model";
import { domainBelongsTo, textNamesTerm, urlDomain } from "@/lib/parsing/prepass";
import {
  computeProviderMetrics,
  authorityScore,
  aggregateAcrossProviders,
  type MetricValues,
  type ScoredMetric,
} from "@/lib/scoring/metrics";
import { estimateIcc, estimateRate, seedFromKey, type Cluster } from "@/lib/stats";

export interface EstimateResponse {
  id: string;
  provider: string;
  model: string;
  promptId: string;
  promptText: string;
  requestParams: unknown;
  servedModel: string | null;
  /** Any citation at all on the answer (in-text or provider search). */
  hasAnyCitation: boolean;
}

export interface EstimateMention {
  responseId: string;
  companyId: string;
  mentioned: boolean;
  recommended: boolean;
  listPosition: number | null;
  sentiment: Sentiment | null;
  citedUrls: string[];
}

export interface EstimateCompany {
  id: string;
  name: string;
  aliases: string[];
  domain: string | null;
}

/** Rate metrics that carry intervals. Binary per answer → binomial. */
export const ESTIMATED_RATE_METRICS = [
  "mention_rate",
  "recommendation_rate",
  "first_position_rate",
  "top_three_rate",
  "owned_citation_rate",
] as const;
export type EstimatedRateMetric = (typeof ESTIMATED_RATE_METRICS)[number];

export interface EstimateRow {
  companyId: string;
  metric: EstimatedRateMetric | "share_of_voice";
  provider: string;
  model: string;
  instrumentKey: string;
  servedModels: string[];
  numerator: number;
  denominator: number;
  distinctPrompts: number;
  excludedEcho: number;
  rate: number | null;
  wilson: readonly [number, number] | null;
  clustered: readonly [number, number] | null;
  icc: number | null;
}

export interface CompatRow {
  companyId: string;
  metric: string;
  provider: string;
  value: number;
  sampleSize: number;
}

export interface InstrumentGroup {
  key: string;
  provider: string;
  model: string;
  responses: EstimateResponse[];
}

export function groupByInstrument(responses: EstimateResponse[]): InstrumentGroup[] {
  const groups = new Map<string, InstrumentGroup>();
  for (const r of responses) {
    const key = instrumentKey({
      provider: r.provider,
      model: r.model,
      sampling: samplingOf(r.requestParams),
    });
    let g = groups.get(key);
    if (!g) {
      g = { key, provider: r.provider, model: r.model, responses: [] };
      groups.set(key, g);
    }
    g.responses.push(r);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function promptNamesCompany(promptText: string, company: EstimateCompany): boolean {
  return [company.name, ...company.aliases].some((t) => textNamesTerm(promptText, t));
}

function ownedCitation(m: EstimateMention, company: EstimateCompany): boolean {
  return Boolean(company.domain) && m.citedUrls.some((u) => domainBelongsTo(urlDomain(u), company.domain));
}

function clustersFor(responses: EstimateResponse[], hit: (r: EstimateResponse) => boolean): Cluster[] {
  const byPrompt = new Map<string, Cluster>();
  for (const r of responses) {
    const c = byPrompt.get(r.promptId) ?? { k: 0, n: 0 };
    c.n += 1;
    if (hit(r)) c.k += 1;
    byPrompt.set(r.promptId, c);
  }
  return [...byPrompt.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => c);
}

export interface ComputeEstimatesInput {
  runId: string;
  responses: EstimateResponse[];
  mentions: EstimateMention[];
  /** Companies to score (cohort ∩ project companies, or project companies). */
  companies: EstimateCompany[];
}

export function computeEstimates(input: ComputeEstimatesInput): {
  estimates: EstimateRow[];
  compat: CompatRow[];
  instruments: InstrumentGroup[];
} {
  const { runId, responses, companies } = input;
  const scoredIds = new Set(companies.map((c) => c.id));
  const mentions = input.mentions.filter((m) => m.mentioned && scoredIds.has(m.companyId));
  const mentionsByResponse = new Map<string, EstimateMention[]>();
  for (const m of mentions) {
    const list = mentionsByResponse.get(m.responseId) ?? [];
    list.push(m);
    mentionsByResponse.set(m.responseId, list);
  }

  const instruments = groupByInstrument(responses);
  const estimates: EstimateRow[] = [];
  const compat: CompatRow[] = [];
  const instrumentsPerProvider = new Map<string, number>();
  for (const g of instruments) {
    instrumentsPerProvider.set(g.provider, (instrumentsPerProvider.get(g.provider) ?? 0) + 1);
  }

  for (const company of companies) {
    const perInstrumentValues: MetricValues[] = [];
    const perInstrumentAuthority: (number | null)[] = [];
    let answerTotal = 0;

    for (const g of instruments) {
      const organic = g.responses.filter((r) => !promptNamesCompany(r.promptText, company));
      const excludedEcho = g.responses.length - organic.length;
      answerTotal += g.responses.length;
      const own = (r: EstimateResponse) =>
        (mentionsByResponse.get(r.id) ?? []).find((m) => m.companyId === company.id) ?? null;
      const servedModels = [
        ...new Set(g.responses.map((r) => r.servedModel).filter((s): s is string => Boolean(s))),
      ].sort();

      const hitters: Record<EstimatedRateMetric, (r: EstimateResponse) => boolean> = {
        mention_rate: (r) => own(r) !== null,
        recommendation_rate: (r) => own(r)?.recommended === true,
        first_position_rate: (r) => own(r)?.listPosition === 1,
        top_three_rate: (r) => {
          const p = own(r)?.listPosition;
          return p !== null && p !== undefined && p <= 3;
        },
        owned_citation_rate: (r) => {
          const m = own(r);
          return m !== null && ownedCitation(m, company);
        },
      };
      const iccBase = clustersFor(organic, hitters.mention_rate);
      for (const metric of ESTIMATED_RATE_METRICS) {
        const clusters = clustersFor(organic, hitters[metric]);
        const est = estimateRate(clusters, seedFromKey(`${runId}|${company.id}|${metric}|${g.key}`));
        estimates.push({
          companyId: company.id,
          metric,
          provider: g.provider,
          model: g.model,
          instrumentKey: g.key,
          servedModels,
          numerator: est.k,
          denominator: est.n,
          distinctPrompts: est.prompts,
          excludedEcho,
          rate: est.rate,
          wilson: est.wilson,
          clustered: est.clustered,
          icc: metric === "mention_rate" ? estimateIcc(iccBase) : null,
        });
      }

      // Share of voice inside the scored universe, organic answers only.
      let companyMentions = 0;
      let totalMentions = 0;
      for (const r of organic) {
        const list = mentionsByResponse.get(r.id) ?? [];
        totalMentions += new Set(list.map((m) => m.companyId)).size;
        if (list.some((m) => m.companyId === company.id)) companyMentions += 1;
      }
      estimates.push({
        companyId: company.id,
        metric: "share_of_voice",
        provider: g.provider,
        model: g.model,
        instrumentKey: g.key,
        servedModels,
        numerator: companyMentions,
        denominator: totalMentions,
        distinctPrompts: new Set(organic.map((r) => r.promptId)).size,
        excludedEcho,
        rate: totalMentions > 0 ? companyMentions / totalMentions : null,
        wilson: null,
        clustered: null,
        icc: null,
      });

      // Legacy metric values for this instrument (docs/06 formulas) over ALL
      // valid answers — the v1.1 answer scope, kept so the compatibility
      // table means what its readers assume. Echo exclusion lives in the
      // estimates above (organic scope), never silently in both.
      const allOwn = g.responses.map(own).filter((m): m is EstimateMention => m !== null);
      let allCompanyMentions = 0;
      let allTotalMentions = 0;
      for (const r of g.responses) {
        const list = mentionsByResponse.get(r.id) ?? [];
        allTotalMentions += new Set(list.map((m) => m.companyId)).size;
        if (list.some((m) => m.companyId === company.id)) allCompanyMentions += 1;
      }
      const values = computeProviderMetrics({
        n: g.responses.length,
        mentionedResponses: allOwn.length,
        recommendedResponses: allOwn.filter((m) => m.recommended).length,
        companyMentions: allCompanyMentions,
        totalTrackedMentions: allTotalMentions,
        listPositions: allOwn.map((m) => m.listPosition).filter((p): p is number => p !== null),
        firstPositionResponses: allOwn.filter((m) => m.listPosition === 1).length,
        topThreeResponses: allOwn.filter((m) => m.listPosition !== null && m.listPosition <= 3).length,
        sentiments: allOwn.map((m) => m.sentiment).filter((s): s is Sentiment => s !== null),
        citedResponses: allOwn.filter((m) => ownedCitation(m, company)).length,
        responsesWithAnyCitation: g.responses.filter((r) => r.hasAnyCitation).length,
      });
      const authority = authorityScore(values);
      perInstrumentValues.push(values);
      perInstrumentAuthority.push(authority);

      // A provider row only when it is unambiguously one instrument.
      if (instrumentsPerProvider.get(g.provider) === 1) {
        for (const [metric, value] of Object.entries(values)) {
          if (value === null || value === undefined) continue;
          compat.push({ companyId: company.id, metric, provider: g.provider, value, sampleSize: g.responses.length });
        }
        if (authority !== null) {
          compat.push({
            companyId: company.id,
            metric: "authority_score",
            provider: g.provider,
            value: authority,
            sampleSize: g.responses.length,
          });
        }
      }
    }

    const metricKeys = new Set(perInstrumentValues.flatMap((v) => Object.keys(v)));
    for (const metric of metricKeys) {
      const aggregate = aggregateAcrossProviders(perInstrumentValues.map((v) => v[metric as ScoredMetric]));
      if (aggregate !== null) {
        compat.push({ companyId: company.id, metric, provider: "all", value: aggregate, sampleSize: answerTotal });
      }
    }
    const aggregateAuthority = aggregateAcrossProviders(perInstrumentAuthority);
    if (aggregateAuthority !== null) {
      compat.push({
        companyId: company.id,
        metric: "authority_score",
        provider: "all",
        value: aggregateAuthority,
        sampleSize: answerTotal,
      });
    }
  }
  return { estimates, compat, instruments };
}
