/**
 * Integration tests for spec 006 — draft → edit → evidence gate → publish →
 * immutable, against real Postgres with the mock provider pipeline.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { ReportBody } from "@/lib/reports/types";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000101",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("reports (integration)", () => {
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
  let reports: typeof import("@/lib/reports/service");
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
    reports = await import("@/lib/reports/service");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, reports, brand_candidates, competitors, scores,
       sources, response_parses, mentions, companies, responses, runs,
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
      await jobs.completeJob(job.id);
    }
  }

  async function seedScoredRun(promptText = "What are the best tools?"): Promise<string> {
    await companySvc.upsertCompany(user, {
      name: "Parva",
      aliases: ["parva.com"],
      isSelf: true,
    });
    const project = await projectSvc.createProject(user, { name: "Rep Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: promptText,
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
      label: "report run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return project.data.id;
  }

  // Period bounds straddle today generously: JS dates are UTC-based while
  // Postgres compares timestamptz against date in server-local time, so an
  // exact "today" breaks for a few hours around UTC midnight.
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const periodStart = day(-2);
  const periodEnd = day(2);

  it("draft lifecycle: generate (cited by construction) → edit narrative → publish → locked", async () => {
    const projectId = await seedScoredRun();
    const draft = await reports.generateReportDraft(user, {
      projectId,
      title: "Weekly",
      periodStart,
      periodEnd,
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const body = draft.data.body;
    expect(body.scores.length).toBeGreaterThan(0);
    expect(body.narrative.summary).toContain("[score:");
    expect(body.comparable).toBe(false); // first run = new baseline

    const someScoreId = body.scores[0]!.scoreId;
    const edited = await reports.updateReportNarrative(user, {
      reportId: draft.data.id,
      sectionKey: "summary",
      markdown: `Hand-written: authority context [score:${someScoreId}]. No numbers otherwise.`,
    });
    expect(edited.ok).toBe(true);

    const published = await reports.publishReport(user, { reportId: draft.data.id });
    expect(published.ok).toBe(true);

    // Immutable at the DB level
    await expect(
      sql`update reports set title = 'tampered' where id = ${draft.data.id}`
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`delete from reports where id = ${draft.data.id}`
    ).rejects.toThrow(/immutable/);

    // And via the API surface
    const lateEdit = await reports.updateReportNarrative(user, {
      reportId: draft.data.id,
      sectionKey: "summary",
      markdown: "nope",
    });
    expect(lateEdit.ok).toBe(false);
  });

  it("evidence gate blocks uncited numeric claims at publish", async () => {
    const projectId = await seedScoredRun();
    const draft = await reports.generateReportDraft(user, {
      projectId,
      title: "Gate",
      periodStart,
      periodEnd,
    });
    if (!draft.ok) throw new Error(draft.error.message);

    await reports.updateReportNarrative(user, {
      reportId: draft.data.id,
      sectionKey: "summary",
      markdown: "Our authority is 95 now and everything is great.",
    });
    const published = await reports.publishReport(user, { reportId: draft.data.id });
    expect(published.ok).toBe(false);
    if (!published.ok) expect(published.error.message).toMatch(/Evidence gate/);
  });

  it("publish with pending reviews requires explicit acknowledgment (audited)", async () => {
    const projectId = await seedScoredRun("please MOCK_AMBIGUOUS answer");
    // The ambiguous parse is pending review → no scores yet; force-compute
    // won't run — so scores are absent and draft generation reports that.
    const draftBlocked = await reports.generateReportDraft(user, {
      projectId,
      title: "Ack",
      periodStart,
      periodEnd,
    });
    expect(draftBlocked.ok).toBe(false); // no scored run in period yet

    // Clear one review path: acknowledge flow needs a scored run WITH pending
    // reviews — create a second prompt so one response scores while the
    // ambiguous one still pends? Scoring is per-run and gated, so instead:
    // resolve review, score, then create NEW pending mentions via a second run.
    const queueItems = await sql`
      select m.id from mentions m
      where m.needs_review and not exists (
        select 1 from mentions newer
        where newer.response_id = m.response_id
          and newer.company_id = m.company_id and newer.revision > m.revision
      )
    `;
    const reviewSvc = await import("@/lib/mentions/service");
    for (const item of queueItems) {
      await reviewSvc.reviewMention(user, {
        mentionId: item.id as string,
        verdict: "confirm",
      });
    }
    await drainJobs(); // scores compute now

    // Second run with a fresh ambiguous response (pending review, unscored)
    const [set] = await sql`select id from prompt_sets limit 1`;
    void set;
    const [version] = await sql`select id from prompt_set_versions limit 1`;
    const second = await runSvc.startRun(user, {
      projectId,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
      budgetUsd: 5,
      label: "second run",
    });
    if (!second.ok) throw new Error(second.error.message);
    mock.resetMockProvider();
    await drainJobs();

    const draft = await reports.generateReportDraft(user, {
      projectId,
      title: "Ack",
      periodStart,
      periodEnd,
    });
    if (!draft.ok) throw new Error(draft.error.message);
    expect(draft.data.body.coverage.pendingReview).toBeGreaterThan(0);

    const unacked = await reports.publishReport(user, { reportId: draft.data.id });
    expect(unacked.ok).toBe(false);

    const acked = await reports.publishReport(user, {
      reportId: draft.data.id,
      acknowledgePendingReviews: true,
    });
    expect(acked.ok).toBe(true);

    const [audit] = await sql`
      select detail from audit_log where action = 'report.publish'
      order by at desc limit 1
    `;
    expect((audit?.detail as { acknowledgedPendingReviews: boolean }).acknowledgedPendingReviews).toBe(true);
  });

  it("one draft per period; regenerate refreshes; discard deletes drafts only", async () => {
    const projectId = await seedScoredRun();
    const first = await reports.generateReportDraft(user, {
      projectId,
      title: "One",
      periodStart,
      periodEnd,
    });
    expect(first.ok).toBe(true);
    const dup = await reports.generateReportDraft(user, {
      projectId,
      title: "Two",
      periodStart,
      periodEnd,
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.message).toMatch(/already exists/);

    if (!first.ok) return;
    const regenerated = await reports.regenerateReportDraft(user, {
      reportId: first.data.id,
    });
    expect(regenerated.ok).toBe(true);

    const discarded = await reports.deleteDraft(user, { reportId: first.data.id });
    expect(discarded.ok).toBe(true);
  });

  it("published snapshot is self-contained: renaming the company later changes nothing", async () => {
    const projectId = await seedScoredRun();
    const draft = await reports.generateReportDraft(user, {
      projectId,
      title: "Frozen",
      periodStart,
      periodEnd,
    });
    if (!draft.ok) throw new Error(draft.error.message);
    await reports.publishReport(user, { reportId: draft.data.id });

    const [selfCompany] = await sql`select id from companies where is_self`;
    await companySvc.upsertCompany(user, {
      id: selfCompany?.id as string,
      name: "Renamed Brand",
      isSelf: true,
    });

    const [report] = await sql`select body from reports where id = ${draft.data.id}`;
    const body = report?.body as ReportBody;
    expect(body.scores.every((s) => s.companyName === "Parva")).toBe(true);
  });

  it("empty periods are rejected with a clear error", async () => {
    const projectId = await seedScoredRun();
    const result = await reports.generateReportDraft(user, {
      projectId,
      title: "Empty",
      periodStart: "2020-01-01",
      periodEnd: "2020-01-07",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/no completed runs/);
  });
});
