/**
 * Evidence corrections (spec 130). A delivered Touch 1 froze a snapshot and
 * the ledger keeps the exact body the prospect received — both stay
 * immutable. When entity resolution changes what the SAME captured answers
 * resolve to (a verified lead-agent alias credits answers that named the
 * person), the corrected counts are recorded as a NEW insert-only row that
 * names the original, the correction, the reason, the run and who made it.
 * Readers of frozen evidence (report generation, follow-up rendering,
 * handoff QA) overlay the latest correction; the sent claim is never
 * rewritten and the learning log carries both values.
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { logActivity } from "@/lib/prospects/shared";

export interface EntityResolutionChange {
  /** Aliases written per company id, with their provenance. */
  aliasesAdded: Record<string, { aliases: string[]; realtrendsRecordId: string | null }>;
  /** Mention revisions appended per company id by the re-resolution. */
  mentionRowsAdded: Record<string, number>;
  counts: {
    prospect: { before: number; after: number };
    competitor: { before: number; after: number };
  };
}

export interface EvidenceCorrection {
  id: string;
  prospectId: string;
  evidenceDraftId: string;
  sendId: string | null;
  sourceRunId: string;
  originalSnapshot: MismatchEvidenceSnapshot;
  correctedSnapshot: MismatchEvidenceSnapshot;
  reason: string;
  entityResolutionChange: EntityResolutionChange;
  correctedBy: string | null;
  correctedAt: Date;
}

/** Pure: the original snapshot with both recommendation counts replaced and
 * the gap recomputed. Everything else (denominator, production, run,
 * template version) is untouched — same 256 answers, same claim shape. */
export function buildCorrectedSnapshot(
  original: MismatchEvidenceSnapshot,
  counts: { prospect: number; competitor: number }
): MismatchEvidenceSnapshot {
  return {
    ...original,
    prospect: { ...original.prospect, recommendationCount: counts.prospect },
    competitor: {
      ...original.competitor,
      recommendationCount: counts.competitor,
      recommendationGap: counts.competitor - counts.prospect,
    },
  };
}

/** Pure: whether a correction changes what a prospect-facing claim states. */
export function correctionIsMaterial(original: MismatchEvidenceSnapshot, corrected: MismatchEvidenceSnapshot): boolean {
  return (
    original.prospect.recommendationCount !== corrected.prospect.recommendationCount ||
    original.competitor.recommendationCount !== corrected.competitor.recommendationCount
  );
}

function toCorrection(r: Record<string, unknown>): EvidenceCorrection {
  return {
    id: r.id as string,
    prospectId: r.prospectId as string,
    evidenceDraftId: r.evidenceDraftId as string,
    sendId: (r.sendId as string | null) ?? null,
    sourceRunId: r.sourceRunId as string,
    originalSnapshot: r.originalSnapshot as MismatchEvidenceSnapshot,
    correctedSnapshot: r.correctedSnapshot as MismatchEvidenceSnapshot,
    reason: r.reason as string,
    entityResolutionChange: r.entityResolutionChange as EntityResolutionChange,
    correctedBy: (r.correctedBy as string | null) ?? null,
    correctedAt: new Date(r.correctedAt as Date),
  };
}

/** Newest correction for a delivered Touch 1 (by its send), or null. Returns
 * null when the table is not migrated yet so readers degrade to the frozen
 * snapshot instead of failing. */
export async function latestEvidenceCorrection(prospectId: string, sendId: string | null): Promise<EvidenceCorrection | null> {
  try {
    const rows = await sql`
      select * from outreach_evidence_corrections
      where prospect_id = ${prospectId} and (${sendId}::uuid is null or send_id = ${sendId})
      order by corrected_at desc limit 1
    `;
    return rows[0] ? toCorrection(rows[0]) : null;
  } catch (err) {
    if (err instanceof Error && /outreach_evidence_corrections/.test(err.message)) return null;
    throw err;
  }
}

export interface RecordCorrectionInput {
  prospectId: string;
  evidenceDraftId: string;
  sendId: string | null;
  original: MismatchEvidenceSnapshot;
  reason: string;
  change: Omit<EntityResolutionChange, "counts">;
}

