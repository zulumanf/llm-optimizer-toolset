/**
 * Spec 147 §9.3 — classifying a sent correction's recheck. Pure.
 *
 * The page state decides first:
 *
 *   unreachable      → every item unreachable           (only a failed fetch)
 *   unchanged        → every item still_incorrect       (the same bytes that
 *                      produced the validated contradictions; no model call)
 *   previously_seen  → every item needs_review          (an older processed
 *                      version: no safe determination)
 *   changed          → each item from the frozen comparison:
 *
 *     approved fact gone from the current packet            → needs_review
 *     a current contradiction on the same approved fact
 *       whose observed wording is the item's                → still_incorrect
 *       with other wording                                  → needs_review
 *     no contradiction, but the item's wrong wording is
 *       still observed on the page                          → needs_review
 *     no contradiction, and the page affirms the approved
 *       fact (a matched observation of that approved claim) → corrected
 *     otherwise (the error is gone but nothing affirms the
 *       fact — possibly an extraction miss)                 → needs_review
 *
 * Absence is never success on its own: a correction is only `corrected` when
 * the current page positively restates the approved fact. A comparison that
 * does not validate yields needs_review for every item, never corrected.
 *
 * Overall: unreachable (fetch) > still_incorrect > needs_review > corrected.
 * A current contradiction on an approved fact the request did not cover is a
 * new error: it makes an otherwise corrected result needs_review.
 */
import { createHash } from "node:crypto";
import {
  contradictionContextError,
  normalizeStatement,
  validateContradictionOutput,
} from "@/lib/automation/contradictions/contract";
import { canonicalJson } from "@/lib/prospects/fact-manifest";
import {
  PROFILE_RECHECK_RESULT_VERSION,
  RECHECK_PAGE_STATE,
  RECHECK_RESULT,
  type RecheckPageState,
  type RecheckResult,
} from "@/lib/profile-corrections/constants";
import type { ProfileCorrectionRequest } from "@/lib/profile-corrections/request";

const APPROVED_STATUS = "approved";

export const RECHECK_ITEM_REASON = {
  fetchFailed: "the page could not be fetched",
  unchanged: "the page is byte-identical to the page the correction was made from",
  previouslySeen: "the page matches an older processed version; no safe determination",
  comparisonInvalid: "the current comparison did not validate",
  factGone: "the approved fact is no longer in the current approved facts",
  sameContradiction: "the same contradiction is still on the page",
  differentContradiction: "the approved fact is still contradicted, with different wording",
  wordingStillPresent: "the incorrect wording is still on the page, though not flagged",
  affirmed: "the incorrect statement is gone and the page restates the approved fact",
  notAffirmed: "the incorrect statement is gone, but the page does not restate the approved fact",
} as const;

export interface RecheckItemResult {
  observedClaimId: string;
  approvedClaimId: string;
  approvedClaimKey: string;
  status: RecheckResult;
  reason: string;
  currentObservedClaimId: string | null;
  currentStatement: string | null;
}

export interface RecheckNewContradiction {
  observedClaimId: string;
  approvedClaimId: string;
  statementA: string;
  severity: string;
}

export interface RecheckClassification {
  version: typeof PROFILE_RECHECK_RESULT_VERSION;
  pageState: RecheckPageState;
  result: RecheckResult;
  items: RecheckItemResult[];
  newContradictions: RecheckNewContradiction[];
}

export interface RecheckInput {
  request: ProfileCorrectionRequest;
  pageState: RecheckPageState;
  /** Changed page only: the frozen comparison and its contexts. */
  compare?: unknown;
  observedClaims?: unknown;
  approvedFacts?: unknown;
}

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((v): v is Row => v !== null && typeof v === "object") : [];
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function uniform(input: RecheckInput, status: RecheckResult, reason: string): RecheckItemResult[] {
  return input.request.items.map((item) => ({
    observedClaimId: item.observedClaimId,
    approvedClaimId: item.approvedClaimId,
    approvedClaimKey: item.approvedClaimKey,
    status,
    reason,
    currentObservedClaimId: null,
    currentStatement: null,
  }));
}

/** Overall result from item results (unreachable is page-level only). */
export function overallRecheckResult(items: readonly { status: RecheckResult }[], newErrors = 0): RecheckResult {
  if (items.some((i) => i.status === RECHECK_RESULT.unreachable)) return RECHECK_RESULT.unreachable;
  if (items.some((i) => i.status === RECHECK_RESULT.stillIncorrect)) return RECHECK_RESULT.stillIncorrect;
  if (items.some((i) => i.status === RECHECK_RESULT.needsReview)) return RECHECK_RESULT.needsReview;
  if (newErrors > 0) return RECHECK_RESULT.needsReview;
  return RECHECK_RESULT.corrected;
}

