/**
 * AI Citation Value Score (spec 060, acvs-v1). Pure functions: observed
 * citation behavior in → components, composite, and a template-generated
 * explanation out. Nothing here talks to the database or a model.
 *
 * Deliberate absence: no domain authority, no backlink counts, no SEO
 * metrics. A source matters here only because AI answers actually cite it —
 * "AI citation value ≠ backlink authority" is enforced by this module's
 * input shape, not by a comment.
 */
import { formatPercent } from "@/lib/format";
import { weightedComposite, type WeightSet } from "@/lib/scoring/weights";
import type { SourceType } from "@/lib/sources/classify";

export const ACVS_VERSION = "acvs-v1";
export const ACVS_WEIGHT_SET_NAME = "citation-acvs";

/** High-intent = prompt tiers 1–2 (migration 030 semantics). */
export const HIGH_INTENT_MAX_TIER = 2;

/** Everything observable about one third-party domain in one project. */
export interface DomainStats {
  domain: string;
  /** Non-mock responses in completed/partial runs of this project. */
  totalResponses: number;
  citingResponses: number;
  totalPrompts: number;
  citingPrompts: number;
  /** Citing responses whose prompt has a tier at all / a tier ≤ 2. */
  tieredCitingResponses: number;
  highIntentCitingResponses: number;
  totalProviders: number;
  providersCiting: number;
  totalRuns: number;
  runsCiting: number;
  /** Distinct citing answers whose current mentions recommend ANY tracked
   * company — one count, so an answer recommending both the client and a
   * rival is never counted twice. */
  answersWithRecommendation: number;
  /** Distinct non-subject companies recommended in citing answers. */
  competitorsRecommendedDistinct: number;
  /** Active non-subject companies measured for this project. */
  trackedCompetitors: number;
  /** Client found on at least one successfully checked page; null = no OK
   * check yet. Scoped to the pages actually fetched, never the whole site. */
  clientPresent: boolean | null;
  presenceChecksCount: number;
  presenceCheckedAt: Date | null;
  /** source-classifier-v1 labels, when the sources registry has the domain. */
  sourceType: string | null;
}

/** Operator-recorded acquisition facts, from the opportunity row. */
export interface AcquisitionFacts {
  acquisitionPath: string;
  acquisitionDifficulty: "easy" | "moderate" | "hard" | "unknown";
}

export interface AcvsComponents {
  citationFrequency: number | null;
  promptRelevance: number | null;
  commercialIntent: number | null;
  crossEngine: number | null;
  recommendationInfluence: number | null;
  competitorDensity: number | null;
  clientGap: number | null;
  feasibility: number | null;
  sourceQuality: number | null;
  persistence: number | null;
}

const FEASIBILITY_BY_DIFFICULTY: Record<AcquisitionFacts["acquisitionDifficulty"], number> = {
  easy: 1,
  moderate: 0.6,
  hard: 0.3,
  unknown: 0.5,
};
/** An unknown path caps feasibility — you cannot be "easy" with no plan. */
const UNKNOWN_PATH_CAP = 0.5;

/** Established third-party types score high; low-trust types score low.
 * Keyed by the SourceType union so a new classifier label fails typecheck
 * here instead of silently scoring a fabricated middle value; a stored
 * label the table doesn't know scores null (unmeasured), never 0.5. */
const QUALITY_BY_SOURCE_TYPE: Record<SourceType, number> = {
  news: 1,
  government: 1,
  industry_ranking: 1,
  local_press: 0.95,
  review: 0.9,
  portal: 0.8,
  directory: 0.6,
  video: 0.6,
  brokerage: 0.5,
  other: 0.5,
  social: 0.4,
  client_site: 0.2,
};

const ratio = (num: number, den: number): number | null =>
  den > 0 ? Math.min(1, num / den) : null;

export function componentsFromStats(
  stats: DomainStats,
  facts: AcquisitionFacts
): AcvsComponents {
  const feasibilityBase = FEASIBILITY_BY_DIFFICULTY[facts.acquisitionDifficulty];
  return {
    citationFrequency: ratio(stats.citingResponses, stats.totalResponses),
    promptRelevance: ratio(stats.citingPrompts, stats.totalPrompts),
    commercialIntent: ratio(
      stats.highIntentCitingResponses,
      stats.tieredCitingResponses
    ),
    crossEngine: ratio(stats.providersCiting, stats.totalProviders),
    recommendationInfluence: ratio(
      stats.answersWithRecommendation,
      stats.citingResponses
    ),
    competitorDensity: ratio(
      stats.competitorsRecommendedDistinct,
      stats.trackedCompetitors
    ),
    // 1 = client verifiably absent (the gap is real), 0 = already present,
    // null = never checked — unknown redistributes, it never counts as a gap.
    clientGap: stats.clientPresent === null ? null : stats.clientPresent ? 0 : 1,
    feasibility:
      facts.acquisitionPath === "unknown"
        ? Math.min(feasibilityBase, UNKNOWN_PATH_CAP)
        : feasibilityBase,
    sourceQuality:
      stats.sourceType !== null && stats.sourceType in QUALITY_BY_SOURCE_TYPE
        ? QUALITY_BY_SOURCE_TYPE[stats.sourceType as SourceType]
        : null,
    persistence: ratio(stats.runsCiting, stats.totalRuns),
  };
}