/**
 * Recount BOTH sides from the same frozen run with the canonical counter and
 * record the correction. Returns the existing effective state unchanged when
 * the recount equals what is already in force (idempotent).
 */
export async function recordEvidenceCorrection(
  user: CurrentUser,
  input: RecordCorrectionInput
): Promise<{ recorded: boolean; correction: EvidenceCorrection | null; corrected: MismatchEvidenceSnapshot }> {
  const s = input.original;
  const counts = await providerRecommendationCounts(s.runId, s.provider, [s.prospect.companyId, s.competitor.companyId]);
  if (counts.answerCount !== s.answerCount) {
    throw new Error(`Denominator drifted: frozen ${s.answerCount}, run now ${counts.answerCount}. Refusing to correct against a different answer set.`);
  }
  const corrected = buildCorrectedSnapshot(s, {
    prospect: counts.recommendedByCompany[s.prospect.companyId] ?? 0,
    competitor: counts.recommendedByCompany[s.competitor.companyId] ?? 0,
  });
  const existing = await latestEvidenceCorrection(input.prospectId, input.sendId);
  const inForce = existing?.correctedSnapshot ?? s;
  if (!correctionIsMaterial(inForce, corrected)) return { recorded: false, correction: existing, corrected: inForce };
  const change: EntityResolutionChange = {
    ...input.change,
    counts: {
      prospect: { before: s.prospect.recommendationCount, after: corrected.prospect.recommendationCount },
      competitor: { before: s.competitor.recommendationCount, after: corrected.competitor.recommendationCount },
    },
  };
  const row = await sql.begin(async (tx) => {
    const [r] = await tx`
      insert into outreach_evidence_corrections
        (prospect_id, evidence_draft_id, send_id, source_run_id, original_snapshot, corrected_snapshot,
         reason, entity_resolution_change, corrected_by)
      values (${input.prospectId}, ${input.evidenceDraftId}, ${input.sendId}, ${s.runId},
        ${tx.json(s as never)}, ${tx.json(corrected as never)}, ${input.reason}, ${tx.json(change as never)}, ${user.id})
      returning *
    `;
    await writeAudit(tx, {
      userId: user.id,
      action: "prospect.evidence_corrected",
      entity: "outreach_evidence_correction",
      entityId: r!.id as string,
      detail: { prospectId: input.prospectId, sendId: input.sendId, runId: s.runId, counts: change.counts, reason: input.reason },
    });
    await logActivity(tx, input.prospectId, "evidence_corrected", {
      correctionId: r!.id, sentClaim: change.counts.prospect.before, corrected: change.counts.prospect.after,
      competitorSentClaim: change.counts.competitor.before, competitorCorrected: change.counts.competitor.after,
      reason: input.reason,
    }, user.id);
    return r!;
  });
  return { recorded: true, correction: toCorrection(row), corrected };
}

/**
 * Unsent prospect-facing drafts that restate a count the correction
 * changed: approved-but-unsent Touch 1/2/3 drafts whose frozen snapshot
 * carries the ORIGINAL counts. Superseded with the reason (the sequence
 * scheduler renders the next touch afresh from the corrected overlay when
 * the operator resumes). Returns the ids retired.
 */
export async function retireDraftsStatingOriginal(prospectId: string, correction: EvidenceCorrection): Promise<string[]> {
  const o = correction.originalSnapshot;
  const rows = await sql`
    update outreach_drafts set status = 'superseded', scheduled_send_at = null, send_claimed_at = null,
      last_send_error = ${`Spec 130 evidence correction ${correction.id.slice(0, 8)}: frozen counts ${o.prospect.recommendationCount}/${o.competitor.recommendationCount} superseded by ${correction.correctedSnapshot.prospect.recommendationCount}/${correction.correctedSnapshot.competitor.recommendationCount}.`}
    where prospect_id = ${prospectId} and status = 'approved' and sent_recorded_at is null
      and evidence_snapshot is not null
      and (evidence_snapshot->'prospect'->>'recommendationCount')::int = ${o.prospect.recommendationCount}
      and (evidence_snapshot->'competitor'->>'recommendationCount')::int = ${o.competitor.recommendationCount}
      and evidence_snapshot->>'runId' = ${o.runId}
    returning id
  `;
  return rows.map((r) => r.id as string);
}
