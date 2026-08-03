/**
 * Verified client claims (spec 008): every fact an agent may use has
 * canonical wording, evidence links, an as-of date, and human approval.
 * Approving supersedes the previously approved claim with the same key —
 * history is never deleted.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { publishEvent } from "@/lib/events/bus";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { resolveContradiction } from "@/lib/knowledge/contradictions/detect";

export interface Claim {
  id: string;
  projectId: string;
  key: string;
  canonicalText: string;
  value: unknown;
  asOf: string | null;
  effectiveDate: string | null;
  reviewDate: string | null;
  allowedWording: string[];
  prohibitedWording: string[];
  status: "proposed" | "approved" | "rejected" | "superseded";
  evidenceIds: string[];
  createdBy: string | null;
  approvedBy: string | null;
  createdAt: Date;
}

const COLUMNS = sql`id, project_id, key, canonical_text, value,
  to_char(as_of, 'YYYY-MM-DD') as as_of,
  to_char(effective_date, 'YYYY-MM-DD') as effective_date,
  to_char(review_date, 'YYYY-MM-DD') as review_date,
  allowed_wording, prohibited_wording,
  status, evidence_ids, created_by, approved_by, created_at`;

const proposeSchema = z.object({
  projectId: z.string().uuid(),
  key: z
    .string()
    .transform((s) => s.trim().toLowerCase().replace(/\s+/g, "_"))
    .pipe(z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, "Key must be snake_case.")),
  canonicalText: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Canonical wording is required.").max(500)),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  evidence: z
    .array(
      z.object({
        url: z.string().url(),
        note: z.string().min(1).max(500),
      })
    )
    .min(1, "A claim needs at least one evidence source."),
});

export async function proposeClaim(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Claim>> {
  assertCanWrite(user);
  const parsed = proposeSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    const claim = await sql.begin(async (tx) => {
      const evidenceIds: string[] = [];
      for (const item of input.evidence) {
        const [row] = await tx`
          insert into evidence (project_id, kind, ref_id, url, note, created_by)
          values (${input.projectId}, 'url', gen_random_uuid(), ${item.url}, ${item.note}, ${user.id})
          returning id
        `;
        evidenceIds.push(row?.id as string);
      }
      const [row] = await tx<Claim[]>`
        insert into claims (project_id, key, canonical_text, as_of,
          evidence_ids, created_by)
        values (${input.projectId}, ${input.key}, ${input.canonicalText},
          ${input.asOf ?? null}, ${evidenceIds}, ${user.id})
        returning ${COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Insert returned no row.");
      await writeAudit(tx, {
        userId: user.id,
        action: "claim.propose",
        entity: "claim",
        entityId: row.id,
        detail: { key: input.key },
      });
      return row;
    });
    return ok(claim);
  } catch (err) {
    return fail(err);
  }
}

export async function approveClaim(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ claimId: string; supersededId: string | null }>> {
  assertCanWrite(user);
  const parsed = z.object({ claimId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid claim id."));
  }
  try {
    const result = await sql.begin(async (tx) => {
      const [claim] = await tx`
        select id, project_id, key, status from claims
        where id = ${parsed.data.claimId} for update
      `;
      if (!claim) throw new ClassifiedError("not_found", "Claim not found.");
      if (claim.status !== "proposed") {
        throw new ClassifiedError("conflict", `Claim is ${claim.status}, not proposed.`);
      }
      const [previous] = await tx`
        update claims set status = 'superseded', updated_at = now()
        where project_id = ${claim.projectId} and key = ${claim.key}
          and status = 'approved'
        returning id
      `;
      await tx`
        update claims set status = 'approved', approved_by = ${user.id},
          last_verified_at = now(), updated_at = now()
        where id = ${claim.id}
      `;
      // The immutable version row: a report generated last month must stay
      // reproducible, which requires the wording as it was then (spec 018).
      await tx`
        insert into claim_versions (
          claim_id, version, canonical_text, value, normalized_predicate,
          subject_entity, object_entity_id, category, status, verification_status,
          privacy_status, allowed_wording, prohibited_wording, confidence,
          as_of, effective_date, review_date, evidence_ids, change_reason, created_by
        )
        select id, version, canonical_text, value, normalized_predicate,
          subject_entity, object_entity_id, category, 'approved', verification_status,
          privacy_status, allowed_wording, prohibited_wording, confidence,
          as_of, effective_date, review_date, evidence_ids, 'approved', ${user.id}
        from claims where id = ${claim.id}
        on conflict (claim_id, version) do nothing
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "claim.approve",
        entity: "claim",
        entityId: claim.id as string,
        detail: { key: claim.key, superseded: (previous?.id as string) ?? null },
      });
      // Publishing inside the transaction is what marks the compiled pages
      // that depend on this claim stale (spec 024). Approval and invalidation
      // commit together or not at all.
      await publishEvent(tx, {
        type: "claim.approved",
        projectId: claim.projectId as string,
        payload: { claimId: claim.id as string, subject: claim.key as string },
      });
      if (previous) {
        await publishEvent(tx, {
          type: "claim.superseded",
          projectId: claim.projectId as string,
          payload: { claimId: previous.id as string, subject: claim.key as string },
        });
      }
      return {
        claimId: claim.id as string,
        supersededId: (previous?.id as string) ?? null,
      };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

export async function rejectClaim(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ claimId: string }>> {
  assertCanWrite(user);
  const parsed = z.object({ claimId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid claim id."));
  }
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update claims set status = 'rejected', updated_at = now()
        where id = ${parsed.data.claimId} and status = 'proposed'
        returning id, key
      `;
      if (!row) {
        throw new ClassifiedError("conflict", "Only proposed claims can be rejected.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "claim.reject",
        entity: "claim",
        entityId: row.id as string,
        detail: { key: row.key as string },
      });
    });
    return ok({ claimId: parsed.data.claimId });
  } catch (err) {
    return fail(err);
  }
}

export async function setSubjectCompany(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ projectId: string }>> {
  assertCanWrite(user);
  const parsed = z
    .object({ projectId: z.string().uuid(), companyId: z.string().uuid() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid input."));
  }
  const { projectId, companyId } = parsed.data;
  try {
    await sql.begin(async (tx) => {
      const [company] = await tx`
        select archived_at from companies where id = ${companyId}
      `;
      if (!company) throw new ClassifiedError("not_found", "Company not found.");
      if (company.archivedAt) {
        throw new ClassifiedError("conflict", "Company is archived.");
      }
      const [row] = await tx`
        update projects set subject_company_id = ${companyId}
        where id = ${projectId} and status = 'active'
        returning id
      `;
      if (!row) {
        throw new ClassifiedError("conflict", "Project not found or archived.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "project.subject",
        entity: "project",
        entityId: projectId,
        detail: { companyId },
      });
    });
    return ok({ projectId });
  } catch (err) {
    return fail(err);
  }
}

export async function listClaims(projectId: string): Promise<Claim[]> {
  return sql<Claim[]>`
    select ${COLUMNS} from claims
    where project_id = ${projectId}
    order by key asc,
      case status when 'approved' then 0 when 'proposed' then 1
        when 'superseded' then 2 else 3 end,
      created_at desc
  `;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Set a claim's effective and review dates (D2, docs/pilot-launch-plan.md).
 *
 * These columns previously had no production writer, which quietly disabled
 * three things that key on them: date-window contradiction detection
 * (periodsOverlap always fell back to as_of), the expired-claim maintenance
 * detector, and the automation freshness checks — all of which reported
 * "fresh" forever because review_date was always null. `undefined` leaves a
 * date unchanged; `null` clears it.
 */
