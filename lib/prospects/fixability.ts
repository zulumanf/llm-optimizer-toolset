/**
 * Fixability (spec 039): how realistically this prospect's AI-visibility gap
 * can be closed, 0–100, across six categories — derived on read, every point
 * traceable to a signal, an assessment answer, or benchmark data.
 *
 * Honesty rules:
 * - A category the platform has no data for is "not measured": it drops out
 *   of the raw score's denominator AND lowers data confidence. Unknown is
 *   never scored as bad — or as good.
 * - Raw, confidence, and adjusted (= raw × confidence) are all exposed;
 *   the UI shows the three separately.
 * - Hard flags downgrade and explain, never delete. reputation_concern
 *   additionally recommends human review.
 */
import { classifySource, type SourceType } from "@/lib/sources/classify";
import { PROVENANCE_FACTORS } from "@/lib/prospects/authority";
import type {
  AssessmentItem,
  AssessmentValue,
  AuthoritySignalKind,
  ProvenanceLabel,
} from "@/lib/prospects/constants";

export const FIXABILITY_VERSION = "fixability-v1";

/** Source types a real-estate team can realistically get onto: claimable
 * profiles and open platforms — not editorial news or government records. */
export const ATTAINABLE_SOURCE_TYPES: readonly SourceType[] = [
  "portal",
  "directory",
  "review",
  "social",
  "video",
];

/** Valuable-visibility score at or above which the gap is already closed. */
export const DOMINANT_VISIBILITY_THRESHOLD = 70;
/** Benchmark recommendation rate at or above which a rival is dominant. */
export const DOMINANT_RIVAL_THRESHOLD = 0.5;
/** Organic cells below this make benchmark-derived numbers shaky. */
export const MIN_ORGANIC_SAMPLE = 6;
/** Attainable citation share below this means the source landscape is shut. */
export const UNOBTAINABLE_SHARE_THRESHOLD = 0.2;

export interface FixabilitySignal {
  id: string;
  kind: AuthoritySignalKind;
  provenance: ProvenanceLabel;
  scope: "local" | "global";
  label: string;
  sourceUrl: string | null;
}

export interface FixabilityInputs {
  /** From the spec-038 authority profile; null = not measured. */
  authorityScore: number | null;
  /** From spec-038 valuable visibility; null = no linked benchmark. */
  visibilityScore: number | null;
  organicResponses: number | null;
  signals: FixabilitySignal[];
  /** Cited domains of the linked run; null = no benchmark. */
  citedDomains: { domain: string; citations: number }[] | null;
  /** Benchmark recommendation rates of rival companies; null = no benchmark. */
  rivalRecommendationRates: number[] | null;
  /** Spec 060: counts from the citation-opportunity pipeline, evidence only —
   * the point formula is fixability-v1 and changes only with a version bump. */
  citationOpportunities?: { identified: number; obtainable: number } | null;
  assessments: Partial<Record<AssessmentItem, AssessmentValue>>;
  hasPrimaryContactWithEmail: boolean;
}

export interface FixabilityCategory {
  key: string;
  label: string;
  points: number;
  /** Category ceiling per the rubric. */
  maxPoints: number;
  /** Ceiling actually measurable from the data on hand (≤ maxPoints). */
  measuredMax: number;
  measured: boolean;
  evidence: string[];
}

export interface FixabilityFlag {
  flag: string;
  explanation: string;
}

export interface FixabilityProfile {
  version: typeof FIXABILITY_VERSION;
  raw: number | null;
  confidence: number | null;
  adjusted: number | null;
  categories: FixabilityCategory[];
  flags: FixabilityFlag[];
  needsReview: boolean;
}

const WEBSITE_ITEMS: readonly AssessmentItem[] = [
  "website_indexable",
  "has_dedicated_website",
  "services_markets_clear",
  "credentials_visible",
  "neighborhood_content",
  "structured_data_consistent",
];
const ABILITY_ITEMS: readonly AssessmentItem[] = [
  "website_control",
  "content_publishing_access",
  "marketing_resources",
  "can_obtain_reviews",
];

/** Evidence-availability sub-rubric: points per evidence family, taken at the
 * best provenance among URL-backed signals of that family. */
const EVIDENCE_FAMILIES: { label: string; kinds: AuthoritySignalKind[]; points: number }[] = [
  {
    label: "Verified transaction evidence",
    kinds: ["transaction_volume", "transaction_count", "avg_deal_value"],
    points: 5,
  },
  { label: "Notable deals", kinds: ["notable_sale", "notable_listing"], points: 3 },
  { label: "Review footprint", kinds: ["review_footprint"], points: 3 },
  { label: "Market insights", kinds: ["market_report"], points: 2 },
  { label: "Awards & recognition", kinds: ["award", "ranking"], points: 2 },
];

