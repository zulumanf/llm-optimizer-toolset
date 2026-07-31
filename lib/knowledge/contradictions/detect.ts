/**
 * Contradiction detection (spec 020 Phase 2).
 *
 * `claim_contradictions` has existed since migration 018 but nothing ever wrote
 * to it outside the seed script. This module is the detector.
 *
 * Every rule is **deterministic**. Deciding that two claims disagree is a
 * comparison, not a judgement, and a comparison belongs in code where it can be
 * unit-tested with known answers (docs/12: agents interpret, code decides).
 *
 * The rule that shapes the output: **older claims are never deleted.** A
 * contradiction is a flag for a human. Effective dates carry history, and
 * resolving a disagreement by discarding one side destroys the audit trail that
 * makes a past report explicable.
 */
import { sql, type TransactionSql } from "@/db/client";
import { publishEvent } from "@/lib/events/bus";
import { HIGH_RISK_CATEGORIES } from "@/lib/knowledge/constants";
import { assessFreshness } from "@/lib/knowledge/freshness";

type Tx = TransactionSql | typeof sql;

export const CONTRADICTION_TYPES = [
  "value_divergence",
  "affiliation_conflict",
  "date_conflict",
  "expired_ranking",
  "privacy_conflict",
] as const;
export type ContradictionType = (typeof CONTRADICTION_TYPES)[number];

export type Severity = "low" | "medium" | "high" | "critical";

export interface DetectedContradiction {
  claimId: string;
  contradictingClaimId: string | null;
  type: ContradictionType;
  severity: Severity;
  description: string;
  /** What most likely explains it, so a human starts from a hypothesis. */
  likelyExplanation: string;
  recommendedResolution: string;
  requiresHumanReview: boolean;
}

/** The claim shape the rules operate on. Exported so tests need no database. */
export interface ClaimForComparison {
  id: string;
  key: string;
  canonicalText: string;
  value: unknown;
  category: string;
  normalizedPredicate: string | null;
  subjectEntity: string | null;
  subjectEntityId: string | null;
  objectEntityId: string | null;
  status: string;
  privacyStatus: string;
  asOf: string | null;
  effectiveDate: string | null;
  reviewDate: string | null;
  verificationStatus: string | null;
  lastVerifiedAt: string | null;
}

/** Predicates where two different objects at the same time is a real conflict. */
const EXCLUSIVE_PREDICATES = ["works_for", "affiliated_with", "brokerage", "leads", "employed_by"];

/**
 * Compare a set of claims and return every contradiction found. Pure: no
 * database, no clock beyond the injected `now`.
 */
