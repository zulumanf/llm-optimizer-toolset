/**
 * Integration tests for spec 007 — interventions, scheduled post runs,
 * verdicts, confounds, and the evidence-backed task state machine.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000201",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("attribution (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let attribution: typeof import("@/lib/attribution/service");
  let tasks: typeof import("@/lib/tasks/service");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    attribution = await import("@/lib/attribution/service");
    tasks = await import("@/lib/tasks/service");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, tasks, evidence, intervention_runs,
       interventions, reports, brand_candidates, competitors, scores, sources,
       response_parses, mentions, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      else if (job.type === "start_scheduled_run")
        await attribution.startScheduledRun(
          job.payload as { interventionId: string; offsetLabel: string }
        );
      await jobs.completeJob(job.id);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  async function seedScoredRuns(runCount = 1): Promise<{
    projectId: string;
    versionId: string;
  }> {
    await companySvc.upsertCompany(user, { name: "Parva", isSelf: true });
    const project = await projectSvc.createProject(user, { name: "Attr Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "What are the best tools?",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    for (let i = 0; i < runCount; i += 1) {
      const started = await runSvc.startRun(user, {
        projectId: project.data.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
        budgetUsd: 5,
        label: `baseline ${i + 1}`,
      });
      if (!started.ok) throw new Error(started.error.message);
    }
    await drainJobs();
    return { projectId: project.data.id, versionId: version?.id as string };
  }

  it("createIntervention proposes baselines, flags weak ones, schedules posts", async () => {
    const { projectId, versionId } = await seedScoredRuns(2);
    const created = await attribution.createIntervention(user, {
      projectId,
      title: "Comparison page",
      shippedAt: today,
      promptSetVersionId: versionId,
      postOffsets: ["+2w", "+6w"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.baselineRunIds).toHaveLength(2);
    // Two runs seconds apart are not a week apart → weak
    expect(created.data.baselineWeak).toBe(true);
    expect(created.data.scheduledOffsets).toEqual(["+2w", "+6w"]);

    const queued = await sql`
      select payload->>'offsetLabel' as off, run_after from jobs
      where type = 'start_scheduled_run' order by run_after
    `;
    expect(queued).toHaveLength(2);
    // run_after is in the future (shipped today + 14d)
    expect((queued[0]?.runAfter as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("scheduled post run executes on the same instrument and joins the intervention", async () => {
    const { projectId, versionId } = await seedScoredRuns(1);
    const created = await attribution.createIntervention(user, {
      projectId,
      title: "Docs overhaul",
      shippedAt: today,
      promptSetVersionId: versionId,
      postOffsets: ["+2w"],
    });
    if (!created.ok) throw new Error(created.error.message);

    // Simulate the +2w moment arriving
    await sql`update jobs set run_after = now() where type = 'start_scheduled_run'`;
    await drainJobs();

    const posts = await sql`
      select ir.offset_label, r.label, r.trigger, r.providers, r.status
      from intervention_runs ir join runs r on r.id = ir.run_id
      where ir.intervention_id = ${created.data.interventionId} and ir.role = 'post'
    `;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.offsetLabel).toBe("+2w");
    expect(posts[0]?.trigger).toBe("scheduled");
    expect(posts[0]?.label).toContain("+2w");
    expect(posts[0]?.status).toBe("completed"); // executed + scored via queue
    // Same instrument: identical provider config as baseline
    const [baseline] = await sql`
      select r.providers from intervention_runs ir join runs r on r.id = ir.run_id
      where ir.intervention_id = ${created.data.interventionId} and ir.role = 'baseline'
    `;
    expect(posts[0]?.providers).toEqual(baseline?.providers);

    // Verdicts computed on read (identical mock data → within noise / insufficient)
    const view = await attribution.interventionView(created.data.interventionId);
    expect(view.verdicts.length).toBeGreaterThan(0);
    expect(view.instrumentChanged).toBe(false);
    for (const verdict of view.verdicts) {
      // N=2 per side → insufficient for rate metrics; authority gets null
      expect(["insufficient", null]).toContain(verdict.verdict);
    }
  });

  it("overlapping interventions on the same version are mutually confounded", async () => {
    const { projectId, versionId } = await seedScoredRuns(1);
    const first = await attribution.createIntervention(user, {
      projectId,
      title: "First",
      shippedAt: today,
      promptSetVersionId: versionId,
      postOffsets: [],
    });
    const second = await attribution.createIntervention(user, {
      projectId,
      title: "Second",
      shippedAt: today,
      promptSetVersionId: versionId,
      postOffsets: [],
    });
    if (!first.ok || !second.ok) throw new Error("setup failed");

    const viewFirst = await attribution.interventionView(first.data.interventionId);
    const viewSecond = await attribution.interventionView(second.data.interventionId);
    expect(viewFirst.confoundedWith.map((c) => c.title)).toEqual(["Second"]);
    expect(viewSecond.confoundedWith.map((c) => c.title)).toEqual(["First"]);
  });

  it("task state machine: evidence required, approval gates, audit trail", async () => {
    const { projectId } = await seedScoredRuns(1);
    const [scoreRow] = await sql`select id from scores limit 1`;

    const noEvidence = await tasks.suggestTask(user, {
      projectId,
      title: "No proof",
      evidence: [],
    });
    expect(noEvidence.ok).toBe(false);

    const suggested = await tasks.suggestTask(user, {
      projectId,
      title: "Improve comparison content",
      priority: "p1",
      evidence: [
        { kind: "score", refId: scoreRow?.id as string, note: "Low rec rate" },
      ],
    });
    expect(suggested.ok).toBe(true);
    if (!suggested.ok) return;
    const taskId = suggested.data.taskId;

    // Can't start an unapproved task
    const early = await tasks.startTask(user, { taskId });
    expect(early.ok).toBe(false);

    expect((await tasks.approveTask(user, { taskId })).ok).toBe(true);
    expect((await tasks.startTask(user, { taskId })).ok).toBe(true);
    expect((await tasks.completeTask(user, { taskId })).ok).toBe(true);

    // Terminal — no further transitions
    expect((await tasks.approveTask(user, { taskId })).ok).toBe(false);

    const audits = await sql`
      select action from audit_log where entity = 'task' order by at
    `;
    expect(audits.map((a) => a.action)).toEqual([
      "task.suggest",
      "task.approve",
      "task.start",
      "task.complete",
    ]);
  });

  it("complete-as-intervention closes the loop in one flow", async () => {
    const { projectId, versionId } = await seedScoredRuns(1);
    const [scoreRow] = await sql`select id from scores limit 1`;
    const suggested = await tasks.suggestTask(user, {
      projectId,
      title: "Ship the pricing page",
      evidence: [
        { kind: "score", refId: scoreRow?.id as string, note: "evidence" },
      ],
    });
    if (!suggested.ok) throw new Error(suggested.error.message);
    await tasks.approveTask(user, { taskId: suggested.data.taskId });
    await tasks.startTask(user, { taskId: suggested.data.taskId });

    const completed = await tasks.completeTaskAsIntervention(user, {
      taskId: suggested.data.taskId,
      shippedAt: today,
      urls: ["https://parva.com/pricing"],
      promptSetVersionId: versionId,
      postOffsets: ["+2w"],
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    const [task] = await sql`select status from tasks where id = ${suggested.data.taskId}`;
    expect(task?.status).toBe("done");
    const [intervention] = await sql`
      select task_id, title from interventions
      where id = ${completed.data.interventionId}
    `;
    expect(intervention?.taskId).toBe(suggested.data.taskId);
    expect(intervention?.title).toBe("Ship the pricing page");
  });

  it("suggests evidence-backed tasks from notable verdicts", async () => {
    const { projectId, versionId } = await seedScoredRuns(1);
    const created = await attribution.createIntervention(user, {
      projectId,
      title: "Big launch",
      shippedAt: today,
      promptSetVersionId: versionId,
      postOffsets: ["+2w"],
    });
    if (!created.ok) throw new Error(created.error.message);
    await sql`update jobs set run_after = now() where type = 'start_scheduled_run'`;
    await drainJobs();

    // Force a notable verdict (test-only surgery on the test DB): inflate
    // sample sizes, drop the post run's recommendation_rate, and add a second
    // provider on both sides — docs/06 requires direction consistency across
    // ≥2 providers, so a single-provider setup can never reach "notable".
    await sql`update scores set sample_size = 40`;
    const [postRun] = await sql`
      select run_id from intervention_runs
      where intervention_id = ${created.data.interventionId} and role = 'post'
    `;
    await sql`
      update scores set value = 0.2
      where run_id = ${postRun?.runId} and metric = 'recommendation_rate'
    `;
    await sql`
      insert into scores (run_id, company_id, metric, provider, value,
        sample_size, scoring_version)
      select s.run_id, s.company_id, s.metric, 'openai', s.value,
        s.sample_size, s.scoring_version
      from scores s where s.provider = 'mock'
    `;

    const result = await tasks.suggestTasksFromIntervention(user, {
      interventionId: created.data.interventionId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBeGreaterThan(0);

    const [task] = await sql`
      select title, priority, evidence_ids from tasks where status = 'suggested'
      order by created_at desc limit 1
    `;
    expect(task?.title).toContain("drop in recommendation rate");
    expect(task?.priority).toBe("p1");
    expect((task?.evidenceIds as string[]).length).toBeGreaterThan(0);
  });
});