function classifyChanged(input: RecheckInput): { items: RecheckItemResult[]; newContradictions: RecheckNewContradiction[] } {
  const contextError = contradictionContextError({ observedClaims: input.observedClaims, approvedFacts: input.approvedFacts });
  const checked = contextError
    ? null
    : validateContradictionOutput(input.compare, { observedClaims: input.observedClaims, approvedFacts: input.approvedFacts });
  if (!checked || !checked.ok) {
    return { items: uniform(input, RECHECK_RESULT.needsReview, RECHECK_ITEM_REASON.comparisonInvalid), newContradictions: [] };
  }
  const contradictions = checked.output.contradictions;
  const observed = rows(input.observedClaims);
  const approvedIds = new Set(rows((input.approvedFacts as Row | undefined)?.claims).map((c) => String(c.id)));
  const covered = new Set(input.request.items.map((i) => i.approvedClaimId));

  const items = input.request.items.map((item): RecheckItemResult => {
    const base = {
      observedClaimId: item.observedClaimId,
      approvedClaimId: item.approvedClaimId,
      approvedClaimKey: item.approvedClaimKey,
      currentObservedClaimId: null as string | null,
      currentStatement: null as string | null,
    };
    if (!approvedIds.has(item.approvedClaimId)) {
      return { ...base, status: RECHECK_RESULT.needsReview, reason: RECHECK_ITEM_REASON.factGone };
    }
    const wrong = new Set([normalizeStatement(item.observedStatement), normalizeStatement(item.pageWording)]);
    const onFact = contradictions
      .filter((c) => c.approvedClaimId === item.approvedClaimId)
      .sort((a, b) => (a.observedClaimId < b.observedClaimId ? -1 : a.observedClaimId > b.observedClaimId ? 1 : 0));
    if (onFact.length > 0) {
      const same = onFact.find((c) => wrong.has(normalizeStatement(c.statementA)));
      const hit = same ?? onFact[0]!;
      return {
        ...base,
        currentObservedClaimId: hit.observedClaimId,
        currentStatement: hit.statementA,
        status: same ? RECHECK_RESULT.stillIncorrect : RECHECK_RESULT.needsReview,
        reason: same ? RECHECK_ITEM_REASON.sameContradiction : RECHECK_ITEM_REASON.differentContradiction,
      };
    }
    const lingering = observed.find((o) =>
      [str(o.originalWording), str(o.normalizedWording)].some((w) => w !== null && wrong.has(normalizeStatement(w)))
    );
    if (lingering) {
      return {
        ...base,
        currentObservedClaimId: str(lingering.claimId),
        currentStatement: str(lingering.originalWording),
        status: RECHECK_RESULT.needsReview,
        reason: RECHECK_ITEM_REASON.wordingStillPresent,
      };
    }
    const affirmation = observed.find(
      (o) => o.claimId === item.approvedClaimId && o.existingStatus === APPROVED_STATUS
    );
    if (affirmation) {
      return {
        ...base,
        currentObservedClaimId: str(affirmation.claimId),
        currentStatement: str(affirmation.originalWording),
        status: RECHECK_RESULT.corrected,
        reason: RECHECK_ITEM_REASON.affirmed,
      };
    }
    return { ...base, status: RECHECK_RESULT.needsReview, reason: RECHECK_ITEM_REASON.notAffirmed };
  });

  const newContradictions = contradictions
    .filter((c) => !covered.has(c.approvedClaimId))
    .map((c) => ({ observedClaimId: c.observedClaimId, approvedClaimId: c.approvedClaimId, statementA: c.statementA, severity: c.severity }))
    .sort((a, b) =>
      canonicalJson([a.approvedClaimId, a.observedClaimId]) < canonicalJson([b.approvedClaimId, b.observedClaimId]) ? -1 : 1
    );
  return { items, newContradictions };
}

export function classifyProfileRecheck(input: RecheckInput): RecheckClassification {
  let items: RecheckItemResult[];
  let newContradictions: RecheckNewContradiction[] = [];
  switch (input.pageState) {
    case RECHECK_PAGE_STATE.unreachable:
      items = uniform(input, RECHECK_RESULT.unreachable, RECHECK_ITEM_REASON.fetchFailed);
      break;
    case RECHECK_PAGE_STATE.unchanged:
      items = uniform(input, RECHECK_RESULT.stillIncorrect, RECHECK_ITEM_REASON.unchanged);
      break;
    case RECHECK_PAGE_STATE.previouslySeen:
      items = uniform(input, RECHECK_RESULT.needsReview, RECHECK_ITEM_REASON.previouslySeen);
      break;
    default:
      ({ items, newContradictions } = classifyChanged(input));
  }
  return {
    version: PROFILE_RECHECK_RESULT_VERSION,
    pageState: input.pageState,
    result: overallRecheckResult(items, newContradictions.length),
    items,
    newContradictions,
  };
}

export function recheckResultHash(result: RecheckClassification): string {
  return createHash("sha256").update(canonicalJson(result)).digest("hex");
}
