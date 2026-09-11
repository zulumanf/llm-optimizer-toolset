/**
 * Audit samples + client validation (evidence spec). Samples are
 * reproducible from a recorded seed; client-performed observations live in
 * separate tables and never enter benchmark metrics.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany } from "@/db/companies";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { selectAuditSample, mulberry32 } from "@/lib/evidence/sampler";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { CURRENT_REVISION } from "@/db/mentions";

const auditSchema = z.object({
  runId: z.string().uuid(),
  size: z.number().int().min(2).max(50),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

export async function createAuditSample(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ sampleId: string; seed: number; selected: number }>> {
  const parsed = auditSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { runId, size } = parsed.data;
  try {
    assertCanWrite(user);
    const [run] = await sql`select id, project_id from runs where id = ${runId}`;
    if (!run) return fail(new ClassifiedError("not_found", "Run not found."));
    const subject = await getSubjectCompany(run.projectId as string);
    if (!subject) return fail(new ClassifiedError("conflict", "Project has no subject."));

    const candidates = await sql`
      select r.id, r.provider, coalesce(m.mentioned, false) as positive
      from responses r
      left join mentions m on m.response_id = r.id and m.company_id = ${subject.id}
        and ${CURRENT_REVISION}
      where r.run_id = ${runId} and r.error is null
      order by r.requested_at asc
    `;
    if (candidates.length === 0) {
      return fail(new ClassifiedError("conflict", "Run has no successful observations."));
    }

    // Seed from run id bytes when not supplied — recorded either way; the
    // selection is reproducible by anyone from (seed, candidate set)
    const seed =
      parsed.data.seed ??
      Math.abs(
        [...runId].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)
      ) % 2_147_483_647;

    const result = selectAuditSample(
      candidates.map((c) => ({
        id: c.id as string,
        positive: Boolean(c.positive),
        provider: c.provider as string,
      })),
      size,
      seed
    );

    const sampleId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into audit_samples
          (run_id, seed, method, requested_size, selected_response_ids,
           constraints_met, created_by)
        values
          (${runId}, ${seed}, 'mulberry32-fisher-yates-v1', ${size},
           ${result.selectedIds}, ${tx.json(result.constraintsMet as never)},
           ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "evidence.audit_sample",
        entity: "run",
        entityId: runId,
        detail: { seed, size, selected: result.selectedIds.length },
      });
      return row?.id as string;
    });
    return ok({ sampleId, seed, selected: result.selectedIds.length });
  } catch (err) {
    return fail(err);
  }
}

const validationRunSchema = z.object({
  projectId: z.string().uuid(),
  promptSetVersionId: z.string().uuid(),
  promptCount: z.number().int().min(1).max(20),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

export async function createClientValidationRun(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ validationRunId: string; seed: number; prompts: string[] }>> {
  const parsed = validationRunSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [version] = await sql`
      select v.frozen_prompts, s.project_id
      from prompt_set_versions v join prompt_sets s on s.id = v.prompt_set_id
      where v.id = ${input.promptSetVersionId}
    `;
    if (!version) return fail(new ClassifiedError("not_found", "Frozen version not found."));
    if (version.projectId !== input.projectId) {
      return fail(new ClassifiedError("validation", "Version belongs to another project."));
    }
    const frozen = (version.frozenPrompts as FrozenPrompt[]).filter(
      (p) => !p.isHoldout
    );
    const seed = input.seed ?? Math.floor(Math.abs(Math.sin(frozen.length + 1) * 1e9));
    const rng = mulberry32(seed);
    const shuffled = [...frozen];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const picked = shuffled.slice(0, Math.min(input.promptCount, shuffled.length));

    const instructions = [
      "CLIENT VALIDATION — clean-session instructions (v1):",
      "1. Open a fresh browser session (private/incognito, logged into a normal consumer account).",
      "2. Ask each prompt below EXACTLY as written, one per new conversation.",
      "3. Capture a full screenshot of each answer and copy the complete visible response text.",
      "4. Submit each observation with the provider, date, text, and screenshot.",
      "",
      ...picked.map((p, i) => `${i + 1}. ${p.text}`),
    ].join("\n");

    const validationRunId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into client_validation_runs
          (project_id, prompt_set_version_id, seed, selected_prompt_ids,
           instructions, created_by)
        values
          (${input.projectId}, ${input.promptSetVersionId}, ${seed},
           ${picked.map((p) => p.promptId)}, ${instructions}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "evidence.validation_run",
        entity: "project",
        entityId: input.projectId,
        detail: { seed, prompts: picked.length },
      });
      return row?.id as string;
    });
    return ok({ validationRunId, seed, prompts: picked.map((p) => p.text) });
  } catch (err) {
    return fail(err);
  }
}

const validationObsSchema = z.object({
  validationRunId: z.string().uuid(),
  promptId: z.string().uuid(),
  provider: z.string().min(1).max(40),
  performedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rawResponse: z.string().min(1),
  claimedMentioned: z.boolean(),
  claimedRecommended: z.boolean(),
  screenshotArtifactId: z.string().uuid().nullable().optional(),
});

export async function recordClientValidationObservation(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ observationId: string }>> {
  const parsed = validationObsSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    // Staff records what the client performed; client accounts stay read-only
    // (spec 014) even for the validation flow that carries their name.
    assertCanWrite(user);
    const [validationRun] = await sql`
      select id, status, selected_prompt_ids from client_validation_runs
      where id = ${input.validationRunId}
    `;
    if (!validationRun) return fail(new ClassifiedError("not_found", "Validation run not found."));
    if (validationRun.status !== "open") {
      return fail(new ClassifiedError("conflict", "Validation run is closed."));
    }
    if (!(validationRun.selectedPromptIds as string[]).includes(input.promptId)) {
      return fail(new ClassifiedError("validation", "Prompt is not part of this validation run."));
    }
    const observationId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into client_validation_observations
          (validation_run_id, prompt_id, provider, performed_on, raw_response,
           screenshot_artifact_id, claimed_mentioned, claimed_recommended,
           created_by)
        values
          (${input.validationRunId}, ${input.promptId}, ${input.provider},
           ${input.performedOn}, ${input.rawResponse},
           ${input.screenshotArtifactId ?? null}, ${input.claimedMentioned},
           ${input.claimedRecommended}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "evidence.validation_observation",
        entity: "client_validation_run",
        entityId: input.validationRunId,
        detail: { provider: input.provider },
      });
      return row?.id as string;
    });
    return ok({ observationId });
  } catch (err) {
    return fail(err);
  }
}

/** Directional comparison: client-run hit-rate vs the controlled benchmark's,
 * over the same prompts — never mixed into benchmark metrics. */