export function fixabilityProfile(inputs: FixabilityInputs): FixabilityProfile {
  const categories: FixabilityCategory[] = [];

  // 1. Existing authority (20) — proportional to the spec-038 score.
  {
    const measured = inputs.authorityScore !== null;
    categories.push({
      key: "existing_authority",
      label: "Existing authority",
      points: measured ? ((inputs.authorityScore as number) / 100) * 20 : 0,
      maxPoints: 20,
      measuredMax: measured ? 20 : 0,
      measured,
      evidence: measured
        ? [`Authority score ${Math.round(inputs.authorityScore as number)}/100 (authority-v1)`]
        : ["No authority signals recorded."],
    });
  }

  // 2. Website readiness (20) — equal split over ANSWERED items only.
  {
    const perItem = 20 / WEBSITE_ITEMS.length;
    const answered = WEBSITE_ITEMS.filter(
      (item) => inputs.assessments[item] === "yes" || inputs.assessments[item] === "no"
    );
    const yes = answered.filter((item) => inputs.assessments[item] === "yes");
    categories.push({
      key: "website_readiness",
      label: "Website readiness",
      points: yes.length * perItem,
      maxPoints: 20,
      measuredMax: answered.length * perItem,
      measured: answered.length > 0,
      evidence:
        answered.length > 0
          ? answered.map((item) => `${item.replaceAll("_", " ")}: ${inputs.assessments[item]}`)
          : ["No website assessment recorded."],
    });
  }

  // 3. Evidence availability (15) — URL-backed signals by family, provenance-factored.
  {
    const measured = inputs.signals.length > 0;
    let points = 0;
    const evidence: string[] = [];
    if (measured) {
      for (const family of EVIDENCE_FAMILIES) {
        const backed = inputs.signals.filter(
          (s) => family.kinds.includes(s.kind) && s.sourceUrl !== null
        );
        if (backed.length === 0) continue;
        const factor = Math.max(...backed.map((s) => PROVENANCE_FACTORS[s.provenance]));
        points += family.points * factor;
        evidence.push(`${family.label}: ${backed.length} source-linked signal(s)`);
      }
      if (evidence.length === 0) evidence.push("Signals exist but none carry a source URL.");
    } else {
      evidence.push("No signals recorded.");
    }
    categories.push({
      key: "evidence_availability",
      label: "Evidence availability",
      points,
      maxPoints: 15,
      measuredMax: measured ? 15 : 0,
      measured,
      evidence,
    });
  }

  // 4. Third-party opportunity (20) — attainable share of the run's citations.
  let attainableShare: number | null = null;
  {
    const total = inputs.citedDomains?.reduce((a, d) => a + d.citations, 0) ?? 0;
    const measured = inputs.citedDomains !== null && total > 0;
    let points = 0;
    const evidence: string[] = [];
    if (measured) {
      const attainable = inputs
        .citedDomains!.filter((d) =>
          ATTAINABLE_SOURCE_TYPES.includes(
            classifySource(d.domain, { subjectDomain: null, competitorDomains: [] }).sourceType
          )
        )
        .reduce((a, d) => a + d.citations, 0);
      attainableShare = attainable / total;
      points = attainableShare * 20;
      evidence.push(
        `${attainable} of ${total} citations point at attainable surfaces (portals, directories, reviews, social, video).`
      );
      const opps = inputs.citationOpportunities;
      if (opps && opps.identified > 0) {
        evidence.push(
          `${opps.identified} citation source(s) identified in the acquisition pipeline, ${opps.obtainable} qualified as realistically obtainable.`
        );
      }
    } else {
      evidence.push(
        inputs.citedDomains === null
          ? "No benchmark linked."
          : "The linked run's answers cited no sources."
      );
    }
    categories.push({
      key: "third_party_opportunity",
      label: "Third-party opportunity",
      points,
      maxPoints: 20,
      measuredMax: measured ? 20 : 0,
      measured,
      evidence,
    });
  }

  // 5. Competitive difficulty (15) — fewer dominant rivals = more attainable.
  {
    const measured = inputs.rivalRecommendationRates !== null;
    let points = 0;
    const evidence: string[] = [];
    if (measured) {
      const dominant = inputs.rivalRecommendationRates!.filter(
        (r) => r >= DOMINANT_RIVAL_THRESHOLD
      ).length;
      points = 15 * Math.max(0, 1 - dominant / 3);
      evidence.push(
        `${dominant} rival(s) recommended in ≥ ${DOMINANT_RIVAL_THRESHOLD * 100}% of benchmark answers.`
      );
    } else {
      evidence.push("No benchmark linked.");
    }
    categories.push({
      key: "competitive_difficulty",
      label: "Competitive difficulty",
      points,
      maxPoints: 15,
      measuredMax: measured ? 15 : 0,
      measured,
      evidence,
    });
  }

  // 6. Ability to implement (10) — 4 assessment items + reachable decision-maker.
  {
    const answered = ABILITY_ITEMS.filter(
      (item) => inputs.assessments[item] === "yes" || inputs.assessments[item] === "no"
    );
    const yes = answered.filter((item) => inputs.assessments[item] === "yes");
    // The decision-maker sub-item is always measurable: contacts either
    // exist in the platform or they don't.
    const points = yes.length * 2 + (inputs.hasPrimaryContactWithEmail ? 2 : 0);
    const measuredMax = answered.length * 2 + 2;
    categories.push({
      key: "ability_to_implement",
      label: "Ability to implement",
      points,
      maxPoints: 10,
      measuredMax,
      measured: true,
      evidence: [
        ...answered.map((item) => `${item.replaceAll("_", " ")}: ${inputs.assessments[item]}`),
        inputs.hasPrimaryContactWithEmail
          ? "Primary contact with email on record."
          : "No primary contact with an email.",
      ],
    });
  }

  const measuredMaxTotal = categories.reduce((a, c) => a + c.measuredMax, 0);
  const pointsTotal = categories.reduce((a, c) => a + c.points, 0);
  const raw = measuredMaxTotal > 0 ? (100 * pointsTotal) / measuredMaxTotal : null;

  // Confidence: coverage of the rubric + provenance quality of contributing
  // URL-backed signals (1 when none contribute — coverage still governs).
  let confidence: number | null = null;
  if (raw !== null) {
    const urlBacked = inputs.signals.filter((s) => s.sourceUrl !== null);
    const meanProvenance =
      urlBacked.length > 0
        ? urlBacked.reduce((a, s) => a + PROVENANCE_FACTORS[s.provenance], 0) / urlBacked.length
        : 1;
    confidence = 0.6 * (measuredMaxTotal / 100) + 0.4 * meanProvenance;
  }
  const adjusted = raw !== null && confidence !== null ? raw * confidence : null;

  // Hard flags — downgrade and explain, never delete.
  const flags: FixabilityFlag[] = [];
  const localSignals = inputs.signals.filter((s) => s.scope === "local");
  const credible = inputs.signals.filter(
    (s) =>
      (s.provenance === "verified" || s.provenance === "publicly_sourced") &&
      s.sourceUrl !== null
  );
  if (inputs.signals.length > 0 && credible.length === 0) {
    flags.push({
      flag: "unverifiable_authority",
      explanation:
        "Authority signals exist but none are verified or publicly sourced with a URL — the authority story cannot be defended in outreach.",
    });
  }
  if (localSignals.length === 0) {
    flags.push({
      flag: "no_local_evidence",
      explanation: "No local-scope evidence recorded — local authority cannot be substantiated.",
    });
  }
  if (
    inputs.visibilityScore !== null &&
    inputs.visibilityScore >= DOMINANT_VISIBILITY_THRESHOLD
  ) {
    flags.push({
      flag: "already_dominant",
      explanation: `Valuable visibility is ${Math.round(inputs.visibilityScore)}/100 — there is no meaningful gap to fix.`,
    });
  }
  if (inputs.organicResponses !== null && inputs.organicResponses < MIN_ORGANIC_SAMPLE) {
    flags.push({
      flag: "insufficient_sample",
      explanation: `Only ${inputs.organicResponses} organic responses — benchmark-derived numbers are unstable below ${MIN_ORGANIC_SAMPLE}.`,
    });
  }
  if (inputs.assessments.website_control === "no") {
    flags.push({
      flag: "restrictive_website_control",
      explanation: "The prospect does not control their website — on-site fixes need a third party.",
    });
  }
  if (attainableShare !== null && attainableShare < UNOBTAINABLE_SHARE_THRESHOLD) {
    flags.push({
      flag: "unobtainable_sources",
      explanation: `Only ${Math.round(attainableShare * 100)}% of cited sources are realistically attainable — the retrieval path runs through closed surfaces.`,
    });
  }
  const reputationConcern = inputs.assessments.reputation_concern === "yes";
  if (reputationConcern) {
    flags.push({
      flag: "reputation_concern",
      explanation:
        "An operator recorded a material reputation concern — hold for human review before outreach.",
    });
  }

  return {
    version: FIXABILITY_VERSION,
    raw,
    confidence,
    adjusted,
    categories,
    flags,
    needsReview: reputationConcern,
  };
}
