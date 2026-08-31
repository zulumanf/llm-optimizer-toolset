/**
 * Narrative state + prospect-legible copy for the public audit page (spec
 * 123). Pure functions over snapshot facts so the story the hero tells can
 * be unit-tested against every performance state — zero, low, strong,
 * leader — plus the legacy fallback for snapshots published before the
 * stakes block existed. The page renders the same block structure in every
 * state; only the story adapts to the evidence.
 *
 * Copy discipline: everything here is prospect-visible and is scanned by
 * tests/unit/audit-copy-discipline.test.ts. Counted claims only; consumer
 * assistant names come from the terminology layer, never hardcoded.
 */
import { visibilityThreshold } from "@/lib/prospects/constants";
import { verifySuggestionApps } from "@/lib/prospects/terminology";

export type NarrativeState = "zero" | "low" | "strong" | "leader" | "legacy";

export interface NarrativeInput {
  /** stakes.yourRecommendations, or null when the snapshot has no stakes
   * block (pre-stakes snapshots → legacy). */
  yourRecommendations: number | null;
  responseCount: number;
  /** The prospect's counted recommendations on the comparison table's own
   * basis, when a prospect row exists — like-for-like against rivals. */
  prospectRowRecommendations: number | null;
  /** The highest rival recommendation count on the same basis; 0 when no
   * rival was recommended. */
  topRivalRecommendations: number;
}

export function narrativeState(input: NarrativeInput): NarrativeState {
  if (input.yourRecommendations === null) return "legacy";
  const recs = input.yourRecommendations;
  if (recs === 0) return "zero";
  if (recs < visibilityThreshold(input.responseCount)) return "low";
  const own = input.prospectRowRecommendations ?? recs;
  return own >= input.topRivalRecommendations ? "leader" : "strong";
}

export interface HeadlineContext {
  prospectName: string;
  marketName: string;
  /** How many rival teams were counted with MORE recommendations than the
   * prospect — the low state only says "several competitors" when several
   * were actually counted ahead. */
  rivalsCountedAhead: number;
  /** The generator-written headline frozen in the snapshot — the legacy
   * state renders it verbatim. */
  legacyHeadline: string;
}

/** The one-sentence story, adapted to the performance state. Every claim is
 * a count from this test; the "answers we tested" line directly beneath
 * carries the scope. */
export function heroHeadline(state: NarrativeState, ctx: HeadlineContext): string {
  switch (state) {
    case "zero":
      return `When ${ctx.marketName} buyers ask AI who to work with, ${ctx.prospectName} isn't being recommended.`;
    case "low":
      return ctx.rivalsCountedAhead >= 2
        ? `${ctx.prospectName} shows up in ${ctx.marketName}'s AI answers, but several local competitors are recommended more often.`
        : ctx.rivalsCountedAhead === 1
          ? `${ctx.prospectName} shows up in ${ctx.marketName}'s AI answers, but another local team is recommended more often.`
          : `${ctx.prospectName} shows up in ${ctx.marketName}'s AI answers, but is rarely the recommendation.`;
    case "strong":
      return `${ctx.prospectName} already appears in ${ctx.marketName}'s AI answers — and there are still clear gaps to close.`;
    case "leader":
      return `${ctx.prospectName} leads this benchmark: no ${ctx.marketName} team was recommended more often.`;
    case "legacy":
      return ctx.legacyHeadline;
  }
}

/** The single opportunity line under the hero number. Null when the state
 * has nothing counted to add — never filler. */
export function heroOpportunityLine(
  state: NarrativeState,
  ctx: {
    marketName: string;
    /** True when at least one rival team cleared the visibility threshold —
     * the "no team dominates yet" line is only claimable when none did. */
    anyRivalDominates: boolean;
    competitorsWereRecommended: boolean;
  }
): string | null {
  if (state === "zero" || state === "low") {
    if (!ctx.anyRivalDominates) {
      return `No ${ctx.marketName} team dominates these answers yet.`;
    }
    if (ctx.competitorsWereRecommended) {
      return `Other ${ctx.marketName} agents are being recommended instead.`;
    }
    return null;
  }
  if (state === "leader") {
    return "The opportunity is to defend and strengthen that position.";
  }
  return null;
}

/**
 * "the 512 ChatGPT and Perplexity answers we tested" — the page's one
 * dominant denominator, named with the consumer counterparts of the tested
 * providers (terminology layer). Unknown providers stay neutral, never a
 * guessed brand. The precise tested-system description (API surface, search
 * settings) lives in the methodology drawer via testedSystemPhrase.
 */
export function answersTestedPhrase(
  providers: string[],
  responseCount: number
): string {
  const apps = verifySuggestionApps(providers);
  return apps === "any AI assistant"
    ? `the ${responseCount} AI answers we tested`
    : `the ${responseCount} ${apps} answers we tested`;
}

/**
 * One sentence explaining a comparison basis that differs from the headline
 * denominator (e.g. findings frozen when 354 of 512 answers were captured).
 * Rendered in the methodology drawer only — the primary flow keeps one
 * denominator. Null when the bases match.
 */
export function comparisonBasisNote(
  basis: number | null,
  responseCount: number
): string | null {
  if (basis === null || basis === responseCount) return null;
  return `Competitor counts were tallied over the ${basis} answers analyzed when this report's findings were computed, out of ${responseCount} captured in total.`;
}

/**
 * Honest published-appendix metadata. "All … answers" is claimed ONLY when
 * the snapshot provably holds every qualifying capture; a capped list is
 * disclosed as shown-of-total; legacy snapshots (no total) never claim
 * completeness.
 */
export function publishedAnswersNote(
  shown: number,
  total: number | null
): string {
  if (shown > 0 && total === shown) {
    return `All ${shown} captured answers are published — unedited and unselected.`;
  }
  if (total !== null && shown < total) {
    return `${shown} published answers of the ${total} captured, in capture order up to a page-size limit — nothing was hand-picked.`;
  }
  return `${shown} published answers — unedited.`;
}
