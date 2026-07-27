/**
 * Scoring v1.0 metric math (docs/06) as pure functions over per-provider
 * inputs. Null = insufficient data / not measurable — never rendered as 0.
 */
import type { Sentiment } from "@/lib/constants";

export const AUTHORITY_WEIGHTS = {
  recommendation_rate: 0.35,
  mention_rate: 0.2,
  share_of_voice: 0.15,
  position_score: 0.15,
  citation_score: 0.1,
  sentiment_index: 0.05,
} as const;

export type ComponentMetric = keyof typeof AUTHORITY_WEIGHTS;

export const MIN_CELLS_FOR_POSITION = 5;
export const MIN_CELLS_FOR_SENTIMENT = 5;

export interface CompanyProviderInput {
  /** valid cells for this provider */
  n: number;
  mentionedResponses: number;
  recommendedResponses: number;
  /** this company's mention count (can exceed responses? no — per-response) */
  companyMentions: number;
  /** Σ mentions across all tracked companies for this provider */
  totalTrackedMentions: number;
  /** 1-indexed list positions where the company appeared in a list */
  listPositions: number[];
  /** sentiments across the company's mention cells */
  sentiments: Sentiment[];
  /** responses where this company's mention carries an owned citation */
  citedResponses: number;
  /** responses (valid) containing any citation at all */
  responsesWithAnyCitation: number;
}

export type MetricValues = Partial<Record<ComponentMetric, number | null>>;

export function computeProviderMetrics(input: CompanyProviderInput): MetricValues {
  const {
    n,
    mentionedResponses,
    recommendedResponses,
    companyMentions,
    totalTrackedMentions,
    listPositions,
    sentiments,
    citedResponses,
    responsesWithAnyCitation,
  } = input;
  if (n === 0) return {};

  const values: MetricValues = {
    mention_rate: mentionedResponses / n,
    recommendation_rate: recommendedResponses / n,
    share_of_voice:
      totalTrackedMentions > 0 ? companyMentions / totalTrackedMentions : null,
    position_score:
      listPositions.length >= MIN_CELLS_FOR_POSITION
        ? listPositions.reduce((acc, p) => acc + 1 / p, 0) / listPositions.length
        : null,
    sentiment_index:
      sentiments.length >= MIN_CELLS_FOR_SENTIMENT
        ? sentiments
            .map((s): number => (s === "positive" ? 1 : s === "negative" ? 0 : 0.5))
            .reduce((a, b) => a + b, 0) / sentiments.length
        : null,
    citation_score:
      responsesWithAnyCitation > 0
        ? citedResponses / responsesWithAnyCitation
        : null, // provider never returns citations — not measurable (docs/06)
  };
  return values;
}

/**
 * Authority score (docs/06): 100 × weighted sum of components, with the
 * weight of null components redistributed proportionally across non-null
 * ones. Null when every component is null.
 */
export function authorityScore(values: MetricValues): number | null {
  const present = (Object.keys(AUTHORITY_WEIGHTS) as ComponentMetric[]).filter(
    (metric) => values[metric] !== null && values[metric] !== undefined
  );
  if (present.length === 0) return null;
  const totalWeight = present.reduce(
    (acc, metric) => acc + AUTHORITY_WEIGHTS[metric],
    0
  );
  const weighted = present.reduce(
    (acc, metric) =>
      acc + (values[metric] as number) * (AUTHORITY_WEIGHTS[metric] / totalWeight),
    0
  );
  return 100 * weighted;
}

/** Unweighted cross-provider mean, skipping providers where the metric is null. */
export function aggregateAcrossProviders(
  perProvider: (number | null | undefined)[]
): number | null {
  const present = perProvider.filter((v): v is number => v !== null && v !== undefined);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}
