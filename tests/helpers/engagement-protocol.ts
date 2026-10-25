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

/** agreeProtocol, then freeze with the readiness warnings acknowledged (the
 * test pipeline parses with the keyword fallback by design). */
export async function agreeAndFreeze(user: CurrentUser, engagementId: string, opts: { runId?: string; provider: string }) {
  const eng = await import("@/lib/engagements/service");
  const { runId } = await agreeProtocol(user, engagementId, opts);
  return eng.freezeBaseline(user, { engagementId, runId, provider: opts.provider, acknowledgeWarnings: true });
}