export function detectContradictions(
  claims: ClaimForComparison[],
  now: Date = new Date()
): DetectedContradiction[] {
  const found: DetectedContradiction[] = [];
  // Only claims the platform actually believes can contradict each other. A
  // rejected proposal disagreeing with an approved fact is not a contradiction,
  // it is the system working.
  const live = claims.filter((c) => c.status === "approved" || c.status === "proposed");

  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i]!;
      const b = live[j]!;
      if (!sameSubjectAndPredicate(a, b)) continue;
      if (!periodsOverlap(a, b)) continue;

      if (isExclusive(a) && differentObject(a, b)) {
        found.push({
          claimId: a.id,
          contradictingClaimId: b.id,
          type: "affiliation_conflict",
          severity: "critical",
          description: `Two overlapping claims give different answers for "${a.normalizedPredicate}": "${a.canonicalText}" versus "${b.canonicalText}".`,
          likelyExplanation:
            "One claim is out of date after a move, or one is missing the effective date that would separate them.",
          recommendedResolution:
            "Set effective dates so the periods do not overlap, then supersede the older claim.",
          requiresHumanReview: true,
        });
        continue;
      }

      // Same subject and predicate but a *different object* is not a
      // disagreement — it is two facts. "Metrovue: 148 units" and "The Summit:
      // 99 units" share a subject and a predicate and contradict nothing.
      //
      // Found by the first live discovery run (2026-07-30), which raised three
      // "contradictions" reading "Overlapping claims disagree on general: 25165
      // versus 3737" — bare unit counts for unrelated buildings. Noise like
      // that is worse than silence: an operator who learns the contradiction
      // queue is junk stops reading the one that matters.
      if (differentValue(a, b) && !differentObject(a, b)) {
        const material = HIGH_RISK_CATEGORIES.includes(a.category);
        found.push({
          claimId: a.id,
          contradictingClaimId: b.id,
          type: "value_divergence",
          severity: material ? "high" : "medium",
          description: `Overlapping claims disagree on ${a.category.replace(/_/g, " ")}: ${describeValue(a)} versus ${describeValue(b)}.`,
          likelyExplanation: material
            ? "Two sources reported different figures, or one covers a different period than it states."
            : "The two records were entered from different sources.",
          recommendedResolution:
            "Confirm which source is authoritative, approve a corrected version, and let the older one supersede with its effective date intact.",
          requiresHumanReview: material,
        });
      }
    }
  }

  for (const claim of live) {
    // A public claim restating a restricted one is a disclosure problem, not a
    // disagreement — but it belongs in the same review queue.
    const leak = live.find(
      (other) =>
        other.id !== claim.id &&
        claim.privacyStatus === "public" &&
        (other.privacyStatus === "restricted" || other.privacyStatus === "internal") &&
        sameSubjectAndPredicate(claim, other)
    );
    if (leak) {
      found.push({
        claimId: claim.id,
        contradictingClaimId: leak.id,
        type: "privacy_conflict",
        severity: "high",
        description: `A public claim restates the subject and predicate of a ${leak.privacyStatus} claim.`,
        likelyExplanation:
          "A confidential fact was re-entered without its privacy classification.",
        recommendedResolution:
          "Raise the public claim's privacy class, or confirm in writing that the public form is cleared for release.",
        requiresHumanReview: true,
      });
    }

    if (claim.category === "ranking" || claim.category === "award") {
      const freshness = assessFreshness(
        {
          category: claim.category,
          status: claim.status,
          asOf: claim.asOf,
          effectiveDate: claim.effectiveDate,
          reviewDate: claim.reviewDate,
          lastVerifiedAt: claim.lastVerifiedAt,
          verificationStatus: claim.verificationStatus,
        },
        now
      );
      const hasSuccessor = live.some(
        (other) =>
          other.id !== claim.id &&
          other.key === claim.key &&
          (other.asOf ?? "") > (claim.asOf ?? "")
      );
      if (freshness.state === "expired" && !hasSuccessor) {
        found.push({
          claimId: claim.id,
          contradictingClaimId: null,
          type: "expired_ranking",
          severity: "medium",
          description: `${freshness.reason} No newer ${claim.category} claim replaces it.`,
          likelyExplanation:
            "The ranking year passed and this year's result has not been recorded.",
          recommendedResolution:
            "Record the current year's result, or restrict this claim to historical wording with its year stated.",
          requiresHumanReview: true,
        });
      }
    }

    // An effective date before the date the claim is true *about* is incoherent
    // on its face and usually a data-entry transposition.
    if (claim.effectiveDate && claim.asOf && claim.effectiveDate < claim.asOf) {
      found.push({
        claimId: claim.id,
        contradictingClaimId: null,
        type: "date_conflict",
        severity: "medium",
        description: `The effective date (${claim.effectiveDate}) precedes the as-of date (${claim.asOf}).`,
        likelyExplanation: "The two dates were transposed on entry.",
        recommendedResolution: "Correct the dates and approve a new version.",
        requiresHumanReview: false,
      });
    }
  }

  return found;
}

// ------------------------------------------------------------------ helpers

function sameSubjectAndPredicate(a: ClaimForComparison, b: ClaimForComparison): boolean {
  const predicateA = a.normalizedPredicate ?? a.key;
  const predicateB = b.normalizedPredicate ?? b.key;
  if (predicateA !== predicateB) return false;
  // Prefer the resolved entity; fall back to the free-text subject.
  if (a.subjectEntityId && b.subjectEntityId) return a.subjectEntityId === b.subjectEntityId;
  return (a.subjectEntity ?? "") === (b.subjectEntity ?? "");
}

function isExclusive(claim: ClaimForComparison): boolean {
  const predicate = (claim.normalizedPredicate ?? claim.key).toLowerCase();
  return EXCLUSIVE_PREDICATES.some((p) => predicate.includes(p));
}

function differentObject(a: ClaimForComparison, b: ClaimForComparison): boolean {
  if (a.objectEntityId && b.objectEntityId) return a.objectEntityId !== b.objectEntityId;
  return normalizeText(a.canonicalText) !== normalizeText(b.canonicalText);
}

function differentValue(a: ClaimForComparison, b: ClaimForComparison): boolean {
  // Both sides must actually carry a value. Two claims with no value are two
  // sentences, and comparing sentences for contradiction is an agent's job.
  if (a.value === null || a.value === undefined) return false;
  if (b.value === null || b.value === undefined) return false;
  return JSON.stringify(a.value) !== JSON.stringify(b.value);
}

/**
 * Two claims conflict only if their validity periods overlap. Without this,
 * "worked at X in 2023" and "works at Y in 2025" would read as a contradiction
 * when they are simply history.
 */