export async function validationComparison(validationRunId: string): Promise<{
  clientHits: number;
  clientTotal: number;
  benchmarkHits: number;
  benchmarkTotal: number;
} | null> {
  const [validationRun] = await sql`
    select id, project_id, prompt_set_version_id, selected_prompt_ids
    from client_validation_runs where id = ${validationRunId}
  `;
  if (!validationRun) return null;
  const promptIds = validationRun.selectedPromptIds as string[];
  const subject = await getSubjectCompany(validationRun.projectId as string);

  const [client] = await sql`
    select count(*)::int as total,
      count(*) filter (where claimed_mentioned)::int as hits
    from client_validation_observations
    where validation_run_id = ${validationRunId}
  `;
  const [benchmark] = await sql`
    select count(*)::int as total, count(*) filter (where m.mentioned)::int as hits
    from responses r
    join runs on runs.id = r.run_id
    left join mentions m on m.response_id = r.id and m.company_id = ${subject?.id ?? null}
      and ${CURRENT_REVISION}
    where runs.prompt_set_version_id = ${validationRun.promptSetVersionId}
      and r.prompt_id = any(${promptIds}) and r.error is null
  `;
  return {
    clientHits: (client?.hits as number) ?? 0,
    clientTotal: (client?.total as number) ?? 0,
    benchmarkHits: (benchmark?.hits as number) ?? 0,
    benchmarkTotal: (benchmark?.total as number) ?? 0,
  };
}
