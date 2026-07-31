/**
 * Roadmap 3.3 + 3.4: the printable report route serves published snapshots
 * only (escaped, evidence-labelled), and the executive-brief generator
 * produces monthly/quarterly briefs behind the same gate as weekly.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000801",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!TEST_URL)("report delivery & executive briefs (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let executive: typeof import("@/lib/reports/executive");
  let exportHtml: typeof import("@/lib/reports/export-html");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let jobs: typeof import("@/db/jobs");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    executive = await import("@/lib/reports/executive");
    exportHtml = await import("@/lib/reports/export-html");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    jobs = await import("@/db/jobs");
    execute = await import("@/lib/runs/execute");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate executive_briefs, reports, jobs, scores, response_parses,
        mentions, sources, response_citations, brand_candidates, responses,
        runs, prompt_set_versions, prompts, prompt_sets, companies,
        audit_log, domain_events, projects cascade
    `);
  });

  async function seedScoredProject(name: string): Promise<string> {
    const company = await companySvc.upsertCompany(user, { name: `${name} Co` });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: `best tools like ${name} Co?`,
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
      label: "delivery run",
    });
    if (!started.ok) throw new Error(started.error.message);
    for (let i = 0; i < 100; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) break;
      if (job.type === "execute_run")
        await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
    return project.data.id;
  }

  it("renders a published snapshot with escaping and evidence labels", () => {
    const html = exportHtml.renderReportHtml({
      clientName: "Gambino Group",
      title: "July report",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-28",
      publishedAt: "2026-07-29T00:00:00.000Z",
      body: {
        kind: "monthly",
        scoringVersion: "v1.1",
        generatedAt: "2026-07-29",
        runs: [],
        currentRunId: "r1",
        previousRunId: null,
        comparable: false,
        comparabilityNote: "No comparable previous run.",
        scores: [
          {
            scoreId: "s1",
            companyId: "c1",
            companyName: "Gambino Group",
            isSelf: true,
            metric: "mention_rate",
            provider: "all",
            value: 0.62,
            sampleSize: 40,
          } as never,
        ],
        deltas: [],
        excerpts: [],
        coverage: {} as never,
        program: {} as never,
        categoryOwnership: [],
        narrative: {
          summary: "Visibility improved <script>alert(1)</script> materially.",
          competitors: "",
          notable_responses: "",
          suggested_actions: "",
        },
      },
    });
    expect(html).toContain("Gambino Group");
    expect(html).toContain("62.0%");
    expect(html).toContain("of 40 answers");
    expect(html).toContain("Methodology v1.1");
    // Narrative is escaped — a report can quote hostile AI output safely.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("monthly and quarterly briefs generate behind the gate, once per period", async () => {
    const projectId = await seedScoredProject("Brief Client");
    const period = { periodStart: isoDaysAgo(27), periodEnd: isoDaysAgo(0) };

    const monthly = await sql.begin((tx) =>
      executive.generateExecutiveBrief(tx, { projectId, ...period }, "monthly")
    );
    expect(monthly.gate.outcome).toBe("pass");
    expect(monthly.briefId).toBeTruthy();

    const [row] = await sql`
      select kind, period_start::text from executive_briefs
      where id = ${monthly.briefId!}
    `;
    expect(row?.kind).toBe("monthly");
    expect(row?.periodStart).toBe(period.periodStart);

    // Same period again → on-conflict no-op, not a duplicate.
    const again = await sql.begin((tx) =>
      executive.generateExecutiveBrief(tx, { projectId, ...period }, "monthly")
    );
    expect(again.gate.outcome).toBe("pass");
    expect(again.briefId).toBeNull();

    const quarterly = await sql.begin((tx) =>
      executive.generateExecutiveBrief(tx, { projectId, ...period }, "quarterly")
    );
    expect(quarterly.briefId).toBeTruthy();
    const [count] = await sql`
      select count(*)::int as n from executive_briefs where project_id = ${projectId}
    `;
    expect(count?.n).toBe(2);
  });
});
