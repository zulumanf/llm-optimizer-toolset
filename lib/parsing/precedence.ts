/**
 * Classification precedence (spec 141). Mention rows are insert-only and
 * versioned; several revisions of one (response, company) pair can coexist.
 * This module is the single statement of which revision a PUBLIC number may
 * use, mirrored exactly by `PUBLIC_REVISION` / `PUBLIC_BLOCKED` in
 * db/mentions.ts. Internal operator views keep the platform's
 * current-revision rule; public claims use verified-only precedence.
 *
 * Status of a row (precedence: human review > explicit status > derived):
 *  - a human-reviewed row (reviewed_by) is verified;
 *  - explicit `verification_status` when set (revision-3 adjudication and later);
 *  - otherwise derived: LLM parser row with confidence >= 0.7 and no review
 *    flag → verified; review-flagged row → needs_manual_review; heuristic
 *    row → directional; anything else → not_classified.
 *
 * Resolution of a pair: the highest verified revision wins. If a row newer
 * than that (or any row, when none is verified) is needs_manual_review, the
 * pair is BLOCKED and every public claim over its run must not publish.
 * Directional rows never count publicly, even when they are the newest.
 */
import { CONFIDENCE_REVIEW_THRESHOLD, PARSER_VERSION_LLM, PARSER_VERSION_ADJUDICATION } from "@/lib/constants";