export interface AcvsResult {
  /** 0–100, one decimal; null when nothing was measurable. */
  acvs: number | null;
  components: AcvsComponents;
  /** Component names that were null and had their weight redistributed. */
  missing: string[];
  explanation: string[];
}

/** Ratio wrapper: a zero denominator is "n/a", never a division. */
const pct = (n: number, d: number): string =>
  d > 0 ? formatPercent(n / d) : "n/a";

/**
 * Explanation lines are TEMPLATES over stored numbers — never model-written,
 * and worded as observation ("cited alongside", "appears") rather than
 * causation. Tested against the workflow-gate phrase lists.
 */
export function explainComponents(
  stats: DomainStats,
  facts: AcquisitionFacts,
  components: AcvsComponents
): string[] {
  const lines: string[] = [
    `Cited in ${stats.citingResponses} of ${stats.totalResponses} answers ` +
      `(${pct(stats.citingResponses, stats.totalResponses)}) across this project's runs.`,
    `Appears for ${stats.citingPrompts} of ${stats.totalPrompts} tracked prompts, ` +
      `on ${stats.providersCiting} of ${stats.totalProviders} engines, ` +
      `in ${stats.runsCiting} of ${stats.totalRuns} runs.`,
  ];
  lines.push(
    components.commercialIntent === null
      ? "Commercial intent unmeasured: no citing answer came from a tiered prompt."
      : `${pct(stats.highIntentCitingResponses, stats.tieredCitingResponses)} of its ` +
          `tier-labeled citing answers came from high-intent prompts (tiers 1–2).`
  );
  lines.push(
    `A recommendation co-occurred with this source in ` +
      `${stats.answersWithRecommendation} ` +
      `of its ${stats.citingResponses} citing answers ` +
      `(co-occurrence in the same answer, not attribution); ` +
      `${stats.competitorsRecommendedDistinct} of ${stats.trackedCompetitors} tracked ` +
      `competitors were recommended alongside it.`
  );
  if (stats.clientPresent === null) {
    lines.push("Client presence on this source is unchecked — run a presence check.");
  } else if (stats.clientPresent) {
    lines.push(
      "The client appears on at least one checked page of this source " +
        `(${stats.presenceChecksCount} page check(s) recorded).`
    );
  } else {
    lines.push(
      `The client was not found on the ${stats.presenceChecksCount} page(s) ` +
        `checked so far — checked pages only, not the whole site.`
    );
  }
  lines.push(
    facts.acquisitionPath === "unknown"
      ? "No acquisition path recorded yet — feasibility capped until one is chosen."
      : `Acquisition path: ${facts.acquisitionPath.replace(/_/g, " ")}, ` +
          `assessed ${facts.acquisitionDifficulty}.`
  );
  lines.push(
    stats.sourceType === null
      ? "Source type unclassified — quality unmeasured for now."
      : `Source classified as ${stats.sourceType.replace(/_/g, " ")} (source-classifier).`
  );
  return lines;
}

/** Composite + explanation, weights from the active citation-acvs set. */
export function computeAcvs(
  stats: DomainStats,
  facts: AcquisitionFacts,
  weightSet: WeightSet
): AcvsResult {
  const components = componentsFromStats(stats, facts);
  const { score, missing } = weightedComposite(
    components as unknown as Record<string, number | null>,
    weightSet.weights
  );
  const explanation = explainComponents(stats, facts, components);
  if (missing.length > 0) {
    explanation.push(
      `Unmeasured components (${missing.join(", ")}) drop out; ` +
        `their weight spreads over the measured ones.`
    );
  }
  return {
    acvs: score === null ? null : Math.round(score * 1000) / 10,
    components,
    missing,
    explanation,
  };
}

// Lifecycle/taxonomy constants live in lib/citations/constants.ts (pure,
// client-safe); re-exported here so server code has one import surface.
export {
  PIPELINE_STATUSES,
  OUTCOME_STATUSES,
  EXIT_STATUSES,
  OPPORTUNITY_STATUSES,
  OBTAINABLE_STATUSES,
  ACQUISITION_PATHS,
  ACQUISITION_DIFFICULTIES,
  HIGH_INTENT_COMPONENT_THRESHOLD,
  ACVS_STRONG_THRESHOLD,
  canTransition,
  type OpportunityStatus,
  type AcquisitionPath,
  type AcquisitionDifficulty,
} from "@/lib/citations/constants";
