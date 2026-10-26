/**
 * Spec 154: a baseline is frozen only under a client-accepted protocol over
 * a client-approved question version. Suites that freeze baselines walk that
 * path through the real services — no hand-inserted protocol rows.
 */
import type { CurrentUser } from "@/lib/auth";

const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};

export async function agreeProtocol(
  user: CurrentUser,
  engagementId: string,
  opts: { runId?: string; provider: string; repetitions?: number; successCriteria?: string }
): Promise<{ runId: string; protocolId: string; versionId: string }> {
  const { sql } = await import("@/db/client");
  const eng = await import("@/lib/engagements/service");
  const delivery = await import("@/lib/engagements/delivery");
  const { getSubjectCompany } = await import("@/db/companies");
  const e = (await eng.getEngagement(engagementId))!;
  let runId = opts.runId ?? null;
  if (!runId && e.prospectId) {
    const [b] = await sql`select run_id from prospect_benchmarks where prospect_id = ${e.prospectId} order by created_at desc limit 1`;
    runId = (b?.runId as string | null) ?? null;
  }
  if (!runId) throw new Error("agreeProtocol: no run to agree a protocol for");
  const [run] = await sql`select prompt_set_version_id from runs where id = ${runId}`;
  const versionId = run!.promptSetVersionId as string;
  const subject = (await getSubjectCompany(e.projectId))!;
  unwrap(await delivery.recordSubjectDecision(user, { engagementId, subjectKind: "question_set", subjectRef: versionId, decision: "approved", channel: "email", clientActor: "Test Client" }));
  const draft = unwrap(
    await delivery.saveProtocolDraft(user, {
      engagementId,
      promptSetVersionId: versionId,
      provider: opts.provider,
      model: "mock-model",
      geographicContext: "Test market (fixture)",
      repetitions: opts.repetitions ?? 3,
      baselineWindow: "Fixture window",
      finalWindow: "Fixture final window",
      successCriteria: opts.successCriteria ?? "Fixture success criteria (test only).",
      entityAliases: [subject.name],
    })
  );
  unwrap(await delivery.acceptProtocol(user, { protocolId: draft.protocolId, clientActor: "Test Client", channel: "email" }));
  return { runId, protocolId: draft.protocolId, versionId };
}

/**
 * agreeProtocol, then freeze the way an operator does (spec 160): the run is
 * re-parsed with the classifier (the suite's default parse is the keyword
 * fallback, which a baseline refuses), previewed, and locked with the
 * previewed answer count. Files using this must mock the classifier module
 * (see tests/helpers/mock-classifier.ts).
 */
export async function agreeAndFreeze(user: CurrentUser, engagementId: string, opts: { runId?: string; provider: string }) {
  const { classifierReparse } = await import("./mock-classifier");
  const source = await defaultRun(engagementId, opts.runId);
  // Spec 160 A2: a client baseline is captured on the client's own project —
  // never the prospect's benchmark run.
  const clientRun = await captureOnClientProject(user, engagementId, source);
  const { runId } = await agreeProtocol(user, engagementId, { ...opts, runId: clientRun });
  await classifierReparse(runId);
  return freezeConfirmed(user, engagementId, runId, opts.provider);
}

async function defaultRun(engagementId: string, runId?: string): Promise<string> {
  if (runId) return runId;
  const { sql } = await import("@/db/client");
  const eng = await import("@/lib/engagements/service");
  const e = (await eng.getEngagement(engagementId))!;
  const [b] = e.prospectId ? await sql`select run_id from prospect_benchmarks where prospect_id = ${e.prospectId} order by created_at desc limit 1` : [];
  if (!b) throw new Error("agreeAndFreeze: no run to measure");
  return b.runId as string;
}

/**
 * The same questions, captured fresh on the engagement's own project (a new
 * frozen question set, a mock run with capture reuse OFF — spec B makes that
 * the client default), fully drained: execute → parse → score. Returns the
 * source run unchanged when it already belongs to the engagement's project.
 */
export async function captureOnClientProject(user: CurrentUser, engagementId: string, sourceRunId: string): Promise<string> {
  const { sql } = await import("@/db/client");
  const eng = await import("@/lib/engagements/service");
  const e = (await eng.getEngagement(engagementId))!;
  const [src] = await sql`
    select r.project_id, r.providers, v.frozen_prompts from runs r join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id = ${sourceRunId}
  `;
  if (!src) throw new Error("captureOnClientProject: source run not found");
  if (src.projectId === e.projectId) return sourceRunId;
  const setSvc = await import("@/lib/prompts/set-service");
  const promptSvc = await import("@/lib/prompts/prompt-service");
  const runSvc = await import("@/lib/runs/service");
  const set = unwrap(await setSvc.createPromptSet(user, { projectId: e.projectId, name: "Client baseline questions (fixture)" }));
  const prompts = (src.frozenPrompts as { text: string; category: string; position?: number }[]).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const q of prompts) unwrap(await promptSvc.addPrompt(user, { setId: set.id, text: q.text, category: q.category }));
  unwrap(await setSvc.freezePromptSet(user, { id: set.id }));
  const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.id}`;
  const run = unwrap(await runSvc.startRun(user, { projectId: e.projectId, promptSetVersionId: version!.id as string, providers: src.providers, budgetUsd: 5, label: "Client baseline capture (fixture)" }));
  await sql`update runs set reuse_captures = false where id = ${run.id}`;
  const jobs = await import("@/db/jobs");
  const execute = await import("@/lib/runs/execute");
  const parsing = await import("@/lib/parsing/service");
  const scoring = await import("@/lib/scoring/compute");
  for (let i = 0; i < 500; i += 1) {
    const job = await jobs.claimNextJob("fixture-worker", ["execute_run", "parse_response", "compute_scores"]);
    if (!job) break;
    if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
    else if (job.type === "parse_response") await parsing.parseResponse(job.payload.responseId as string);
    else await scoring.computeScores(job.payload.runId as string);
    await jobs.completeJob(job.id);
  }
  return run.id;
}

/** Preview, then freeze with the previewed answer count (spec 160 A3). */
export async function freezeConfirmed(user: CurrentUser, engagementId: string, runId: string, provider?: string) {
  const eng = await import("@/lib/engagements/service");
  const preview = await eng.previewBaselineFreeze(user, { engagementId, runId, provider });
  if (!preview.ok) return preview;
  return eng.freezeBaseline(user, { engagementId, runId, provider, confirmedAnswerCount: preview.data.headline?.answerCount });
}