export const VERIFICATION_STATUSES = ["verified", "directional", "needs_manual_review", "not_classified"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Which revisions carry a classifier judgment strong enough to be public. */
export const VERIFIED_PARSER_VERSIONS: readonly string[] = [PARSER_VERSION_LLM, PARSER_VERSION_ADJUDICATION];

export type MentionRevisionRow = {
  revision: number;
  parserVersion: string;
  confidence: number;
  needsReview: boolean;
  mentioned: boolean;
  recommended: boolean;
  verificationStatus?: VerificationStatus | null;
  /** A person judged this row (mentions.reviewed_by); human outranks every parser. */
  reviewed?: boolean;
};

export function deriveStatus(row: MentionRevisionRow): VerificationStatus {
  if (row.reviewed) return "verified";
  if (row.verificationStatus) return row.verificationStatus;
  if (row.needsReview) return "needs_manual_review";
  if (VERIFIED_PARSER_VERSIONS.includes(row.parserVersion)) {
    return row.confidence >= CONFIDENCE_REVIEW_THRESHOLD ? "verified" : "needs_manual_review";
  }
  return "directional";
}

export type PairResolution =
  | { kind: "verified"; row: MentionRevisionRow }
  | { kind: "blocked"; reason: string }
  | { kind: "absent" };

/** Pure resolver over every revision row of one (response, company) pair. */
export function resolvePublicClassification(rows: readonly MentionRevisionRow[]): PairResolution {
  if (rows.length === 0) return { kind: "absent" };
  const sorted = [...rows].sort((a, b) => b.revision - a.revision);
  const best = sorted.find((r) => deriveStatus(r) === "verified");
  const newestManual = sorted.find((r) => deriveStatus(r) === "needs_manual_review");
  if (newestManual && (!best || newestManual.revision > best.revision)) {
    return { kind: "blocked", reason: `revision ${newestManual.revision} (${newestManual.parserVersion}) needs manual review` };
  }
  if (!best) {
    // Only directional (heuristic) or unclassified rows: no public judgment.
    return { kind: "absent" };
  }
  return { kind: "verified", row: best };
}

/**
 * Adjudication outcome for a revision-3 row, given the earlier judgments.
 * `llm1` is the original LLM judgment (may be missing when the company was
 * attached after the LLM parse), `heuristic` the latest heuristic row, and
 * `llm3` the fresh classifier judgment. Two concurring classifier judgments,
 * or a classifier judgment that concurs with the heuristic, are verified at
 * or above the review threshold; everything else goes to manual review.
 */
export type Judgment = { mentioned: boolean; recommended: boolean; confidence: number };

/** Thresholds from docs/06: >= 0.9 auto-accept; 0.7–0.9 accept with spot
 * check — which, when a parser dissents, means a person must look. */
export const AUTO_ACCEPT_CONFIDENCE = 0.9;

/**
 * Offline adjudication (no classifier available): the revision-1 classifier
 * judgment is retained as verified only when the answer text corroborates
 * it — the company's name or an alias occurs in the text, the excerpt the
 * classifier quoted occurs verbatim in the text, and its confidence is at
 * or above AUTO_ACCEPT_CONFIDENCE. Anything weaker goes to manual review.
 * A pair with no classifier judgment at all is `not_classified`: absent from
 * public counts, never a zero, disclosed as coverage.
 */
/** Markdown, punctuation and whitespace do not change what a sentence says;
 * the classifier quotes text without them. */
export function normalizeForGrounding(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>"'’“”.,;:!?()\[\]-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const GROUNDING_MIN_FRAGMENT_CHARS = 15;

/** An excerpt is grounded when every ellipsis-separated fragment of it
 * (at least GROUNDING_MIN_FRAGMENT_CHARS long) occurs in the normalized text. */
export function excerptGrounded(text: string, excerpt: string | null): boolean | null {
  if (!excerpt || excerpt.trim().length === 0) return null;
  const t = normalizeForGrounding(text);
  const fragments = excerpt.split(/\.{3}|…/).map(normalizeForGrounding).filter((f) => f.length >= GROUNDING_MIN_FRAGMENT_CHARS);
  if (fragments.length === 0) return null;
  return fragments.every((f) => t.includes(f));
}

export function adjudicateOffline(
  llm1: (Judgment & { excerpt: string | null }) | null,
  corroboration: { aliasInText: boolean; excerptInText: boolean | null }
): { status: VerificationStatus; reason: string } {
  if (llm1 === null) return { status: "not_classified", reason: "no classifier judgment exists for this pair (company attached after the classifier parse) and no classifier is available; excluded from public counts, not counted as zero" };
  if (!llm1.mentioned) {
    return corroboration.aliasInText
      ? { status: "needs_manual_review", reason: "rev1 classifier said not mentioned but a name or alias occurs in the text; heuristic dissents" }
      : { status: "verified", reason: "rev1 classifier said not mentioned and no name or alias occurs in the text; heuristic dissent recorded" };
  }
  if (!corroboration.aliasInText) return { status: "needs_manual_review", reason: "rev1 classifier said mentioned but no name or alias occurs in the text" };
  if (corroboration.excerptInText === false) return { status: "needs_manual_review", reason: "rev1 excerpt is not found verbatim in the answer text" };
  if (llm1.confidence < AUTO_ACCEPT_CONFIDENCE) return { status: "needs_manual_review", reason: `rev1 confidence ${llm1.confidence} is below the ${AUTO_ACCEPT_CONFIDENCE} auto-accept line while the heuristic dissents` };
  return { status: "verified", reason: `rev1 classifier judgment retained: name/alias in text, quoted excerpt grounded in text, confidence ${llm1.confidence} >= ${AUTO_ACCEPT_CONFIDENCE}; heuristic dissent recorded` };
}

export function adjudicate(
  llm1: Judgment | null,
  heuristic: Judgment | null,
  llm3: Judgment
): { status: VerificationStatus; reason: string } {
  const same = (a: Judgment | null, b: Judgment) => a !== null && a.mentioned === b.mentioned && a.recommended === b.recommended;
  const strong = llm3.confidence >= CONFIDENCE_REVIEW_THRESHOLD;
  if (!strong) return { status: "needs_manual_review", reason: `rev3 confidence ${llm3.confidence} below ${CONFIDENCE_REVIEW_THRESHOLD}` };
  if (same(llm1, llm3)) return { status: "verified", reason: "rev3 classifier agrees with rev1 classifier; heuristic dissent recorded" };
  if (llm1 === null) return { status: "verified", reason: "no rev1 classifier row (company attached later); rev3 classifier judgment at or above threshold" };
  if (same(heuristic, llm3)) return { status: "verified", reason: "rev3 classifier agrees with heuristic against rev1 classifier (2 of 3)" };
  return { status: "needs_manual_review", reason: "rev3 classifier disagrees with both rev1 classifier and heuristic" };
}
