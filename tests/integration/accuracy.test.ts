/**
 * Integration tests for spec 015 — accuracy monitoring: the deterministic
 * quote gate, branded-prompt coverage, idempotency, and correction tasks.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000701",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("accuracy monitoring (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let accuracy: typeof import("@/lib/accuracy/service");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    accuracy = await import("@/lib/accuracy/service");
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
      `truncate audit_log, jobs, accuracy_findings, evidence_exports,
       client_validation_observations, client_validation_runs, audit_samples,
       evidence_artifacts, content_versions, content_assets, gap_findings,
       claims, tasks, evidence, intervention_runs, interventions, reports,
       brand_candidates, competitors, scores, sources, response_parses,
       mentions, companies, responses, runs, prompt_set_versions, prompts,
       prompt_sets, projects cascade`
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

  async function seed(): Promise<{ projectId: string; runId: string }> {
    const company = await companySvc.upsertCompany(user, {
      name: "Parva",
      aliases: ["parva.io"],
      domain: "parva.io",
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name: "Accuracy Test" });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    const claim = await claimsSvc.proposeClaim(user, {
      projectId: project.data.id,
      key: "category_positioning",
      canonicalText: "Parva is a link-in-bio tool built for real estate agents.",
      evidence: [{ url: "https://parva.io", note: "homepage" }],
    });
    if (!claim.ok) throw new Error(claim.error.message);
    await claimsSvc.approveClaim(user, { claimId: claim.data.id });

    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    // A branded prompt: monitored even when the client is never mentioned
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "What is Parva?",
      category: "branded",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
      budgetUsd: 5,
      label: "accuracy run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return { projectId: project.data.id, runId: started.data.id };
  }

  /** Returns the stored response text so fixtures can quote it verbatim. */
  async function responseTextFor(runId: string): Promise<string> {
    const [row] = await sql`
      select response_text from responses where run_id = ${runId} limit 1
    `;
    return (row?.responseText as string) ?? "";
  }

  function caller(payload: unknown): AgentCaller {
    return async () => ({
      text: JSON.stringify(payload),
      tokensIn: 400,
      tokensOut: 120,
    });
  }

  it("records findings whose quotes appear verbatim in the evidence", async () => {
    const { projectId, runId } = await seed();
    const text = await responseTextFor(runId);
    const realQuote = text.slice(0, 40);

    const result = await accuracy.analyzeRunAccuracy(
      user,
      { runId },
      caller({
        findings: [
          {
            kind: "entity_confusion",
            quote: realQuote,
            claimKey: "category_positioning",
            rationale: "The answer describes a different entity of the same name.",
            confidence: 0.9,
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.findings).toBe(1);
    expect(result.data.checked).toBeGreaterThan(0);

    const [finding] = await sql`
      select kind, severity, quote, claim_id, status from accuracy_findings
      where project_id = ${projectId}
    `;
    expect(finding?.kind).toBe("entity_confusion");
    // Severity is derived in code, never taken from the model
    expect(finding?.severity).toBe("high");
    expect(finding?.claimId).not.toBeNull();
    expect(finding?.status).toBe("open");
  });

  it("REJECTS findings whose quote is not in the response (fabrication gate)", async () => {
    const { projectId, runId } = await seed();
    const result = await accuracy.analyzeRunAccuracy(
      user,
      { runId },
      caller({
        findings: [
          {
            kind: "contradicted",
            quote: "Parva was founded in 1823 by Napoleon Bonaparte.",
            claimKey: null,
            rationale: "Invented assertion never present in the answer.",
            confidence: 0.99,
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.findings).toBe(0);
    expect(result.data.rejected).toBe(1);
    const rows = await sql`
      select count(*)::int as n from accuracy_findings where project_id = ${projectId}
    `;
    expect(rows[0]?.n).toBe(0);
  });

  it("is idempotent across re-analysis", async () => {
    const { runId } = await seed();
    const text = await responseTextFor(runId);
    const payload = {
      findings: [
        {
          kind: "unverifiable",
          quote: text.slice(0, 30),
          claimKey: null,
          rationale: "No approved fact covers this assertion.",
          confidence: 0.7,
        },
      ],
    };
    await accuracy.analyzeRunAccuracy(user, { runId }, caller(payload));
    const second = await accuracy.analyzeRunAccuracy(user, { runId }, caller(payload));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.findings).toBe(0); // deduped
    const [count] = await sql`select count(*)::int as n from accuracy_findings`;
    expect(count?.n).toBe(1);
  });

  it("refuses to run without approved claims", async () => {
    const { runId } = await seed();
    await sql`update claims set status = 'rejected' where status = 'approved'`;
    const result = await accuracy.analyzeRunAccuracy(user, { runId }, caller({ findings: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/approved claims/);
  });

  it("finding → evidence-backed correction task; status transitions audited", async () => {
    const { projectId, runId } = await seed();
    const text = await responseTextFor(runId);
    await accuracy.analyzeRunAccuracy(
      user,
      { runId },
      caller({
        findings: [
          {
            kind: "entity_confusion",
            quote: text.slice(0, 35),
            claimKey: "category_positioning",
            rationale: "Wrong entity described.",
            confidence: 0.95,
          },
          {
            kind: "unverifiable",
            quote: text.slice(5, 45),
            claimKey: null,
            rationale: "Unsupported assertion.",
            confidence: 0.6,
          },
        ],
      })
    );
    const findings = await sql`
      select id, kind from accuracy_findings where project_id = ${projectId}
      order by severity asc
    `;
    expect(findings).toHaveLength(2);

    const tasked = await accuracy.createCorrectionTask(user, {
      findingId: findings[0]?.id as string,
    });
    expect(tasked.ok).toBe(true);
    const [task] = await sql`
      select status, evidence_ids, priority from tasks order by created_at desc limit 1
    `;
    expect(task?.status).toBe("suggested"); // human approves
    expect((task?.evidenceIds as string[]).length).toBeGreaterThan(0);

    const [updated] = await sql`
      select status, task_id from accuracy_findings where id = ${findings[0]?.id}
    `;
    expect(updated?.status).toBe("corrected");
    expect(updated?.taskId).not.toBeNull();

    // Double-tasking blocked; dismissal works on the other finding
    const again = await accuracy.createCorrectionTask(user, {
      findingId: findings[0]?.id as string,
    });
    expect(again.ok).toBe(false);
    const dismissed = await accuracy.setFindingStatus(user, {
      findingId: findings[1]?.id as string,
      status: "dismissed",
    });
    expect(dismissed.ok).toBe(true);

    const audits = await sql`
      select action from audit_log where action like 'accuracy.%' order by at
    `;
    expect(audits.map((a) => a.action)).toEqual([
      "accuracy.analyze",
      "accuracy.dismissed",
    ]);
  });
});