function periodsOverlap(a: ClaimForComparison, b: ClaimForComparison): boolean {
  const startA = a.effectiveDate ?? a.asOf;
  const startB = b.effectiveDate ?? b.asOf;
  // No dates at all: we cannot separate them, so they are treated as competing.
  if (!startA || !startB) return true;
  const yearA = startA.slice(0, 4);
  const yearB = startB.slice(0, 4);
  return yearA === yearB;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function describeValue(claim: ClaimForComparison): string {
  const value = claim.value;
  if (value === null || value === undefined) return `"${claim.canonicalText}"`;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// ------------------------------------------------------------- persistence

/**
 * Detect and record contradictions for one client. Idempotent: an identical
 * open contradiction is not re-inserted, so running this on every claim
 * approval does not accumulate duplicates.
 */
export async function scanProjectContradictions(
  projectId: string,
  options: { now?: Date } = {}
): Promise<{ detected: number; recorded: number }> {
  const rows = await sql`
    select id, key, canonical_text, value, category, normalized_predicate,
      subject_entity, subject_entity_id, object_entity_id, status, privacy_status,
      to_char(as_of, 'YYYY-MM-DD') as as_of,
      to_char(effective_date, 'YYYY-MM-DD') as effective_date,
      to_char(review_date, 'YYYY-MM-DD') as review_date,
      verification_status, last_verified_at
    from claims
    where project_id = ${projectId} and status in ('approved', 'proposed')
  `;

  const claims: ClaimForComparison[] = rows.map((row) => ({
    id: row.id as string,
    key: row.key as string,
    canonicalText: row.canonicalText as string,
    value: row.value ?? null,
    category: (row.category as string) ?? "general",
    normalizedPredicate: (row.normalizedPredicate as string | null) ?? null,
    subjectEntity: (row.subjectEntity as string | null) ?? null,
    subjectEntityId: (row.subjectEntityId as string | null) ?? null,
    objectEntityId: (row.objectEntityId as string | null) ?? null,
    status: row.status as string,
    privacyStatus: (row.privacyStatus as string) ?? "public",
    asOf: (row.asOf as string | null) ?? null,
    effectiveDate: (row.effectiveDate as string | null) ?? null,
    reviewDate: (row.reviewDate as string | null) ?? null,
    verificationStatus: (row.verificationStatus as string | null) ?? null,
    lastVerifiedAt: row.lastVerifiedAt ? String(row.lastVerifiedAt) : null,
  }));

  const detected = detectContradictions(claims, options.now);
  let recorded = 0;

  for (const item of detected) {
    const inserted = await sql.begin(async (tx) => {
      const existing = await tx`
        select id from claim_contradictions
        where project_id = ${projectId} and claim_id = ${item.claimId}
          and coalesce(contradicting_claim_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(${item.contradictingClaimId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          and detected_by = ${item.type} and status = 'open'
      `;
      if (existing.length > 0) return false;

      const [row] = await tx`
        insert into claim_contradictions (
          project_id, claim_id, contradicting_claim_id, severity, description,
          detected_by, status
        ) values (
          ${projectId}, ${item.claimId}, ${item.contradictingClaimId},
          ${item.severity}, ${contradictionNarrative(item)}, ${item.type}, 'open'
        )
        returning id
      `;
      await publishEvent(tx, {
        type: "claim.conflict_detected",
        projectId,
        payload: {
          claimId: item.claimId,
          conflictingClaimId: item.contradictingClaimId ?? row!.id as string,
          severity: item.severity,
        },
      });
      return true;
    });
    if (inserted) recorded += 1;
  }

  return { detected: detected.length, recorded };
}

/** The stored description carries the hypothesis and the fix, not just the fact. */
function contradictionNarrative(item: DetectedContradiction): string {
  return [
    item.description,
    `Likely explanation: ${item.likelyExplanation}`,
    `Recommended: ${item.recommendedResolution}`,
  ].join(" ");
}

/**
 * Resolve or dismiss a contradiction. Neither path deletes a claim — that is
 * the whole point of recording the disagreement rather than picking a winner.
 */
export async function resolveContradiction(
  tx: Tx,
  args: {
    contradictionId: string;
    status: "resolved" | "dismissed";
    resolution: string;
    resolvedBy: string;
  }
): Promise<{ projectId: string; claimId: string }> {
  const [row] = await tx`
    update claim_contradictions
    set status = ${args.status}, resolution = ${args.resolution},
      resolved_by = ${args.resolvedBy}, resolved_at = now()
    where id = ${args.contradictionId} and status = 'open'
    returning project_id, claim_id, contradicting_claim_id, severity
  `;
  if (!row) {
    throw new Error("Contradiction not found or already settled.");
  }
  await publishEvent(tx, {
    type: "claim.conflict_resolved",
    projectId: row.projectId as string,
    payload: {
      claimId: row.claimId as string,
      conflictingClaimId: (row.contradictingClaimId as string | null) ?? (row.claimId as string),
      severity: row.severity as Severity,
    },
  });
  return { projectId: row.projectId as string, claimId: row.claimId as string };
}
