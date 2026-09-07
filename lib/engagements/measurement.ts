/**
 * Measurement snapshots (spec 131): the client's baseline package and every
 * remeasurement, derived from an immutable run and frozen as JSON. Counting
 * rules are the platform's one set — valid, non-holdout answers of ONE
 * provider as denominator; current-revision, echo-excluded recommendation
 * mentions; one appearance per (answer, company). The snapshot stores raw
 * answer ids so every count is re-derivable from the responses table.
 */
import { sql } from "@/db/client";
import { SCORING_VERSION } from "@/lib/constants";
import {
  MEASUREMENT_METHODOLOGY_VERSION,
  RESOLVER_POLICY_VERSION,
} from "@/lib/engagements/constants";
import type { MeasurementSnapshot, SnapshotEntity, SnapshotQuestion } from "@/lib/engagements/rules";
import { CURRENT } from "@/lib/prospects/benchmark";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import type { ProviderConfig } from "@/lib/runs/cells";
import { ClassifiedError } from "@/lib/errors";

export interface RunInstrument {
  runId: string;
  projectId: string;
  status: string;
  promptSetVersionId: string;
  providers: ProviderConfig[];
}

export async function runInstrument(runId: string): Promise<RunInstrument | null> {
  const [row] = await sql`
    select id, project_id, status, prompt_set_version_id, providers from runs where id = ${runId}
  `;
  if (!row) return null;
  return {
    runId: row.id as string,
    projectId: row.projectId as string,
    status: row.status as string,
    promptSetVersionId: row.promptSetVersionId as string,
    providers: row.providers as ProviderConfig[],
  };
}

interface EntityInput {
  companyId: string;
  name: string;
  aliases: string[];
}

async function entities(companyIds: string[]): Promise<EntityInput[]> {
  if (companyIds.length === 0) return [];
  const rows = await sql`
    select id, name, aliases from companies where id = any(${companyIds}::uuid[])
  `;
  return companyIds.map((id) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new ClassifiedError("not_found", `Company ${id} not found.`);
    return { companyId: id, name: row.name as string, aliases: (row.aliases as string[]) ?? [] };
  });
}

/**
 * Build the snapshot for one run × one provider × subject (+ competitors).
 * Never persists; callers freeze the result into engagement_measurements.
 */
