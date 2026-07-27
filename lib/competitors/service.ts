/**
 * Competitor tracking (spec 005): add/tier/archive competitors, promote
 * brand candidates, and backfill — retroactive parsing over recent runs so a
 * newly tracked company gets classified from existing raw data (free because
 * raw responses are immutable and complete).
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage, duplicateNameConflict } from "@/lib/service-helpers";
import { upsertCompany } from "@/lib/companies/service";
import { enqueueParseJobs } from "@/lib/parsing/service";

export const BACKFILL_RUN_LIMIT = 12;

const addSchema = z.object({
  projectId: z.string().uuid(),
  companyId: z.string().uuid(),
  tier: z.enum(["primary", "secondary"]),
});

export async function addCompetitor(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ competitorId: string; backfilledRuns: number }>> {
  const parsed = addSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { projectId, companyId, tier } = parsed.data;
  try {
    const competitorId = await sql.begin(async (tx) => {
      const [company] = await tx`
        select is_self, archived_at from companies where id = ${companyId}
      `;
      if (!company) throw new ClassifiedError("not_found", "Company not found.");
      if (company.isSelf) {
        throw new ClassifiedError(
          "validation",
          "Parva is always compared — it cannot be added as a competitor."
        );
      }
      if (company.archivedAt) {
        throw new ClassifiedError("conflict", "Company is archived.");
      }
      const [row] = await tx`
        insert into competitors (project_id, company_id, tier)
        values (${projectId}, ${companyId}, ${tier})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "competitor.add",
        entity: "competitor",
        entityId: row?.id as string,
        detail: { projectId, companyId, tier },
      });
      return row?.id as string;
    });
    const backfilledRuns = await backfillProject(projectId);
    return ok({ competitorId, backfilledRuns });
  } catch (err) {
    return fail(
      duplicateNameConflict(err, "This company is already tracked in this project.")
    );
  }
}

export async function updateCompetitorTier(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ competitorId: string }>> {
  const parsed = z
    .object({ competitorId: z.string().uuid(), tier: z.enum(["primary", "secondary"]) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid input."));
  }
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update competitors set tier = ${parsed.data.tier}
        where id = ${parsed.data.competitorId} and archived_at is null
        returning id
      `;
      if (!row) throw new ClassifiedError("not_found", "Competitor not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "competitor.update",
        entity: "competitor",
        entityId: parsed.data.competitorId,
        detail: { tier: parsed.data.tier },
      });
    });
    return ok({ competitorId: parsed.data.competitorId });
  } catch (err) {
    return fail(err);
  }
}

export async function archiveCompetitor(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ competitorId: string }>> {
  const parsed = z.object({ competitorId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid competitor id."));
  }
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update competitors set archived_at = now()
        where id = ${parsed.data.competitorId} and archived_at is null
        returning id
      `;
      if (!row) throw new ClassifiedError("not_found", "Competitor not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "competitor.archive",
        entity: "competitor",
        entityId: parsed.data.competitorId,
      });
    });
    return ok({ competitorId: parsed.data.competitorId });
  } catch (err) {
    return fail(err);
  }
}

const trackSchema = z.object({
  candidateId: z.string().uuid(),
  projectId: z.string().uuid(),
  tier: z.enum(["primary", "secondary"]),
  aliases: z.array(z.string()).optional(),
  domain: z.string().optional(),
});

/** Promote an unrecognized brand: company + competitor + backfill in one flow. */
export async function trackBrandCandidate(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ companyId: string; backfilledRuns: number }>> {
  const parsed = trackSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    const [candidate] = await sql`
      select id, name, promoted_company_id, dismissed_at
      from brand_candidates where id = ${input.candidateId}
    `;
    if (!candidate) return fail(new ClassifiedError("not_found", "Candidate not found."));
    if (candidate.promotedCompanyId) {
      return fail(new ClassifiedError("conflict", "Candidate already promoted."));
    }

    const company = await upsertCompany(user, {
      name: candidate.name as string,
      aliases: input.aliases ?? [],
      domain: input.domain,
    });
    if (!company.ok) return company;

    await sql`
      update brand_candidates set promoted_company_id = ${company.data.id}
      where id = ${input.candidateId}
    `;
    const added = await addCompetitor(user, {
      projectId: input.projectId,
      companyId: company.data.id,
      tier: input.tier,
    });
    if (!added.ok) return added;
    return ok({ companyId: company.data.id, backfilledRuns: added.data.backfilledRuns });
  } catch (err) {
    return fail(err);
  }
}

export async function dismissBrandCandidate(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ candidateId: string }>> {
  const parsed = z.object({ candidateId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid candidate id."));
  }
  try {
    await sql`
      update brand_candidates set dismissed_at = now()
      where id = ${parsed.data.candidateId}
    `;
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "brand_candidate.dismiss",
        entity: "brand_candidate",
        entityId: parsed.data.candidateId,
      })
    );
    return ok({ candidateId: parsed.data.candidateId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Re-parse the project's most recent runs so a newly tracked company gets
 * mentions from existing raw data. Bounded to BACKFILL_RUN_LIMIT (spec 005).
 * Clearing the ledger re-runs the parser; classification appends revisions
 * and retractions per the docs/03 revision model.
 */
async function backfillProject(projectId: string): Promise<number> {
  const runs = await sql`
    select id from runs
    where project_id = ${projectId} and status in ('completed', 'partial')
    order by started_at desc
    limit ${BACKFILL_RUN_LIMIT}
  `;
  for (const run of runs) {
    await sql`delete from response_parses where run_id = ${run.id}`;
    await enqueueParseJobs(run.id as string);
  }
  return runs.length;
}
