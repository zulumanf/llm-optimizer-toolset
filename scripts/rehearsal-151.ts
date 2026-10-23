/**
 * Release 151 production-like rehearsal — LOCAL DATABASES ONLY.
 *
 *   DATABASE_URL=postgres://localhost:5433/<local-copy> npx tsx scripts/rehearsal-151.ts [--project <uuid>]
 *
 * Intended input: a local restore of a production backup (scripts/restore.sh)
 * that has been SANITIZED (scripts/sanitize-copy.ts — it refuses a copy with
 * real answers otherwise), so the rehearsal runs over real captured answers
 * without personal data and without touching production. It refuses any non-local host, strips provider keys and
 * outreach credentials from its own environment, and performs no external
 * call: no AI provider, no email, no CMS, no billing.
 *
 * Steps (each logged with its result):
 *   1. migrate up (spec 151 on the copy)
 *   2. rescore history (v1.2 only)
 *   3. cutover verify → apply → rollback drill
 *   4. pick a market project with ≥ 2 finished runs; freeze its cohort
 *   5. gap analysis + optimization plan; approve the top opportunity
 *   6. RETROSPECTIVE experiment: earliest runs as baseline, latest as post,
 *      no intervention shipped — exercises the evaluator on real panels and
 *      must not be read as an effect of anything
 *   7. brokerage organization over the project's measured companies + roster
 *   8. report draft (measurement v2 section) — draft only, never published
 *   9. unit economics for the window
 * Output: a JSON log written to stdout (and --out <file> if given).
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
for (const key of Object.keys(process.env)) {
  if (/^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|PERPLEXITY|XAI|ELEVENLABS|BRAVE)_/i.test(key) || /GMAIL|SMTP|STRIPE/i.test(key)) {
    delete process.env[key];
  }
}
delete process.env.OLLAMA_URL;
process.env.OLLAMA_URL = "http://127.0.0.1:1"; // fail closed, never reach a real host

async function main(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`refusing: ${url.hostname} is not a local database. Restore a backup locally and point DATABASE_URL at it.`);
  }
  const outIdx = process.argv.indexOf("--out");
  const projectIdx = process.argv.indexOf("--project");
  const log: Record<string, unknown> = { database: `${url.hostname}:${url.port}${url.pathname}`, startedAt: new Date().toISOString() };
  const step = async <T,>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const t0 = Date.now();
    try {
      const value = await fn();
      log[name] = { ok: true, ms: Date.now() - t0, value };
      return value;
    } catch (err) {
      log[name] = { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
      return null;
    }
  };

  const { migrate } = await import("./migrate");
  await step("1_migrate", async () => {
    const lines: string[] = [];
    await migrate("up", process.env.DATABASE_URL as string, (l) => lines.push(l));
    return lines;
  });

  const { sql } = await import("@/db/client");
  const [admin] = await sql`select id, email, name, role from users where role = 'admin' and active order by created_at limit 1`;
  if (!admin) throw new Error("no admin user in this database");
  const user = { id: admin.id as string, email: admin.email as string, name: admin.name as string, role: "admin" } as import("@/lib/auth").CurrentUser;

  const [{ real, mock }] = (await sql`
    select count(*) filter (where provider <> 'mock')::int as real, count(*) filter (where provider = 'mock')::int as mock
    from responses where error is null
  `) as unknown as [{ real: number; mock: number }];
  log.dataKind = real > 0 ? `real captured answers: ${real} (mock: ${mock})` : `NO real answers (mock: ${mock}) — synthetic rehearsal only`;
  // Real data must come from a sanitized copy (scripts/sanitize-copy.ts).
  const [stamp] = await sql`select shobj_description(oid, 'pg_database') as c from pg_database where datname = current_database()`;
  log.sanitized = (stamp?.c as string | null) ?? null;
  if (real > 0 && !String(stamp?.c ?? "").startsWith("rf-sanitized")) {
    throw new Error("refusing: this database holds real answers but is not sanitized. Run scripts/sanitize-copy.ts --confirm on it first.");
  }

  const { computeScores } = await import("@/lib/scoring/compute");
  await step("2_rescore", async () => {
    const runs = await sql`select id from runs where status in ('completed', 'partial') order by started_at`;
    let scored = 0;
    const skipped: string[] = [];
    for (const r of runs) {
      try {
        await computeScores(r.id as string, { publishMovement: false, writeLegacy: false });
        scored += 1;
      } catch (err) {
        skipped.push(`${r.id as string}: ${err instanceof Error ? err.message : "?"}`);
      }
    }
    return { runs: runs.length, scored, skipped: skipped.slice(0, 20) };
  });

  const cutover = await import("@/lib/scoring/cutover");
  await step("3_cutover_drill", async () => {
    const v = await cutover.verifyCutover();
    const applied = await cutover.applyCutover({ reason: "rehearsal-151 drill", changedBy: "rehearsal", acceptDifferences: true, acceptUncovered: true });
    await cutover.rollbackCutover("rehearsal-151 drill rollback", "rehearsal");
    return {
      runsWithLegacy: v.runsWithLegacy,
      missingScores: v.runsMissingV12Scores.length,
      missingEstimates: v.runsMissingV12Estimates.length,
      parityChecked: v.parityChecked,
      parityDifferences: v.parityDifferences.length,
      parityExamples: v.parityDifferences.slice(0, 5),
      applied: applied.applied,
      rolledBack: true,
    };
  });

  const projectId =
    projectIdx >= 0
      ? (process.argv[projectIdx + 1] as string)
      : ((
          await sql`
            select r.project_id from runs r join projects p on p.id = r.project_id
            where r.status in ('completed', 'partial') and p.subject_company_id is not null
            group by r.project_id having count(*) >= 2
            order by max(r.started_at) desc limit 1
          `
        )[0]?.projectId as string | undefined);
  log.projectId = projectId ?? null;
  if (!projectId) {
    log.stop = "no project with ≥ 2 finished runs and a subject";
  } else {
    const runs = await sql`
      select id, started_at from runs where project_id = ${projectId} and status in ('completed', 'partial') order by started_at
    `;
    const measurement = await import("@/lib/measurement/service");
    await step("4_cohort", () => measurement.freezeCompetitorCohort(user, { projectId, reason: "rehearsal-151" }));

    const gaps = await import("@/lib/gaps/service");
    const plan = await import("@/lib/optimization/plan");
    await step("5a_gap_analysis", () => gaps.analyzeRun(user, { runId: runs.at(-1)!.id }));
    await step("5b_plan", () => plan.buildOptimizationPlan(user, { projectId }));
    await step("5c_approve_top", async () => {
      const list = await plan.listOpportunities(user, projectId);
      const top = list.find((o) => o.status === "proposed");
      return top ? plan.transitionOpportunity(user, { opportunityId: top.id, to: "approved", note: "rehearsal" }) : "no proposed opportunity";
    });

    await step("6_retrospective_experiment", async () => {
      if (runs.length < 2) return "needs ≥ 2 runs";
      const { estimatesForRun } = await import("@/db/measurement");
      const latest = runs.at(-1)!;
      const est = await estimatesForRun(latest.id as string, "v1.2");
      const [subject] = await sql`select subject_company_id from projects where id = ${projectId}`;
      const inst = est.find((e) => e.companyId === subject?.subjectCompanyId && e.metric === "recommendation_rate");
      if (!inst) return "no v1.2 estimate for the subject";
      const exp = await import("@/lib/experiments/service");
      const draft = await exp.createPlanDraft(user, {
        projectId,
        hypothesis: "RETROSPECTIVE DRY RUN — no intervention shipped; exercises the evaluator on real panels.",
        interventionType: "rehearsal_retrospective",
        entityCompanyId: subject!.subjectCompanyId,
        instrumentKey: inst.instrumentKey,
        primaryMetric: "recommendation_rate",
        mde: 0.1,
        design: "descriptive",
        plannedImplementation: "None (retrospective).",
        baselineRunIds: runs.slice(0, -1).map((r) => r.id as string),
      });
      if (!draft.ok) return draft;
      const approved = await exp.approvePlan(user, { planId: draft.data.planId, singleBaselineReason: "retrospective rehearsal" });
      const [version] = await sql`select prompt_set_version_id from runs where id = ${latest.id}`;
      const [intervention] = await sql`
        insert into interventions (project_id, title, shipped_at, prompt_set_version_id)
        values (${projectId}, 'REHEARSAL — nothing shipped', (${latest.startedAt}::timestamptz - interval '1 day')::date, ${version!.promptSetVersionId})
        returning id
      `;
      await sql`insert into intervention_runs (intervention_id, run_id, role) values (${intervention!.id}, ${latest.id}, 'post')`;
      // Link is refused unless approved; the plan predates "shipping" only in
      // simulated time, so the evaluator will (correctly) mark it tier ≤ 2.
      const link = approved.ok ? await exp.linkPlanIntervention(user, { planId: draft.data.planId, interventionId: intervention!.id as string }) : approved;
      const evaluation = await exp.evaluatePlan(user, draft.data.planId);
      return { approved: approved.ok, linked: link.ok, evaluation: evaluation.evaluation };
    });

    await step("7_brokerage_roster", async () => {
      const orgs = await import("@/lib/organizations/service");
      const org = await orgs.createOrganization(user, { name: `Rehearsal brokerage ${new Date().toISOString().slice(0, 10)}` });
      if (!org.ok) return org;
      const members = await sql`
        select distinct e.company_id from score_estimates e join runs r on r.id = e.run_id
        join projects p on p.id = r.project_id
        where p.kind = 'prospect' and p.market_id is not null and e.scoring_version = 'v1.2'
        limit 5
      `;
      for (const m of members) await orgs.addOrganizationEntity(user, { organizationId: org.data.organizationId, companyId: m.companyId, level: "team" });
      const roster = await orgs.organizationRoster(user, org.data.organizationId);
      return { members: roster.rows.length, withEstimates: roster.rows.filter((r) => r.recommended.length > 0).length };
    });

    await step("8_report_draft", async () => {
      const reports = await import("@/lib/reports/service");
      const first = runs[0]!.startedAt as Date;
      const last = runs.at(-1)!.startedAt as Date;
      const r = await reports.generateReportDraft(user, {
        projectId,
        title: `Rehearsal ${new Date().toISOString()}`,
        periodStart: first.toISOString().slice(0, 10),
        periodEnd: new Date(last.getTime() + 86400000).toISOString().slice(0, 10),
      });
      if (!r.ok) return r;
      const m = (r.data.body as import("@/lib/reports/types").ReportBody).measurement;
      return { estimates: m?.estimates.length ?? 0, changes: m?.changes.map((c) => c.status) ?? [], experiments: m?.experiments.length ?? 0 };
    });

    await step("9_economics", async () => {
      const econ = await import("@/lib/economics/service");
      const from = (runs[0]!.startedAt as Date).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const report = await econ.unitEconomics(user, { from, to, projectId });
      return report.projects[0] ?? null;
    });
  }

  log.finishedAt = new Date().toISOString();
  const json = JSON.stringify(log, null, 2);
  console.log(json);
  if (outIdx >= 0) writeFileSync(process.argv[outIdx + 1] as string, json);
  await sql.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
