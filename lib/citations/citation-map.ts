/**
 * Citation map (spec 141): placement-level targets — one row per cited URL a
 * client could plausibly be added to — with a priority score built from
 * observed citation behaviour, not from any third-party domain-authority
 * metric. Pure functions here; persistence in `db/citation-map.ts`.
 */
import type { SourceType } from "@/lib/sources/classify";

export const CITATION_MAP_VERSION = "citation-map-v1";

export const CITATION_MAP_STATUSES = [
  "discovered",
  "qualified",
  "contact_identified",
  "pitched",
  "approved",
  "live",
  "indexed",
  "remeasured",
  "declined",
  "dropped",
] as const;
export type CitationMapStatus = (typeof CITATION_MAP_STATUSES)[number];

/** The forward pipeline; `declined`/`dropped` are exits from any stage. */
export const CITATION_MAP_PIPELINE: readonly CitationMapStatus[] = [
  "discovered",
  "qualified",
  "contact_identified",
  "pitched",
  "approved",
  "live",
  "indexed",
  "remeasured",
];

export function canTransitionCitationTarget(from: CitationMapStatus, to: CitationMapStatus): boolean {
  if (to === "declined" || to === "dropped") return from !== "remeasured";
  const i = CITATION_MAP_PIPELINE.indexOf(from);
  const j = CITATION_MAP_PIPELINE.indexOf(to);
  return i >= 0 && j === i + 1;
}

export const PAGE_TYPES = ["listicle", "guide", "news_article", "directory_listing", "profile", "forum_thread", "ranking", "other"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/** Weights sum to 1. Domain Rating is deliberately absent. */
export const CITATION_MAP_WEIGHTS = {
  citationFrequency: 0.3,
  topicRelevance: 0.2,
  competitorPresence: 0.15,
  sourceCredibility: 0.15,
  freshness: 0.1,
  contributionOpportunity: 0.1,
} as const;

/** Credibility by source class for placement purposes: independent, edited
 * sources outrank self-published ones; the client's own site is not a
 * citation opportunity at all. */
export const CREDIBILITY_BY_SOURCE_CLASS: Record<SourceType, number> = {
  news: 1,
  government: 1,
  industry_ranking: 1,
  local_press: 0.95,
  review: 0.85,
  portal: 0.8,
  directory: 0.6,
  video: 0.6,
  brokerage: 0.4,
  other: 0.5,
  social: 0.4,
  client_site: 0,
};

export const FRESHNESS_FULL_DAYS = 180;
export const FRESHNESS_FLOOR_DAYS = 3 * 365;
export const FRESHNESS_FLOOR = 0.2;
export const FRESHNESS_UNKNOWN = 0.5;
export const MS_PER_DAY = 86_400_000;

export type CitationTargetInput = {
  /** Distinct answers citing this URL's domain in the client's benchmark. */
  answersCiting: number;
  /** The most-cited domain's answer count in the same benchmark (scale). */
  maxAnswersCiting: number;
  /** 0..1, how closely the page's topic matches the client's prompts. */
  topicRelevance: number;
  /** Competitors already present on the page. */
  competitorsPresent: number;
  /** Competitors tracked for the client (scale). */
  competitorsTracked: number;
  sourceClass: SourceType;
  publicationDate: Date | null;
  /** 0..1, how natural a contribution is (open listicle, contributor page…). */
  insertability: number;
  asOf?: Date;
};

export type CitationTargetScore = {
  version: typeof CITATION_MAP_VERSION;
  score: number;
  components: Record<keyof typeof CITATION_MAP_WEIGHTS, number>;
  explanation: string[];
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function freshnessScore(publicationDate: Date | null, asOf: Date): number {
  if (!publicationDate) return FRESHNESS_UNKNOWN;
  const ageDays = (asOf.getTime() - publicationDate.getTime()) / MS_PER_DAY;
  if (ageDays <= FRESHNESS_FULL_DAYS) return 1;
  if (ageDays >= FRESHNESS_FLOOR_DAYS) return FRESHNESS_FLOOR;
  const span = FRESHNESS_FLOOR_DAYS - FRESHNESS_FULL_DAYS;
  return 1 - ((ageDays - FRESHNESS_FULL_DAYS) / span) * (1 - FRESHNESS_FLOOR);
}

export function scoreCitationTarget(input: CitationTargetInput): CitationTargetScore {
  const asOf = input.asOf ?? new Date();
  const components = {
    citationFrequency: input.maxAnswersCiting > 0 ? clamp01(input.answersCiting / input.maxAnswersCiting) : 0,
    topicRelevance: clamp01(input.topicRelevance),
    competitorPresence: input.competitorsTracked > 0 ? clamp01(input.competitorsPresent / input.competitorsTracked) : 0,
    sourceCredibility: CREDIBILITY_BY_SOURCE_CLASS[input.sourceClass],
    freshness: freshnessScore(input.publicationDate, asOf),
    contributionOpportunity: clamp01(input.insertability),
  };
  let total = 0;
  for (const [k, w] of Object.entries(CITATION_MAP_WEIGHTS)) total += w * components[k as keyof typeof components];
  const score = Math.round(total * 1000) / 10;
  const explanation = [
    `Cited in ${input.answersCiting} answers (scale ${input.maxAnswersCiting}).`,
    `${input.competitorsPresent} of ${input.competitorsTracked} tracked competitors already appear on the page.`,
    `Source class ${input.sourceClass} (credibility ${components.sourceCredibility}).`,
    input.publicationDate ? `Published ${input.publicationDate.toISOString().slice(0, 10)}.` : "Publication date unknown.",
    "No domain-authority metric is used.",
  ];
  return { version: CITATION_MAP_VERSION, score, components, explanation };
}

/** Before/after movement for a placed target; never a causal claim. */
export type PlacementMovement = {
  baselineRunId: string;
  remeasureRunId: string;
  answersCitingBefore: number;
  answersCitingAfter: number;
  clientRecommendedBefore: number;
  clientRecommendedAfter: number;
  validAnswersBefore: number;
  validAnswersAfter: number;
  comparable: boolean;
  note: string;
};
