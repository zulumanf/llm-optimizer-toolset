/**
 * Spec 151 C — local end-to-end rehearsal of client delivery on the mock
 * provider: measurement setup → two baseline waves → initial analysis →
 * optimization plan → approval → pre-registered experiment → post wave →
 * evaluation → outcome + labor capture → economics. Counts every human
 * action so the remaining manual steps are visible.
 *
 * This is a REHEARSAL over fabricated mock answers. It validates wiring,
 * not commercial delivery; nothing here is a client result.
 * (Signing/quotes/agreements are covered by client-engagement-dry-run.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { operatorUser } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("client lifecycle rehearsal (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let core: typeof import("@/workers/core");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let competitorSvc: typeof import("@/lib/competitors/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let measurement: typeof import("@/lib/measurement/service");
  let onboarding: typeof import("@/lib/onboarding/service");
  let experiments: typeof import("@/lib/experiments/service");
  let econ: typeof import("@/lib/economics/service");
  const user = operatorUser();

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    core = await import("@/workers/core");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    competitorSvc = await import("@/lib/competitors/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    measurement = await import("@/lib/measurement/service");
    onboarding = await import("@/lib/onboarding/service");
    experiments = await import("@/lib/experiments/service");
    econ = await import("@/lib/economics/service");
  });
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  async function drain(): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      const out = await core.dispatchOnce("rehearsal-worker");
      if (out.status === "idle") return;
    }
    throw new Error("queue did not drain");
  }

  const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
    if (!r.ok) throw new Error(r.error.message);
    return r.data;
  };

  it("takes a synthetic client from setup to an evaluated intervention", async () => {
    const humanActions: string[] = [];
    const human = <T,>(label: string, value: T) => {
      humanActions.push(label);
      return value;
    };

    // --- setup (operator) -------------------------------------------------
    const project = unwrap(human("create project", await projectSvc.createProject(user, { name: "Rehearsal Client" })));
    const lumina = unwrap(await companySvc.upsertCompany(user, { name: "Lumina", domain: "lumina.io" }));
    unwrap(human("set subject", await claimsSvc.setSubjectCompany(user, { projectId: project.id, companyId: lumina.id })));
    const acme = unwrap(await companySvc.upsertCompany(user, { name: "Acme" }));
    unwrap(human("add competitor", await competitorSvc.addCompetitor(user, { projectId: project.id, companyId: acme.id, tier: "primary" })));
    const set = unwrap(await setSvc.createPromptSet(user, { projectId: project.id, name: "Buyer intent" }));
    for (let i = 0; i < 6; i += 1) {
      unwrap(await promptSvc.addPrompt(user, { setId: set.id, text: `best planning tool for teams, variant ${i}`, category: "recommendation" }));
    }
    unwrap(human("review + freeze prompts", await setSvc.freezePromptSet(user, { id: set.id })));
    const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.id}`;

    // Rehearsal uses the deterministic mock instead of the paid default.
    unwrap(
      human(
        "pin rehearsal instrument",
        await measurement.pinMeasurementInstrument(user, {
          projectId: project.id,
          providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
          reason: "local rehearsal on the mock provider",
        })
      )
    );

    // --- measurement (one confirmed action, then the system) --------------
    const prepared = unwrap(
      human(
        "confirm prepare measurement",
        await onboarding.prepareMeasurement(user, { projectId: project.id, promptSetVersionId: version!.id, budgetUsdPerWave: 1 })
      )
    );
    expect(prepared.cohortId).not.toBeNull();
    // A repeated click is refused; nothing is started twice (review M6).
    const again = await onboarding.prepareMeasurement(user, { projectId: project.id, promptSetVersionId: version!.id, budgetUsdPerWave: 1 });
    expect(again.ok).toBe(false);
    const [{ wave1s }] = (await sql`select count(*)::int as wave1s from runs where project_id = ${project.id} and label = 'Baseline wave 1'`) as unknown as [{ wave1s: number }];
    expect(wave1s).toBe(1);
    await drain();
    // Simulate the 7-day gap: wave 1 moves back in time, wave 2 becomes due.
    await sql`update runs set started_at = now() - interval '7 days' where id = ${prepared.wave1RunId}`;
    await sql`update jobs set run_after = now() where id = ${prepared.wave2JobId}`;
    await drain();

    // Simulated time: wave 2 ran yesterday; the change ships today.
    await sql`update runs set started_at = now() - interval '1 day' where project_id = ${project.id} and label = 'Baseline wave 2'`;
    const waves = await sql`select id, status from runs where project_id = ${project.id} order by started_at`;
    expect(waves.map((w) => w.status)).toEqual(["completed", "completed"]);
    const estimates = await sql`select count(*)::int as n from score_estimates where run_id = any(${waves.map((w) => w.id)})`;
    expect(estimates[0]!.n).toBeGreaterThan(0);

    // --- analysis + plan --------------------------------------------------
    const analysis = unwrap(human("run initial analysis", await onboarding.runInitialAnalysis(user, { projectId: project.id })));
    expect(analysis.findings).toBeGreaterThanOrEqual(0);
    const checklist = await onboarding.onboardingChecklist(user, project.id);
    const byKey = Object.fromEntries(checklist.steps.map((s) => [s.key, s.done]));
    expect(byKey).toMatchObject({ instrument: true, cohort: true, baseline: true });

    // --- experiment -------------------------------------------------------
    const promptIds = (await sql`select id from prompts where prompt_set_id = ${set.id} order by created_at`).map((p) => p.id as string);
    const draft = unwrap(
      human(
        "pre-register intervention",
        await experiments.createPlanDraft(user, {
          projectId: project.id,
          hypothesis: "A comparison page on lumina.io raises recommendation on treated prompts.",
          interventionType: "comparison_page",
          entityCompanyId: lumina.id,
          targetPromptIds: promptIds.slice(0, 3),
          controlPromptIds: promptIds.slice(3),
          instrumentKey: "mock|mock-model|prompt_text_only|provider_default",
          primaryMetric: "recommendation_rate",
          mde: 0.2,
          design: "preregistered_controlled",
          plannedImplementation: "Publish a comparison page built from approved claims.",
          baselineRunIds: waves.map((w) => w.id as string),
        })
      )
    );
    unwrap(human("approve plan", await experiments.approvePlan(user, { planId: draft.planId })));
    const [intervention] = await sql`
      insert into interventions (project_id, title, shipped_at, prompt_set_version_id)
      values (${project.id}, 'Comparison page', current_date, ${version!.id}) returning id
    `;
    humanActions.push("record what shipped");
    unwrap(human("link plan", await experiments.linkPlanIntervention(user, { planId: draft.planId, interventionId: intervention!.id })));
    await sql`insert into jobs (type, payload) values ('start_scheduled_run', ${sql.json({ interventionId: intervention!.id, offsetLabel: "+2w" })})`;
    await sql`insert into intervention_runs (intervention_id, run_id, role) select ${intervention!.id}, id, 'baseline' from runs where id = any(${waves.map((w) => w.id)})`;
    await drain();
    // Post wave dated after shipping.
    await sql`
      update runs set started_at = now() + interval '1 day'
      where id in (select run_id from intervention_runs where intervention_id = ${intervention!.id} and role = 'post')
    `;
    const { evaluation } = await experiments.evaluatePlan(user, draft.planId);
    // The mock answers identically before and after: honest null.
    expect(evaluation.comparability).toBe("comparable");
    expect(["no_detectable_change", "inconclusive"]).toContain(evaluation.verdict);
    expect(evaluation.estimate).toBe(0);

    // --- outcomes + economics ---------------------------------------------
    const today = new Date().toISOString().slice(0, 10);
    unwrap(human("record client outcome", await econ.recordClientOutcome(user, { projectId: project.id, periodStart: today, periodEnd: today, provenance: "self_reported", qualifiedLeads: 2 })));
    unwrap(human("log labor", await econ.recordLabor(user, { projectId: project.id, activity: "onboarding", minutes: 45, occurredOn: today })));
    const report = await econ.unitEconomics(user, { from: today, to: today, projectId: project.id });
    expect(report.projects[0]!.deliveryHours.value).toBeCloseTo(0.75, 6);

    // --- monthly report v2 data (draft only; publishing stays human) -----
    const { generateReportDraft } = await import("@/lib/reports/service");
    const draftReport = unwrap(
      await generateReportDraft(user, {
        projectId: project.id,
        title: "Rehearsal month",
        periodStart: new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10),
        periodEnd: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
      })
    );
    const m = (draftReport.body as import("@/lib/reports/types").ReportBody).measurement!;
    expect(m.estimates.some((e) => e.isSubject && e.low !== null)).toBe(true);
    expect(m.experiments).toHaveLength(1);
    expect(m.outcomes[0]).toMatchObject({ qualifiedLeads: 2, provenance: "self_reported" });
    expect(m.limitations.join(" ")).toMatch(/not the consumer apps/);

    // The measured human footprint of this rehearsal (spec 151 C acceptance).
    expect(humanActions).toEqual([
      "create project",
      "set subject",
      "add competitor",
      "review + freeze prompts",
      "pin rehearsal instrument",
      "confirm prepare measurement",
      "run initial analysis",
      "pre-register intervention",
      "approve plan",
      "record what shipped",
      "link plan",
      "record client outcome",
      "log labor",
    ]);
  });
});