export async function setClaimDates(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ claimId: string }>> {
  assertCanWrite(user);
  const parsed = z
    .object({
      claimId: z.string().uuid(),
      effectiveDate: z.string().regex(DATE_PATTERN).nullable().optional(),
      reviewDate: z.string().regex(DATE_PATTERN).nullable().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { claimId, effectiveDate, reviewDate } = parsed.data;
  if (effectiveDate === undefined && reviewDate === undefined) {
    return fail(new ClassifiedError("validation", "Nothing to change."));
  }
  try {
    await sql.begin(async (tx) => {
      const [claim] = await tx`
        select id, key from claims where id = ${claimId} for update
      `;
      if (!claim) throw new ClassifiedError("not_found", "Claim not found.");
      await tx`
        update claims set
          effective_date = ${
            effectiveDate === undefined ? sql`effective_date` : effectiveDate
          },
          review_date = ${reviewDate === undefined ? sql`review_date` : reviewDate},
          updated_at = now()
        where id = ${claimId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "claim.dates",
        entity: "claim",
        entityId: claimId,
        detail: {
          key: claim.key,
          effectiveDate: effectiveDate === undefined ? "(unchanged)" : effectiveDate,
          reviewDate: reviewDate === undefined ? "(unchanged)" : reviewDate,
        },
      });
    });
    return ok({ claimId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Resolve or dismiss a contradiction (D2). The detector wrote into
 * claim_contradictions and nothing could ever settle one — the queue only
 * grew. Resolution requires a recorded note, and the underlying
 * resolveContradiction publishes claim.conflict_resolved inside the same
 * transaction so dependent pages invalidate with it.
 */
export async function resolveClaimContradiction(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ contradictionId: string }>> {
  assertCanWrite(user);
  const parsed = z
    .object({
      contradictionId: z.string().uuid(),
      status: z.enum(["resolved", "dismissed"]),
      resolution: z
        .string()
        .transform((s) => s.trim())
        .pipe(z.string().min(3, "Record how the contradiction was settled.").max(1000)),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    await sql.begin(async (tx) => {
      const resolved = await resolveContradiction(tx, {
        contradictionId: parsed.data.contradictionId,
        status: parsed.data.status,
        resolution: parsed.data.resolution,
        resolvedBy: user.id,
      });
      await writeAudit(tx, {
        userId: user.id,
        action: `claim.contradiction.${parsed.data.status}`,
        entity: "claim_contradiction",
        entityId: parsed.data.contradictionId,
        detail: { claimId: resolved.claimId, resolution: parsed.data.resolution },
      });
    });
    return ok({ contradictionId: parsed.data.contradictionId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Set a claim's allowed / prohibited wording (D4, docs/pilot-launch-plan.md).
 *
 * The columns were read in four places — packets render "never say: …" into
 * prompts — but only the demo seed ever wrote them, and nothing enforced
 * them deterministically. With this writer plus the validateContent gate,
 * prohibited wording becomes a rule the draft physically cannot pass with,
 * not a request the model may ignore.
 */
export async function setClaimWording(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ claimId: string }>> {
  assertCanWrite(user);
  const parsed = z
    .object({
      claimId: z.string().uuid(),
      allowedWording: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
      prohibitedWording: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { claimId, allowedWording, prohibitedWording } = parsed.data;
  if (allowedWording === undefined && prohibitedWording === undefined) {
    return fail(new ClassifiedError("validation", "Nothing to change."));
  }
  try {
    await sql.begin(async (tx) => {
      const [claim] = await tx`
        select id, key, project_id from claims where id = ${claimId} for update
      `;
      if (!claim) throw new ClassifiedError("not_found", "Claim not found.");
      await tx`
        update claims set
          allowed_wording = ${
            allowedWording === undefined ? sql`allowed_wording` : allowedWording
          },
          prohibited_wording = ${
            prohibitedWording === undefined ? sql`prohibited_wording` : prohibitedWording
          },
          updated_at = now()
        where id = ${claimId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "claim.wording",
        entity: "claim",
        entityId: claimId,
        detail: {
          key: claim.key,
          allowedWording: allowedWording ?? "(unchanged)",
          prohibitedWording: prohibitedWording ?? "(unchanged)",
        },
      });
    });
    return ok({ claimId });
  } catch (err) {
    return fail(err);
  }
}
