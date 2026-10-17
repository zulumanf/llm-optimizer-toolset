/** Spec 151 B4/B5: pre-registration, freezing, linking and evaluation over real rows. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { operatorUser } from "../helpers/actors";
import { instrumentKey } from "@/lib/ai/served-model";

const TEST_URL = process.env.TEST_DATABASE_URL;
const INSTRUMENT = instrumentKey({ provider: "openai", model: "m1" });

describe.skipIf(!TEST_URL)("intervention plans (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/experiments/service");
  const user = operatorUser();
  let projectId: string;
  let versionId: string;
  let subjectId: string;
  const treated = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`);
  const control = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-9000-0000000000${String(i).padStart(2, "0")}`);

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    svc = await import("@/lib/experiments/service");
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const [project] = await sql`insert into projects (name) values ('Exp') returning id`;
    projectId = project!.id as string;
    const [s] = await sql`insert into companies (name) values ('Rivera Team') returning id`;
    subjectId = s!.id as string;
    await sql`update projects set subject_company_id = ${subjectId} where id = ${projectId}`;
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${projectId}, 'S') returning id`;
    const [version] = await sql`insert into prompt_set_versions (prompt_set_id, version, frozen_prompts) values (${set!.id}, 1, '[]') returning id`;
    versionId = version!.id as string;
  });

  /** treated prompts hit with probability-free pattern: first `treatedHits` reps hit. */
  async function seedRun(daysAgo: number, treatedHits: number): Promise<string> {
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd, started_at)
      values (${projectId}, ${versionId}, ${`wave-${daysAgo}`}, '[]', 'completed', 'manual', 1, now() - make_interval(days => ${daysAgo}))
      returning id
    `;
    for (const [group, ids] of [["t", treated], ["c", control]] as const) {
      for (const promptId of ids) {
        for (let rep = 1; rep <= 4; rep += 1) {
          const [resp] = await sql`
            insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, raw_payload, response_text, request_params)
            values (${run!.id}, ${promptId}, 'best agent?', 'openai', 'm1', ${rep}, ${sql.json({ model: "m1-served" })}, 'a',
              ${sql.json({ sampling: "provider_default" })})
            returning id
          `;
          const hit = group === "t" ? rep <= treatedHits : rep <= 1;
          await sql`
            insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
            values (${resp!.id}, ${subjectId}, true, ${hit}, 'mention-parser-v2+llm', 0.9)
          `;
        }
      }
    }
    return run!.id as string;
  }

  const draft = (baselineRunIds: string[]) => ({
    projectId,
    hypothesis: "Completing the portal profile raises recommendation on treated prompts.",
    interventionType: "profile_completion",
    entityCompanyId: subjectId,
    targetPromptIds: treated,
    controlPromptIds: control,
    instrumentKey: INSTRUMENT,
    primaryMetric: "recommendation_rate" as const,
    mde: 0.15,
    design: "preregistered_controlled" as const,
    plannedImplementation: "Fill every field of the portal profile from approved claims.",
    baselineRunIds,
  });

  it("rejects overlapping target/control prompts and controlled designs without controls", async () => {
    expect((await svc.createPlanDraft(user, { ...draft([]), controlPromptIds: [treated[0]!] })).ok).toBe(false);
    expect((await svc.createPlanDraft(user, { ...draft([]), controlPromptIds: [] })).ok).toBe(false);
  });

  it("freezes on approval, versions changes, and evaluates against post waves", async () => {
    const b1 = await seedRun(30, 1);
    const b2 = await seedRun(22, 1);
    const created = await svc.createPlanDraft(user, draft([b1, b2]));
    if (!created.ok) throw new Error(created.error.message);
    const approved = await svc.approvePlan(user, { planId: created.data.planId });
    expect(approved.ok && approved.data.baselineWaves).toBe(2);

    await expect(sql`update intervention_plans set hypothesis = 'changed' where id = ${created.data.planId}`).rejects.toThrow(/frozen/);
    await expect(sql`delete from intervention_plans where id = ${created.data.planId}`).rejects.toThrow(/forbidden/);

    const [intervention] = await sql`
      insert into interventions (project_id, title, shipped_at, prompt_set_version_id)
      values (${projectId}, 'Profile completed', (now() + interval '1 day')::date, ${versionId}) returning id
    `;
    expect((await svc.linkPlanIntervention(user, { planId: created.data.planId, interventionId: intervention!.id })).ok).toBe(true);
    await expect(sql`update intervention_plans set intervention_id = null where id = ${created.data.planId}`).rejects.toThrow(/already linked/);

    // Post wave after shipping (future-dated: the plan was approved today).
    const p1 = await seedRun(-15, 3);
    await sql`insert into intervention_runs (intervention_id, run_id, role, offset_label) values (${intervention!.id}, ${p1}, 'post', '+2w')`;
    const { evaluation } = await svc.evaluatePlan(user, created.data.planId);
    expect(evaluation.comparability).toBe("comparable");
    expect(evaluation.evidenceTier).toBe(3);
    expect(evaluation.estimator).toBe("did_control_prompts");
    // Treated 1/4 → 3/4 (+0.5), controls flat → DiD +0.5
    expect(evaluation.estimate).toBeCloseTo(0.5, 6);
    expect(evaluation.verdict).toBe("improvement_observed");

    // Release 151 offline evaluation: the no-change benchmark was recorded at
    // approval (before shipping); a prediction after shipping is refused.
    const predictions = await import("@/lib/experiments/predictions");
    const recorded = await sql`select predictor, basis from intervention_predictions where plan_id = ${created.data.planId}`;
    expect(recorded).toEqual([{ predictor: "no-change", basis: "no_change_baseline" }]);
    await sql`update interventions set shipped_at = (now() - interval '1 day')::date where id = ${intervention!.id}`;
    const late = await predictions.recordPrediction(user, {
      planId: created.data.planId, predictor: "hindsight", predictorVersion: "v1", basis: "human",
      predictedChange: 0.5, predictedLow: 0.4, predictedHigh: 0.6, probabilityImprovement: 0.99, rationale: "after the fact",
    });
    expect(late.ok).toBe(false);
    const reports = await predictions.evaluatePredictions(user);
    const baseline = reports.find((r) => r.predictor === "no-change")!;
    expect(baseline.scoredPairs + baseline.counts.not_comparable + baseline.counts.late).toBe(1);
    expect(baseline.meanAbsoluteError).toBeNull(); // one pair is never an aggregate claim
    await expect(sql`update intervention_predictions set predicted_change = 0.4`).rejects.toThrow(/insert-only/);

    const revised = await svc.revisePlan(user, { planId: created.data.planId, changes: { mde: 0.2 }, reason: "MDE recomputed from ICC" });
    expect(revised.ok && revised.data.version).toBe(2);
    const [old] = await sql`select status from intervention_plans where id = ${created.data.planId}`;
    expect(old?.status).toBe("superseded");
  });

  it("refuses a single baseline unless a reason is recorded", async () => {
    const b1 = await seedRun(10, 1);
    const created = await svc.createPlanDraft(user, draft([b1]));
    if (!created.ok) throw new Error(created.error.message);
    expect((await svc.approvePlan(user, { planId: created.data.planId })).ok).toBe(false);
    const ok = await svc.approvePlan(user, { planId: created.data.planId, singleBaselineReason: "client launch date fixed" });
    expect(ok.ok && ok.data.baselineWaves).toBe(1);
  });
});
