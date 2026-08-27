/**
 * Narrative state + prospect-legible copy for the public audit page (spec
 * 123). Pure functions over snapshot facts so the story the hero tells can
 * be unit-tested against every performance state — zero, low, strong,
 * leader — plus the legacy fallback for snapshots published before the
 * stakes block existed. The page renders the same seven-section structure
 * in every state; only the story adapts to the evidence.
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
  /** The generator-written headline frozen in the snapshot — the legacy
   * state renders it verbatim. */
  legacyHeadline: string;
}

/** The one-sentence story, adapted to the performance state. Past tense and
 * benchmark-scoped on purpose: every claim is a count from this test. */
export function heroHeadline(state: NarrativeState, ctx: HeadlineContext): string {
  switch (state) {
    case "zero":
      return `When ${ctx.marketName} buyers and sellers asked AI which agent to work with, ${ctx.prospectName} wasn't recommended.`;
    case "low":
      return `When ${ctx.marketName} buyers and sellers asked AI which agent to work with, ${ctx.prospectName} was rarely the recommendation.`;
    case "strong":
      return `${ctx.prospectName} already shows up in ${ctx.marketName}'s AI answers — with clear room to be recommended more often.`;
    case "leader":
      return `${ctx.prospectName} leads this test: no ${ctx.marketName} team was recommended more often.`;
    case "legacy":
      return ctx.legacyHeadline;
  }
}

/** The line under the headline. Null when the state has nothing counted to
 * add — never filler. */
export function heroSupportLine(
  state: NarrativeState,
  ctx: { marketName: string; competitorsWereRecommended: boolean }
): string | null {
  if ((state === "zero" || state === "low") && ctx.competitorsWereRecommended) {
    return `Other ${ctx.marketName} teams and brands were recommended instead.`;
  }
  if (state === "leader") {
    return "The opportunity is to defend that position and widen the gap.";
  }
  return null;
}

/** "We tested N AI answers … in the systems behind ChatGPT and Perplexity."
 * Consumer names derive from the tested providers (terminology layer); when
 * no consumer counterpart is known the phrase stays neutral. */
export function plainSystemsPhrase(providers: string[]): string {
  const apps = verifySuggestionApps(providers);
  if (apps === "any AI assistant") return "the AI systems we tested";
  return apps.includes(" and ")
    ? `the systems behind ${apps}`
    : `the system behind ${apps}`;
}

/**
 * One sentence explaining a comparison basis that differs from the headline
 * denominator (e.g. findings frozen when 354 of 512 answers were captured).
 * Null when the bases match — the common case needs no caveat.
 */
export function comparisonBasisNote(
  basis: number | null,
  responseCount: number
): string | null {
  if (basis === null || basis === responseCount) return null;
  return `These counts come from the ${basis} answers analyzed when this report's findings were computed, out of ${responseCount} captured in total.`;
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
    return `${shown} of the ${total} captured answers are published, in capture order up to a page-size limit — nothing was hand-picked.`;
  }
  return `${shown} captured answers are published — unedited.`;
}
