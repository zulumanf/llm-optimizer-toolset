/**
 * Audit-snapshot evidence validator (spec 052). The prospect audit page is
 * the highest-persuasion surface the company ships, and until now its
 * numbers carried no machine-checkable provenance — traceability held only
 * because the assembly code read from stored scores (a code-review
 * invariant, not an architectural one). This makes it architectural:
 * every rate rendered in the comparison must reference an immutable
 * `scores` row and match it exactly, or publication refuses.
 *
 * Deterministic — no model anywhere near it.
 */
import { sql } from "@/db/client";
import type { AuditSnapshot } from "@/lib/prospects/service";

export interface EvidenceMismatch {
  row: string;
  problem: string;
}

const RATE_FIELDS = [
  { field: "mentionRate", metric: "mention_rate" },
  { field: "recommendationRate", metric: "recommendation_rate" },
] as const;

export async function validateAuditEvidence(
  snapshot: Pick<AuditSnapshot, "comparison">
): Promise<EvidenceMismatch[]> {
  const mismatches: EvidenceMismatch[] = [];
  const allIds = snapshot.comparison.flatMap((row) =>
    Object.values(row.scoreIds ?? {})
  );
  const scoreRows = allIds.length
    ? await sql`
        select id, metric, value, sample_size from scores
        where id = any(${allIds}::uuid[])
      `
    : [];
  const byId = new Map(scoreRows.map((r) => [r.id as string, r]));

  for (const row of snapshot.comparison) {
    for (const { field, metric } of RATE_FIELDS) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      const scoreId = row.scoreIds?.[metric];
      if (!scoreId) {
        mismatches.push({
          row: row.name,
          problem: `${metric} = ${value} has no scores-row reference — an unbound number cannot be published`,
        });
        continue;
      }
      const score = byId.get(scoreId);
      if (!score) {
        mismatches.push({
          row: row.name,
          problem: `${metric} references score ${scoreId}, which does not exist`,
        });
        continue;
      }
      if (score.metric !== metric) {
        mismatches.push({
          row: row.name,
          problem: `${metric} references a ${score.metric} score row`,
        });
        continue;
      }
      if (Number(score.value) !== Number(value)) {
        mismatches.push({
          row: row.name,
          problem: `${metric} shows ${value} but the referenced immutable score is ${Number(score.value)}`,
        });
      }
      if (Number(score.sampleSize) !== Number(row.sampleSize)) {
        mismatches.push({
          row: row.name,
          problem: `sample size shows ${row.sampleSize} but the referenced score carries ${Number(score.sampleSize)}`,
        });
      }
    }
  }
  return mismatches;
}
