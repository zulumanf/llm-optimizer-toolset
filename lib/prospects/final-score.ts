/**
 * The final prospect score (spec 039): a configurable-weight composite over
 * six 0–100 components, multiplied by fixability data confidence. Assembly
 * is read-only here; the service persists the result with its full breakdown
 * so the stored number always explains itself.
 */
import { sql } from "@/db/client";
import { getActiveWeightSet, weightedComposite } from "@/lib/scoring/weights";
import { authorityGapForProspect } from "@/lib/prospects/gap";
import { scoredEntities } from "@/lib/prospects/benchmark";
import {
  fixabilityProfile,
  type FixabilityProfile,
  type FixabilitySignal,
} from "@/lib/prospects/fixability";
import type {
  AssessmentItem,
  AssessmentValue,
  ProvenanceLabel,
} from "@/lib/prospects/constants";
import { buyingSignalScore } from "@/lib/prospects/buying-signals";

export const PROSPECT_SCORE_VERSION = "prospect-score-v3";
export const FINAL_WEIGHT_SET_NAME = "prospect-final";

/**
 * Priority archetype (RealTrends upgrade, 2026-08-15): VERIFIED AUTHORITY /
 * AI UNDERREPRESENTATION — independently verified production, a market the
 * assistants demonstrably answer (a rival is visible), and a prospect they
 * barely recommend. Internal-only classification; never prospect-facing.
 * The boost is a named, inspectable multiplier — not a hidden weight tweak.
 */
export const ARCHETYPE_VERIFIED_UNDERREPRESENTED = "verified_authority_underrepresented";
export const ARCHETYPE_BOOST = 1.15;
/** Recommendation share at or below which a prospect counts as underrepresented. */
export const ARCHETYPE_MAX_REC_SHARE = 0.05;
/** A rival must be at least this visible — proof the market has AI answers to win. */
export const ARCHETYPE_MIN_RIVAL_RATE = 0.15;
export const ARCHETYPE_MIN_FIXABILITY = 30;

export function detectArchetype(input: {
  hasIndependentProduction: boolean;
  prospectRecShare: number | null;
  topRivalRate: number | null;
  adjustedFixability: number | null;
}): string | null {
  if (!input.hasIndependentProduction) return null;
  if (input.prospectRecShare === null || input.prospectRecShare > ARCHETYPE_MAX_REC_SHARE)
    return null;
  if (input.topRivalRate === null || input.topRivalRate < ARCHETYPE_MIN_RIVAL_RATE)
    return null;
  if (
    input.adjustedFixability === null ||
    input.adjustedFixability < ARCHETYPE_MIN_FIXABILITY
  )
    return null;
  return ARCHETYPE_VERIFIED_UNDERREPRESENTED;
}

export interface ProspectScoreView {
  version: typeof PROSPECT_SCORE_VERSION;
  weightSet: { name: string; version: number; weights: Record<string, number> };
  /** 0–100 or null (not measured); keys match the weight set. */
  components: Record<string, number | null>;
  /** Components whose weight was redistributed. */
  missing: string[];
  fixability: FixabilityProfile;
  contactabilityFlags: string[];
  /** Composite before the confidence multiplier. */
  preConfidence: number | null;
  /** Fixability data confidence applied as the multiplier (1 when unknown). */
  dataConfidence: number;
  /** Internal priority archetype (never prospect-facing) and its applied
   * multiplier — 1 when no archetype matched. */
  archetype: string | null;
  archetypeBoost: number;
  /** The final 0–100 score; null when nothing was measurable. */
  score: number | null;
}

/** Deterministic contactability rubric (0–100). Null when no contact data
 * exists at all; 0 with a flag when the recipient is do-not-contact. */
function contactability(input: {
  prospectEmail: string | null;
  prospectDoNotContact: boolean;
  primary: {
    email: string | null;
    preferredChannel: string | null;
    provenance: string;
    doNotContact: boolean;
  } | null;
}): { score: number | null; flags: string[] } {
  if (input.primary === null && input.prospectEmail === null) {
    return { score: null, flags: [] };
  }
  if (input.prospectDoNotContact || input.primary?.doNotContact) {
    return {
      score: 0,
      flags: [
        input.prospectDoNotContact
          ? "Account is do-not-contact."
          : "Primary contact is do-not-contact.",
      ],
    };
  }
  let score = 0;
  if (input.primary) {
    score += 40;
    if (input.primary.email) score += 30;
    if (input.primary.preferredChannel) score += 10;
    if (["verified", "publicly_sourced"].includes(input.primary.provenance)) score += 20;
  } else if (input.prospectEmail) {
    score += 30; // an address on the account, but no named human
  }
  return { score, flags: [] };
}

