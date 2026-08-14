/**
 * Integration tests for spec 009 — gap analysis over a real scored run and
 * the finding → suggested-task flow.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("evidence gaps (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let gaps: typeof import("@/lib/gaps/service");
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
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    gaps = await import("@/lib/gaps/service");
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
      `truncate audit_log, jobs, gap_findings, claims, tasks, evidence,
       intervention_runs, interventions, reports, brand_candidates,
       competitors, scores, sources, response_parses, mentions, companies,
       responses, runs, prompt_set_versions, prompts, prompt_sets,
       projects cascade`
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
      await jobs.completeJob(job.id);
    }
  }

  /** Subject "Nobody Inc" never appears in mock answers; Acme dominates —
   * the day-zero shape. Includes a branded prompt the model won't answer. */
  async function seedDayZeroRun(): Promise<{ projectId: string; runId: string }> {
    const nobody = await companySvc.upsertCompany(user, { name: "Nobody Inc" });
    if (!nobody.ok) throw new Error(nobody.error.message);
    await companySvc.upsertCompany(user, { name: "Acme" });
    const project = await projectSvc.createProject(user, { name: "Gap Test" });
    if (!project.ok) throw new Error(project.error.message);
    await claims.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: nobody.data.id,
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    for (const p of [
      { text: "best tools for the job?", category: "recommendation" as const },
      { text: "which tool solves my problem?", category: "problem" as const },
      // MOCK_REFUSE keeps the mock's prompt-echo from counting as brand
      // recognition — the refusal answer contains no brand names at all
      { text: "MOCK_REFUSE What is Nobody Inc known for?", category: "branded" as const },
    ]) {
      await promptSvc.addPrompt(user, { setId: set.data.id, ...p });
    }
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
      label: "gap run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return { projectId: project.data.id, runId: started.data.id };
  }

  it("analyzes a scored run into typed findings (entity, branded, category)", async () => {
    const { projectId, runId } = await seedDayZeroRun();
    const analyzed = await gaps.analyzeRun(user, { runId });
    expect(analyzed.ok).toBe(true);
    if (!analyzed.ok) return;
    expect(analyzed.data.findings).toBeGreaterThan(0);

    const rows = await sql`
      select gap_type, severity, opportunity_score, classification, confidence,
        evidence_ids, detector_version
      from gap_findings
      where project_id = ${projectId} order by opportunity_score desc
    `;
    const types = rows.map((r) => r.gapType);
    expect(types).toContain("entity");
    expect(types).toContain("branded_recognition");
    for (const row of rows) {
      expect(Number(row.opportunityScore)).toBeGreaterThan(0);
      expect(Number(row.severity)).toBeGreaterThanOrEqual(0);
      // Epistemics (spec 064): every v1.1 finding is classified, confident,
      // and evidence-backed.
      expect(row.detectorVersion).toBe("gap-detector-v1.1");
      expect(["observation", "supported_finding"]).toContain(row.classification);
      expect(Number(row.confidence)).toBeGreaterThanOrEqual(0.5);
      expect(Number(row.confidence)).toBeLessThanOrEqual(0.9);
      expect((row.evidenceIds as string[]).length).toBeGreaterThan(0);
    }

    // Every evidence id resolves to a real registry row in this project,
    // pointing at a real score or response ref.
    const allEvidenceIds = rows.flatMap((r) => r.evidenceIds as string[]);
    const evidenceRows = await sql`
      select id, kind, ref_id from evidence
      where id = any(${allEvidenceIds}::uuid[]) and project_id = ${projectId}
    `;
    expect(evidenceRows.length).toBe(new Set(allEvidenceIds).size);
    for (const ev of evidenceRows) {
      expect(["score", "response"]).toContain(ev.kind);
      const table = ev.kind === "score" ? "scores" : "responses";
      const [ref] = await sql.unsafe(
        `select 1 from ${table} where id = '${ev.refId as string}'`
      );
      expect(ref).toBeDefined();
    }

    // Idempotent: re-analysis duplicates neither findings nor evidence
    await gaps.analyzeRun(user, { runId });
    const [count] = await sql`
      select count(*)::int as n from gap_findings where run_id = ${runId}
    `;
    expect(count?.n).toBe(rows.length);
    const [evCount] = await sql`
      select count(*)::int as n from evidence where project_id = ${projectId}
    `;
    expect(evCount?.n).toBe(evidenceRows.length);
  });

  it("refuses to analyze unscored runs", async () => {
    const { runId } = await seedDayZeroRun();
    await sql`delete from gap_findings`;
    await sql.unsafe("truncate scores cascade");
    const result = await gaps.analyzeRun(user, { runId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/no scores/);
  });

  it("finding → evidence-backed suggested task; dismiss works; both audited", async () => {
    const { projectId, runId } = await seedDayZeroRun();
    await gaps.analyzeRun(user, { runId });
    const findings = await sql`
      select id from gap_findings where project_id = ${projectId}
      order by opportunity_score desc
    `;

    const tasked = await gaps.createTaskFromFinding(user, {
      findingId: findings[0]?.id as string,
    });
    expect(tasked.ok).toBe(true);
    if (!tasked.ok) return;
    const [task] = await sql`
      select id, title, status, evidence_ids from tasks
      order by created_at desc limit 1
    `;
    expect(task?.status).toBe("suggested");
    expect((task?.evidenceIds as string[]).length).toBeGreaterThan(0);
    const [f0] = await sql`
      select status, task_id, evidence_ids from gap_findings
      where id = ${findings[0]?.id}
    `;
    expect(f0?.status).toBe("task_created");
    // Traceability (spec 064): the finding records WHICH task, and the task
    // carries the finding's own evidence rows verbatim — no minted copies.
    expect(f0?.taskId).toBe(task?.id);
    expect(task?.evidenceIds).toEqual(f0?.evidenceIds);

    // Double-tasking blocked; dismissal of another finding works
    const again = await gaps.createTaskFromFinding(user, {
      findingId: findings[0]?.id as string,
    });
    expect(again.ok).toBe(false);
    const dismissed = await gaps.dismissFinding(user, {
      findingId: findings[1]?.id as string,
    });
    expect(dismissed.ok).toBe(true);

    const audits = await sql`
      select action from audit_log
      where action like 'gaps.%' or action = 'task.suggest' order by at
    `;
    expect(audits.map((a) => a.action)).toEqual([
      "gaps.analyze",
      "task.suggest",
      "gaps.dismiss",
    ]);
  });
});
