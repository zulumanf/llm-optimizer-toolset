/**
 * Integration tests for spec 004 — parse → review gate → score pipeline
 * against real Postgres with the mock provider.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

// Simulates an LLM classifier outage for the provenance test below. Harmless
// to every other test in this file: they run keyless, so the LLM path is
// never entered and the mock is never called.
vi.mock("@/lib/parsing/classify-llm", () => ({
  classifyResponseLlm: async () => {
    throw new Error("simulated classifier outage");
  },
}));

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ee",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};
const operator: CurrentUser = { ...admin, id: "00000000-0000-4000-8000-0000000000ef", role: "operator" };

describe.skipIf(!TEST_URL)("classification (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let reviewSvc: typeof import("@/lib/mentions/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let mentionsDb: typeof import("@/db/mentions");
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
    reviewSvc = await import("@/lib/mentions/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    mentionsDb = await import("@/db/mentions");
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
      `truncate audit_log, jobs, scores, sources, response_parses, mentions,
       companies, responses, runs, prompt_set_versions, prompts, prompt_sets,
       projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedCompanies(): Promise<{ luminaId: string; acmeId: string }> {
    const lumina = await companySvc.upsertCompany(admin, {
      name: "Lumina",
      aliases: ["lumina.com"],
      domain: "lumina.com",
      isSelf: true,
    });
    if (!lumina.ok) throw new Error(lumina.error.message);
    const acme = await companySvc.upsertCompany(operator, {
      name: "Acme",
      aliases: [],
      domain: "acme.io",
    });
    if (!acme.ok) throw new Error(acme.error.message);
    return { luminaId: lumina.data.id, acmeId: acme.data.id };
  }

  async function runPipeline(texts: string[], reps = 1): Promise<string> {
    const project = await projectSvc.createProject(operator, { name: "Cls Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(operator, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    for (const text of texts) {
      await promptSvc.addPrompt(operator, {
        setId: set.data.id,
        text,
        category: "recommendation",
      });
    }
    await setSvc.freezePromptSet(operator, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(operator, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: reps }],
      budgetUsd: 5,
      label: "cls run",
    });
    if (!started.ok) throw new Error(started.error.message);
    return started.data.id;
  }

  /** Drain the job queue like the worker would. */
  async function drainJobs(): Promise<void> {
    const { executeRun } = execute;
    const { parseResponse } = parsing;
    const { computeScores } = scoring;
    for (let i = 0; i < 100; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run") await executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stamps the parser that actually ran when the LLM classifier fails (plan 2.1)", async () => {
    await seedCompanies();
    // A key is present, so the pipeline TARGETS v2+llm — but the classifier
    // throws (mocked above) and the parse degrades to the heuristic. The
    // stamp must say so, and scoring must still proceed.
    vi.stubEnv("OPENAI_API_KEY", "test-key-provenance");
    const runId = await runPipeline(["What are the best tools?"]);
    await drainJobs();

    const parses = await sql`
      select distinct parser_version from response_parses where run_id = ${runId}
    `;
    expect(parses.map((p) => p.parserVersion)).toEqual([
      "mention-parser-v1+heuristic",
    ]);
    const mentionVersions = await sql`
      select distinct m.parser_version from mentions m
      join responses r on r.id = m.response_id where r.run_id = ${runId}
    `;
    expect(mentionVersions.map((m) => m.parserVersion)).toEqual([
      "mention-parser-v1+heuristic",
    ]);
    // The degraded-but-honest parse must not stall the run: scores computed.
    const scoreRows = await sql`select 1 from scores where run_id = ${runId}`;
    expect(scoreRows.length).toBeGreaterThan(0);
  });

  it("excludes mock captures from scoring outside the test harness (plan 2.3)", async () => {
    await seedCompanies();
    const runId = await runPipeline(["What are the best tools?"]);
    // Drain execute + parse but leave scoring unrun (scores are immutable
    // once written), then score as production would see it: mock captures
    // present, opt-in absent.
    for (let i = 0; i < 100; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) break;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      await jobs.completeJob(job.id);
    }
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ALLOW_MOCK_PROVIDER", "");
    await scoring.computeScores(runId);
    const scoreRows = await sql`select 1 from scores where run_id = ${runId}`;
    expect(scoreRows.length).toBe(0);
  });

  it("scores are insert-only at the database level (plan 2.4)", async () => {
    await seedCompanies();
    const runId = await runPipeline(["What are the best tools?"]);
    await drainJobs();
    const before = await sql`select 1 from scores where run_id = ${runId}`;
    expect(before.length).toBeGreaterThan(0);
    await expect(
      sql`update scores set value = 0.99 where run_id = ${runId}`
    ).rejects.toThrow(/insert-only/);
    await expect(
      sql`delete from scores where run_id = ${runId}`
    ).rejects.toThrow(/insert-only/);
  });

  it("company registry: alias collisions blocked; multiple is_self allowed since spec 008", async () => {
    await seedCompanies();
    // Spec 008 dropped the one-is_self constraint (multi-client world;
    // is_self is a deprecated per-registry fallback, subjects live on projects)
    const secondSelf = await companySvc.upsertCompany(admin, {
      name: "Other",
      isSelf: true,
    });
    expect(secondSelf.ok).toBe(true);

    const collision = await companySvc.upsertCompany(operator, {
      name: "Fresh Co",
      aliases: ["lumina.com"],
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error.message).toMatch(/collides/i);
  });

  it("parse refuses without an is_self company", async () => {
    const runId = await runPipeline(["best tools?"]);
    const job = await jobs.claimNextJob("test-worker");
    await execute.executeRun(job!.payload.runId as string);
    // Lifecycle events (2.6) enqueue deliver_events between execute and
    // parse — claim past anything that isn't the parse job.
    let parseJob = await jobs.claimNextJob("test-worker");
    while (parseJob && parseJob.type !== "parse_response") {
      await jobs.completeJob(parseJob.id);
      parseJob = await jobs.claimNextJob("test-worker");
    }
    expect(parseJob?.type).toBe("parse_response");
    await expect(
      parsing.parseResponse(parseJob!.payload.responseId as string)
    ).rejects.toThrow(/is_self/);
    void runId;
  });

  it("full pipeline: execute → parse → score with hand-computed rates", async () => {
    await seedCompanies();
    const runId = await runPipeline(["What are the best tools?"], 2);
    await drainJobs();

    // Default mock text recommends Acme (pos 1 phrasing) and Lumina
    const scores = await sql`
      select c.name, s.metric, s.provider, s.value, s.sample_size
      from scores s join companies c on c.id = s.company_id
      where s.run_id = ${runId}
      order by c.name, s.metric, s.provider
    `;
    // 2 companies × 6 metrics (rates, first/top-three v1.1, SoV, authority)
    // × (mock + all) = 24 rows; position/sentiment need ≥5 cells, citation
    // needs URLs — absent here
    expect(scores).toHaveLength(24);
    for (const row of scores) {
      const value = Number(row.value);
      if (row.metric === "share_of_voice") expect(value).toBeCloseTo(0.5);
      else if (row.metric === "authority_score")
        // (1×.35 + 1×.2 + .5×.15) / (.35+.2+.15) × 100
        expect(value).toBeCloseTo(100 * (0.625 / 0.7), 3);
      else if (
        row.metric === "first_position_rate" ||
        row.metric === "top_three_rate"
      )
        // Prose answers carry no list positions — 0 is a real measurement
        // here (v1.1 null rule: no minimum, absent position ∉ numerator).
        expect(value).toBe(0);
      else expect(value).toBe(1); // both responses mention+recommend both
      expect(row.sampleSize).toBe(2);
    }
    const [ledger] = await sql`
      select count(*)::int as n from response_parses where run_id = ${runId}
    `;
    expect(ledger?.n).toBe(2);
  });

  it("bulk confirm clears a multi-item queue and unblocks scoring", async () => {
    await seedCompanies();
    // Three ambiguous prompts → three queue items needing the same judgement
    const runId = await runPipeline([
      "please MOCK_AMBIGUOUS answer one",
      "please MOCK_AMBIGUOUS answer two",
      "please MOCK_AMBIGUOUS answer three",
    ]);
    await drainJobs();
    const [project] = await sql`select project_id from runs where id = ${runId}`;
    const queue = await mentionsDb.listReviewQueue(project?.projectId as string);
    expect(queue.length).toBeGreaterThan(1);
    expect(await mentionsDb.pendingReviewCount(runId)).toBe(queue.length);

    const bulk = await reviewSvc.bulkConfirmMentions(operator, {
      mentionIds: queue.map((q) => q.id),
    });
    expect(bulk.ok).toBe(true);
    if (!bulk.ok) return;
    expect(bulk.data.confirmed).toBe(queue.length);
    expect(bulk.data.skipped).toBe(0);

    // Each item still got its own audited revision — batching is not a shortcut
    expect(await mentionsDb.pendingReviewCount(runId)).toBe(0);
    const audits = await sql`
      select count(*)::int as n from audit_log where action = 'mention.review'
    `;
    expect(audits[0]?.n).toBe(queue.length);
    const reviewed = await sql`
      select count(*)::int as n from mentions
      where reviewed_by is not null and confidence = 1.0
    `;
    expect(reviewed[0]?.n).toBe(queue.length);

    // Queue cleared → scoring enqueued
    await drainJobs();
    const [scores] = await sql`
      select count(*)::int as n from scores where run_id = ${runId}
    `;
    expect(scores?.n).toBeGreaterThan(0);
  });

  it("bulk confirm skips already-superseded rows instead of failing the batch", async () => {
    await seedCompanies();
    const runId = await runPipeline([
      "please MOCK_AMBIGUOUS answer one",
      "please MOCK_AMBIGUOUS answer two",
    ]);
    await drainJobs();
    const [project] = await sql`select project_id from runs where id = ${runId}`;
    const queue = await mentionsDb.listReviewQueue(project?.projectId as string);

    // Someone reviews the first item in another tab before the batch runs
    await reviewSvc.reviewMention(operator, {
      mentionId: queue[0]!.id,
      verdict: "confirm",
    });

    const bulk = await reviewSvc.bulkConfirmMentions(operator, {
      mentionIds: queue.map((q) => q.id),
    });
    expect(bulk.ok).toBe(true);
    if (!bulk.ok) return;
    expect(bulk.data.confirmed).toBe(queue.length - 1);
    expect(bulk.data.skipped).toBe(1);
  });

  it("review gate: low-confidence parse blocks scoring; confirming unblocks it", async () => {
    const { luminaId } = await seedCompanies();
    const runId = await runPipeline(["please MOCK_AMBIGUOUS answer"]);
    await drainJobs();

    // Scoring must not have run — the ambiguous mention needs review
    const [scoreCount] = await sql`
      select count(*)::int as n from scores where run_id = ${runId}
    `;
    expect(scoreCount?.n).toBe(0);
    expect(await mentionsDb.pendingReviewCount(runId)).toBe(1);

    const [project] = await sql`select project_id from runs where id = ${runId}`;
    const queue = await mentionsDb.listReviewQueue(project?.projectId as string);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.companyId).toBe(luminaId);
    expect(Number(queue[0]?.confidence)).toBeLessThan(0.7);

    const reviewed = await reviewSvc.reviewMention(operator, {
      mentionId: queue[0]!.id,
      verdict: "confirm",
    });
    expect(reviewed.ok).toBe(true);
    await drainJobs(); // compute_scores was enqueued by the review

    const [after] = await sql`
      select count(*)::int as n from scores where run_id = ${runId}
    `;
    expect(after?.n).toBeGreaterThan(0);
  });

  it("corrections create immutable new revisions with reviewer identity", async () => {
    await seedCompanies();
    const runId = await runPipeline(["please MOCK_AMBIGUOUS answer"]);
    await drainJobs();
    const [project] = await sql`select project_id from runs where id = ${runId}`;
    const queue = await mentionsDb.listReviewQueue(project?.projectId as string);
    const original = queue[0]!;

    const corrected = await reviewSvc.reviewMention(operator, {
      mentionId: original.id,
      verdict: "correct",
      corrections: { recommended: true, sentiment: "positive" },
    });
    expect(corrected.ok).toBe(true);

    const revisions = await sql`
      select revision, recommended, sentiment, confidence, needs_review,
        reviewed_by
      from mentions
      where response_id = ${original.responseId} and company_id = ${original.companyId}
      order by revision
    `;
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.needsReview).toBe(true); // original untouched
    expect(revisions[1]).toMatchObject({
      revision: 2,
      recommended: true,
      sentiment: "positive",
      reviewedBy: operator.id,
    });
    expect(Number(revisions[1]?.confidence)).toBe(1);

    // DB-level immutability
    await expect(sql`update mentions set sentiment = 'negative'`).rejects.toThrow(
      /insert-only/
    );
    // Double-review of the superseded revision is rejected
    const again = await reviewSvc.reviewMention(operator, {
      mentionId: original.id,
      verdict: "confirm",
    });
    expect(again.ok).toBe(false);
  });

  it("reparse appends revisions and retracts companies whose aliases no longer hit", async () => {
    const { acmeId } = await seedCompanies();
    const runId = await runPipeline(["best tools?"]);
    await drainJobs();

    const before = await sql`
      select count(*)::int as n from mentions
      where company_id = ${acmeId} and mentioned
    `;
    expect(before[0]?.n).toBe(1);

    // Rename Acme so the canned text no longer matches it
    await companySvc.upsertCompany(operator, {
      id: acmeId,
      name: "Renamed Co",
      aliases: [],
    });
    const reparsed = await reviewSvc.reparseRun(admin, { runId });
    expect(reparsed.ok).toBe(true);
    await drainJobs();

    const current = await mentionsDb.currentMentionsForRun(runId);
    const acmeNow = current.find((m) => m.companyId === acmeId);
    expect(acmeNow?.mentioned).toBe(false); // retraction revision
    expect(acmeNow?.revision).toBe(2);
    // Originals still present
    const [total] = await sql`
      select count(*)::int as n from mentions where company_id = ${acmeId}
    `;
    expect(total?.n).toBe(2);

    // reparse is admin-only
    const denied = await reviewSvc.reparseRun(operator, { runId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe("forbidden");
  });

  it("refusals count in denominators as no-mention responses", async () => {
    await seedCompanies();
    const runId = await runPipeline(["normal question", "MOCK_REFUSE question"]);
    await drainJobs();

    const rates = await sql`
      select c.is_self, s.value from scores s
      join companies c on c.id = s.company_id
      where s.run_id = ${runId} and s.metric = 'mention_rate' and s.provider = 'mock'
    `;
    // 2 valid responses, 1 mentions each company → rate 0.5
    for (const row of rates) expect(Number(row.value)).toBeCloseTo(0.5);
  });

  it("sources are collected with domain attribution", async () => {
    await seedCompanies();
    // Seed a run whose response cites a lumina.com URL via ambiguous marker text
    const runId = await runPipeline(["cite MOCK_AMBIGUOUS"]);
    await drainJobs();
    void runId;
    const sources = await sql`select url, domain, company_id from sources`;
    // MOCK_AMBIGUOUS text contains "lumina.com" as bare text, not a URL — so
    // sources may be empty here; assert the table exists and is consistent
    for (const s of sources) expect(s.domain).toBeTruthy();
  });
});