export async function computeProspectScoreView(prospectId: string): Promise<ProspectScoreView> {
  const weightSet = await getActiveWeightSet(FINAL_WEIGHT_SET_NAME);
  const gapView = await authorityGapForProspect(prospectId);

  // Benchmark-derived inputs, when a linked scored run exists.
  let citedDomains: { domain: string; citations: number }[] | null = null;
  let rivalRates: number[] | null = null;
  let prospectRecShare: number | null = null;
  const [prospect] = await sql`
    select company_id, email, do_not_contact from prospects
    where id = ${prospectId} and archived_at is null
  `;
  if (gapView.benchmarkRunId) {
    const domains = await sql`
      select c.domain, count(*)::int as citations
      from response_citations c
      join responses r on r.id = c.response_id
      where r.run_id = ${gapView.benchmarkRunId}
      group by c.domain
    `;
    citedDomains = domains.map((d) => ({
      domain: d.domain as string,
      citations: Number(d.citations),
    }));
    const entities = await scoredEntities(gapView.benchmarkRunId);
    rivalRates = entities
      .filter((e) => e.companyId !== (prospect?.companyId as string | null))
      .map((e) => e.recommendationRate)
      .filter((r): r is number => r !== null);
    prospectRecShare =
      entities.find((e) => e.companyId === (prospect?.companyId as string | null))
        ?.recommendationRate ?? null;
  }

  const assessmentRows = await sql`
    select item, value from prospect_assessments where prospect_id = ${prospectId}
  `;
  const assessments = Object.fromEntries(
    assessmentRows.map((r) => [r.item as string, r.value as AssessmentValue])
  ) as Partial<Record<AssessmentItem, AssessmentValue>>;

  const [primary] = await sql`
    select email, preferred_channel, provenance, do_not_contact
    from prospect_contacts
    where prospect_id = ${prospectId} and is_primary and archived_at is null
  `;
  const hasPrimaryContactWithEmail = Boolean(primary?.email);

  const signalRows = await sql`
    select id, kind, provenance, scope, label, source_url, source_type
    from prospect_authority_signals where prospect_id = ${prospectId}
  `;
  const signals: FixabilitySignal[] = signalRows.map((r) => ({
    id: r.id as string,
    kind: r.kind as FixabilitySignal["kind"],
    provenance: r.provenance as FixabilitySignal["provenance"],
    scope: r.scope as "local" | "global",
    label: r.label as string,
    sourceUrl: (r.sourceUrl as string | null) ?? null,
  }));

  // Spec 060 QA fix: the citation-pipeline evidence line was unreachable —
  // this is its one production feed. Counts come from the benchmark run's
  // project; no linked run (or an empty pipeline) stays null, never zero.
  let citationOpportunities: { identified: number; obtainable: number } | null = null;
  if (gapView.benchmarkRunId) {
    const { OBTAINABLE_STATUSES } = await import("@/lib/citations/constants");
    const [oppCounts] = await sql`
      select count(*)::int as identified,
        count(*) filter (where o.status = any(${[...OBTAINABLE_STATUSES]}))::int
          as obtainable
      from citation_opportunities o
      join runs r on r.project_id = o.project_id
      where r.id = ${gapView.benchmarkRunId}
    `;
    if (oppCounts && (oppCounts.identified as number) > 0) {
      citationOpportunities = {
        identified: oppCounts.identified as number,
        obtainable: oppCounts.obtainable as number,
      };
    }
  }

  const fixability = fixabilityProfile({
    authorityScore: gapView.authority.score,
    visibilityScore: gapView.visibility?.score ?? null,
    organicResponses: gapView.visibility?.organicResponses ?? null,
    signals,
    citedDomains,
    rivalRecommendationRates: rivalRates,
    assessments,
    hasPrimaryContactWithEmail,
    citationOpportunities,
  });

  const contact = contactability({
    prospectEmail: (prospect?.email as string | null) ?? null,
    prospectDoNotContact: Boolean(prospect?.doNotContact),
    primary: primary
      ? {
          email: (primary.email as string | null) ?? null,
          preferredChannel: (primary.preferredChannel as string | null) ?? null,
          provenance: primary.provenance as string,
          doNotContact: Boolean(primary.doNotContact),
        }
      : null,
  });

  const topRivalRate =
    rivalRates !== null && rivalRates.length > 0 ? Math.max(...rivalRates) : null;

  const buyingRows = await sql`
    select observed_on::text as observed_on, provenance, confidence
    from prospect_buying_signals
    where prospect_id = ${prospectId} and archived_at is null
  `;
  const buyingSignals = buyingSignalScore(
    buyingRows.map((r) => ({
      observedOn: r.observedOn as string,
      provenance: r.provenance as ProvenanceLabel,
      confidence: r.confidence === null ? null : Number(r.confidence),
    }))
  );

  // Component keys are camelCase to survive the postgres.camel JSONB
  // round-trip (db/client.ts) — they must match the weight-set keys exactly.
  const components: Record<string, number | null> = {
    commercialAuthority: gapView.authority.score,
    visibilityGap:
      gapView.gap !== null ? Math.min(100, Math.max(0, gapView.gap)) : null,
    adjustedFixability: fixability.adjusted,
    competitorAdvantage: topRivalRate !== null ? 100 * (1 - topRivalRate) : null,
    // Null when no signals are recorded — not measured, weight redistributes.
    buyingSignals,
    contactability: contact.score,
  };

  const composite = weightedComposite(components, weightSet.weights);
  const dataConfidence = fixability.confidence ?? 1;

  // Priority archetype: independently verified production (source_type from
  // migration 074) + a market the assistants answer + a barely-recommended
  // prospect. Boost applied AFTER the composite, as a named multiplier.
  const hasIndependentProduction = signalRows.some(
    (r) =>
      r.sourceType === "independent" &&
      ["transaction_volume", "transaction_count", "ranking"].includes(r.kind as string)
  );
  const archetype = detectArchetype({
    hasIndependentProduction,
    prospectRecShare,
    topRivalRate,
    adjustedFixability: fixability.adjusted,
  });
  const archetypeBoost = archetype ? ARCHETYPE_BOOST : 1;

  const base = composite.score !== null ? composite.score * dataConfidence : null;
  return {
    version: PROSPECT_SCORE_VERSION,
    weightSet: { name: weightSet.name, version: weightSet.version, weights: weightSet.weights },
    components,
    missing: composite.missing,
    fixability,
    contactabilityFlags: contact.flags,
    preConfidence: composite.score,
    dataConfidence,
    archetype,
    archetypeBoost,
    score: base !== null ? Math.min(100, base * archetypeBoost) : null,
  };
}