export async function buildMeasurementSnapshot(input: {
  runId: string;
  provider: string;
  subjectCompanyId: string;
  competitorCompanyIds: string[];
}): Promise<MeasurementSnapshot> {
  const instrument = await runInstrument(input.runId);
  if (!instrument) throw new ClassifiedError("not_found", "Run not found.");
  const providerConfig = instrument.providers.filter((p) => p.provider === input.provider);
  if (providerConfig.length === 0) {
    throw new ClassifiedError(
      "validation",
      `Run ${input.runId.slice(0, 8)} did not query provider "${input.provider}".`
    );
  }
  const allIds = [input.subjectCompanyId, ...input.competitorCompanyIds.filter((c) => c !== input.subjectCompanyId)];
  const ents = await entities(allIds);

  const fp = sql`
    select p."promptId" as prompt_id, p.text, p.category, coalesce(p."isHoldout", false) as is_holdout
    from runs r2
    join prompt_set_versions v on v.id = r2.prompt_set_version_id,
    jsonb_to_recordset(v.frozen_prompts)
      as p("promptId" uuid, text text, category text, "isHoldout" boolean)
    where r2.id = ${input.runId}
  `;
  // Valid answers per non-holdout prompt for this provider.
  const answers = await sql`
    with fp as (${fp})
    select fp.prompt_id, fp.text, fp.category,
      array_agg(r.id order by r.repetition, r.id) filter (where r.id is not null) as response_ids,
      array_agg(distinct r.model) filter (where r.model is not null) as models,
      max(r.requested_at) as captured_at
    from fp
    left join responses r on r.prompt_id = fp.prompt_id and r.run_id = ${input.runId}
      and r.provider = ${input.provider} and r.error is null
    where not fp.is_holdout
    group by fp.prompt_id, fp.text, fp.category
    order by fp.text
  `;
  // Recommendation mentions (current revision, echo-excluded) per prompt × company.
  const recs = await sql`
    with fp as (${fp}),
    r as (
      select x.id, x.prompt_id, x.prompt_text from responses x
      join fp on fp.prompt_id = x.prompt_id
      where x.run_id = ${input.runId} and x.provider = ${input.provider}
        and x.error is null and not fp.is_holdout
    )
    select r.prompt_id, c.id as company_id, count(distinct m.response_id)::int as recommended
    from companies c
    join mentions m on m.company_id = c.id and m.recommended and ${CURRENT}
    join r on r.id = m.response_id
    where c.id = any(${allIds}::uuid[]) and ${PROMPT_ECHO_EXCLUDED}
    group by r.prompt_id, c.id
  `;
  const versions = await sql`
    select array_agg(distinct m.parser_version) as parsers,
      array_agg(distinct m.classifier_model) filter (where m.classifier_model is not null) as classifiers
    from mentions m join responses x on x.id = m.response_id
    where x.run_id = ${input.runId} and x.provider = ${input.provider}
  `;

  const recByPrompt = new Map<string, Record<string, number>>();
  for (const row of recs) {
    const key = row.promptId as string;
    const bucket = recByPrompt.get(key) ?? {};
    bucket[row.companyId as string] = Number(row.recommended);
    recByPrompt.set(key, bucket);
  }
  const questions: SnapshotQuestion[] = answers.map((a) => {
    const bucket = recByPrompt.get(a.promptId as string) ?? {};
    const competitorRecommended: Record<string, number> = {};
    for (const c of input.competitorCompanyIds) competitorRecommended[c] = bucket[c] ?? 0;
    return {
      promptId: a.promptId as string,
      text: a.text as string,
      category: (a.category as string | null) ?? null,
      answerCount: ((a.responseIds as string[] | null) ?? []).length,
      subjectRecommended: bucket[input.subjectCompanyId] ?? 0,
      competitorRecommended,
      responseIds: (a.responseIds as string[] | null) ?? [],
    };
  });
  const entity = (e: EntityInput): SnapshotEntity => ({
    companyId: e.companyId,
    name: e.name,
    aliases: e.aliases,
    recommendedCount: questions.reduce(
      (sum, q) => sum + (e.companyId === input.subjectCompanyId ? q.subjectRecommended : (q.competitorRecommended[e.companyId] ?? 0)),
      0
    ),
    distinctQuestions: questions.filter((q) =>
      (e.companyId === input.subjectCompanyId ? q.subjectRecommended : (q.competitorRecommended[e.companyId] ?? 0)) > 0
    ).length,
  });
  const subject = ents.find((e) => e.companyId === input.subjectCompanyId)!;
  const models = [...new Set(answers.flatMap((a) => ((a.models as string[] | null) ?? [])))].sort();
  const captured = answers
    .map((a) => a.capturedAt as Date | null)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    methodologyVersion: MEASUREMENT_METHODOLOGY_VERSION,
    runId: input.runId,
    sourceProjectId: instrument.projectId,
    provider: input.provider,
    models,
    repetitions: providerConfig.reduce((s, p) => s + p.repetitions, 0),
    promptSetVersionId: instrument.promptSetVersionId,
    questionCount: questions.length,
    answerCount: questions.reduce((s, q) => s + q.answerCount, 0),
    capturedAt: captured ? captured.toISOString() : null,
    subject: entity(subject),
    competitors: ents.filter((e) => e.companyId !== input.subjectCompanyId).map(entity),
    questions,
    versions: {
      scoringVersion: SCORING_VERSION,
      parserVersions: ((versions[0]?.parsers as string[] | null) ?? []).filter(Boolean).sort(),
      classifierModels: ((versions[0]?.classifiers as string[] | null) ?? []).sort(),
      resolverPolicy: RESOLVER_POLICY_VERSION,
    },
  };
}
