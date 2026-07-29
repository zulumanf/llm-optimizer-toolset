/**
 * Integration tests for spec 017 — the automated weekly cycle. The contract
 * under test: automation does the mechanical work and HALTS wherever a human
 * owes the client a judgement.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000001101",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("weekly cycle (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let cycles: typeof import("@/lib/cycles/service");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let baselineSvc: typeof import("@/lib/projects/baseline");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let jobs: typeof import("@/db/jobs");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    cycles = await import("@/lib/cycles/service");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    baselineSvc = await import("@/lib/projects/baseline");
    execute = await import("@/lib/runs/execute");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    jobs = await import("@/db/jobs");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, cycle_runs, notifications, accuracy_findings,
       evidence_exports, client_validation_observations, client_validation_runs,
       audit_samples, evidence_artifacts, content_versions, content_assets,
       gap_findings, claims, tasks, evidence, intervention_runs, interventions,
       reports, brand_candidates, competitors, scores, sources, response_parses,
       mentions, companies, responses, runs, prompt_set_versions, prompts,
       prompt_sets, projects, vertical_packs cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Drain everything except advance_cycle, which the tests step manually. */
  async function drainWorkerJobs(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  async function seedClient(opts: { promptText?: string } = {}): Promise<string> {
    // MOCK_AMBIGUOUS names "parva.com" — the subject must be findable for the
    // review-gate test to exercise a real low-confidence classification.
    const company = await companySvc.upsertCompany(user, {
      name: "Parva",
      aliases: ["parva.com"],
      domain: "parva.com",
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name: "Cycle Client" });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Baseline set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: opts.promptText ?? "What are the best tools?",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const configured = await baselineSvc.updateBaselineSettings(user, {
      projectId: project.data.id,
      baselinePromptSetId: set.data.id,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
      budgetUsd: 5,
    });
    if (!configured.ok) throw new Error(configured.error.message);
    return project.data.id;
  }

  it("runs a full week end to end and leaves a DRAFT pulse", async () => {
    await seedClient();
    const { started, skipped } = await cycles.startWeeklyCycles();
    expect(started).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    const cycleId = started[0]!;

    expect(await cycles.advanceCycle(cycleId)).toBe("running_benchmark");
    await drainWorkerJobs(); // capture → parse → score
    expect(await cycles.advanceCycle(cycleId)).toBe("analyzing");
    expect(await cycles.advanceCycle(cycleId)).toBe("drafting");
    expect(await cycles.advanceCycle(cycleId)).toBe("completed");

    const [cycle] = await sql`select * from cycle_runs where id = ${cycleId}`;
    expect(cycle?.state).toBe("completed");
    expect(cycle?.runId).not.toBeNull();
    expect(cycle?.reportId).not.toBeNull();
    // Gap analysis ran and recorded its result. Zero findings is a valid
    // outcome here — the mock client is recommended in every answer with no
    // citations, so there is genuinely nothing to flag. What matters is that
    // the stage executed and said so.
    const steps = (cycle?.steps as { note: string }[]).map((s) => s.note);
    expect(steps.some((n) => n.startsWith("gap findings:"))).toBe(true);
    expect(steps.some((n) => n.includes("accuracy"))).toBe(true);
    // The pulse is a DRAFT — automation never publishes
    const [report] = await sql`select status, kind from reports`;
    expect(report?.status).toBe("draft");
    expect(report?.kind).toBe("weekly_pulse");
    // Every step is recorded for the operator to read
    expect((cycle?.steps as unknown[]).length).toBeGreaterThan(3);
  });

  it("HALTS instead of deciding when classifications need review", async () => {
    await seedClient({ promptText: "please MOCK_AMBIGUOUS answer" });
    const { started } = await cycles.startWeeklyCycles();
    const cycleId = started[0]!;
    await cycles.advanceCycle(cycleId);
    await drainWorkerJobs();

    const state = await cycles.advanceCycle(cycleId);
    expect(state).toBe("halted");
    const [cycle] = await sql`select halt_reason from cycle_runs where id = ${cycleId}`;
    expect(cycle?.haltReason).toMatch(/need review/);
    // It did NOT confirm anything on the operator's behalf
    const [reviewed] = await sql`
      select count(*)::int as n from mentions where reviewed_by is not null
    `;
    expect(reviewed?.n).toBe(0);
    // …and produced no report from unreviewed data
    const [reports] = await sql`select count(*)::int as n from reports`;
    expect(reports?.n).toBe(0);
  });

  it("HALTS on a failed benchmark rather than reporting on it", async () => {
    await seedClient();
    const { started } = await cycles.startWeeklyCycles();
    const cycleId = started[0]!;
    await cycles.advanceCycle(cycleId);
    const [cycle] = await sql`select run_id from cycle_runs where id = ${cycleId}`;
    await sql`update runs set status = 'failed' where id = ${cycle?.runId}`;

    expect(await cycles.advanceCycle(cycleId)).toBe("halted");
    const [after] = await sql`select halt_reason from cycle_runs where id = ${cycleId}`;
    expect(after?.haltReason).toMatch(/failed/);
  });

  it("HALTS on a partial run — a partial week is a human call", async () => {
    await seedClient();
    const { started } = await cycles.startWeeklyCycles();
    const cycleId = started[0]!;
    await cycles.advanceCycle(cycleId);
    const [cycle] = await sql`select run_id from cycle_runs where id = ${cycleId}`;
    await sql`update runs set status = 'partial' where id = ${cycle?.runId}`;

    expect(await cycles.advanceCycle(cycleId)).toBe("halted");
    const [after] = await sql`select halt_reason from cycle_runs where id = ${cycleId}`;
    expect(after?.haltReason).toMatch(/partial/);
  });

  it("halts a client with no frozen baseline instead of failing silently", async () => {
    const project = await projectSvc.createProject(user, { name: "Unfrozen" });
    if (!project.ok) throw new Error(project.error.message);
    const company = await companySvc.upsertCompany(user, { name: "Unfrozen Co" });
    if (!company.ok) throw new Error(company.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Never frozen",
    });
    if (!set.ok) throw new Error(set.error.message);
    await sql`
      update projects set baseline_prompt_set_id = ${set.data.id},
        baseline_config = ${sql.json({ providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }], budgetUsd: 5 } as never)}
      where id = ${project.data.id}
    `;
    const { started } = await cycles.startWeeklyCycles();
    expect(await cycles.advanceCycle(started[0]!)).toBe("halted");
    const [cycle] = await sql`select halt_reason from cycle_runs`;
    expect(cycle?.haltReason).toMatch(/never been frozen/);
  });

  it("is idempotent: a second kickoff in the same week starts nothing", async () => {
    await seedClient();
    const first = await cycles.startWeeklyCycles();
    expect(first.started).toHaveLength(1);
    const second = await cycles.startWeeklyCycles();
    expect(second.started).toHaveLength(0);
    expect(second.skipped[0]?.reason).toMatch(/already exists/);
    const [count] = await sql`select count(*)::int as n from cycle_runs`;
    expect(count?.n).toBe(1);
  });

  it("skips clients with no baseline configured", async () => {
    const project = await projectSvc.createProject(user, { name: "No Baseline" });
    if (!project.ok) throw new Error(project.error.message);
    const result = await cycles.startWeeklyCycles();
    expect(result.started).toHaveLength(0);
    expect(result.skipped[0]?.reason).toMatch(/no baseline/);
  });

  it("re-entering a completed cycle is a no-op (crash-safe)", async () => {
    await seedClient();
    const { started } = await cycles.startWeeklyCycles();
    const cycleId = started[0]!;
    await cycles.advanceCycle(cycleId);
    await drainWorkerJobs();
    await cycles.advanceCycle(cycleId);
    await cycles.advanceCycle(cycleId);
    await cycles.advanceCycle(cycleId);
    const [reportsBefore] = await sql`select count(*)::int as n from reports`;

    // A duplicate advance_cycle job after a crash must not double-draft
    expect(await cycles.advanceCycle(cycleId)).toBe("completed");
    const [reportsAfter] = await sql`select count(*)::int as n from reports`;
    expect(reportsAfter?.n).toBe(reportsBefore?.n);
  });
});
