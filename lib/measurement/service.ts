/**
 * Measurement v2 services (spec 151 A5, A8): freeze a project's competitor
 * cohort and pin its measurement instrument. Both are versioned and
 * insert-only — a change is an explicit new version with a reason, audited.
 */
import { z } from "zod";
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  currentCohortMembers,
  insertCohort,
  insertInstrument,
  latestCohort,
  pinnedInstrument,
  type CompetitorCohort,
  type InstrumentProvider,
  type MeasurementInstrument,
} from "@/db/measurement";
import { DEFAULT_INSTRUMENT_ENV, defaultMeasurementInstrument } from "@/lib/measurement/constants";

const cohortSchema = z.object({
  projectId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

/** Freeze the current competitors + subject as the next cohort version. */
export async function freezeCompetitorCohort(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ cohortId: string; version: number; size: number }>> {
  const parsed = cohortSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const cohort = await sql.begin((tx) => freezeCohortTx(tx, parsed.data.projectId, parsed.data.reason, user.id));
    return ok({ cohortId: cohort.id, version: cohort.version, size: cohort.companyIds.length });
  } catch (err) {
    return fail(err);
  }
}

/** Transactional core, reused by baseline freezing and onboarding. Returns
 * the latest cohort unchanged when membership has not changed (idempotent). */
export async function freezeCohortTx(
  tx: TransactionSql,
  projectId: string,
  reason: string,
  userId: string | null
): Promise<CompetitorCohort> {
  // Serialize concurrent freezes for one project.
  await tx`select pg_advisory_xact_lock(hashtext(${`cohort:${projectId}`}))`;
  const { subjectId, companyIds } = await currentCohortMembers(projectId);
  if (companyIds.length === 0) {
    throw new ClassifiedError("conflict", "Project has no subject or competitors to freeze.");
  }
  const existing = await latestCohort(projectId);
  const same =
    existing !== null &&
    existing.subjectCompanyId === subjectId &&
    [...existing.companyIds].sort().join(",") === [...companyIds].sort().join(",");
  if (same) return existing;
  const cohort = await insertCohort(tx, { projectId, subjectCompanyId: subjectId, companyIds, reason, createdBy: userId });
  await writeAudit(tx, {
    userId,
    action: "measurement.cohort_frozen",
    entity: "project",
    entityId: projectId,
    detail: { cohortId: cohort.id, version: cohort.version, size: companyIds.length, reason },
  });
  return cohort;
}

const providerSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  repetitions: z.number().int().min(1).max(10),
});
const instrumentSchema = z.object({
  projectId: z.string().uuid(),
  providers: z.array(providerSchema).min(1),
  reason: z.string().trim().min(3).max(500),
});

/** Pin a new instrument version for a project (explicit, audited). */
export async function pinMeasurementInstrument(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ instrumentId: string; version: number }>> {
  const parsed = instrumentSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const pinned = await sql.begin(async (tx) => {
      const row = await insertInstrument(tx, { ...parsed.data, createdBy: user.id });
      await writeAudit(tx, {
        userId: user.id,
        action: "measurement.instrument_pinned",
        entity: "project",
        entityId: parsed.data.projectId,
        detail: { instrumentId: row.id, version: row.version, reason: parsed.data.reason },
      });
      return row;
    });
    return ok({ instrumentId: pinned.id, version: pinned.version });
  } catch (err) {
    return fail(err);
  }
}

/**
 * The instrument a project measures with: its pin, or — first use — the
 * named default, pinned so every later run of that project repeats it.
 * Never "whatever run finished last anywhere" (the audit's M6).
 */
export async function ensurePinnedInstrument(
  projectId: string,
  userId: string | null,
  reason = "default instrument pinned at first use"
): Promise<MeasurementInstrument> {
  const existing = await pinnedInstrument(projectId);
  if (existing) return existing;
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`instrument:${projectId}`}))`;
    const again = await pinnedInstrument(projectId);
    if (again) return again;
    // A project that already measured keeps ITS instrument: the first pin
    // copies its own latest completed run (review finding M5), so pinning
    // never silently changes an existing market's comparability. Only a
    // project that has never run gets the named default.
    const [own] = await tx`
      select providers from runs
      where project_id = ${projectId} and status = 'completed' and providers != '[]'::jsonb
      order by completed_at desc nulls last limit 1
    `;
    if (own && Array.isArray(own.providers) && own.providers.length > 0) {
      return insertInstrument(tx, {
        projectId,
        providers: own.providers as InstrumentProvider[],
        reason: `${reason} (copied from this project's latest completed run)`,
        createdBy: userId,
      });
    }
    const fallback = defaultMeasurementInstrument();
    return insertInstrument(tx, {
      projectId,
      providers: fallback.providers,
      reason: fallback.source === "env_override" ? `${reason} (default from ${DEFAULT_INSTRUMENT_ENV})` : reason,
      createdBy: userId,
    });
  });
}

export type { InstrumentProvider };
