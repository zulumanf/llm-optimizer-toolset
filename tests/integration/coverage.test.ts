/**
 * Integration tests for spec 063 — prompt attribute freeze and coverage by
 * segment, end to end through the real pipeline: tag prompts → freeze →
 * run (mock provider) → parse → score → runCoverage. Expected counts are
 * cross-derived from the mentions actually written, so the assertions hold
 * whatever the mock happens to say.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000201",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("coverage (integration)", () => {
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
  let coverage: typeof import("@/lib/scoring/coverage");
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
    coverage = await import("@/lib/scoring/coverage");
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

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
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

  it("freezes segment attributes and reports coverage from real mentions", async () => {
    await companySvc.upsertCompany(user, { name: "Lumina", isSelf: true });
    const project = await projectSvc.createProject(user, { name: "Coverage Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);

    const texts = [
      "Who should sell my $5M Tribeca loft?",
      "Best listing agents for $5M+ properties?",
      "What are the best tools?",
    ];
    for (const [i, text] of texts.entries()) {
      const added = await promptSvc.addPrompt(user, {
        setId: set.data.id,
        text,
        category: "recommendation",
        tier: i === 2 ? 4 : 1,
      });
      if (!added.ok) throw new Error(added.error.message);
    }
    // Segment lineage is written by market generation (spec 040); tag the
    // first two directly, as the generator would.
    await sql`
      update prompts set audience = 'sellers', price_tier = '$5M+'
      where prompt_set_id = ${set.data.id} and position <= 2
    `;

    const frozen = await setSvc.freezePromptSet(user, { id: set.data.id });
    if (!frozen.ok) throw new Error(frozen.error.message);
    const [version] = await sql`
      select id, frozen_prompts from prompt_set_versions
      where prompt_set_id = ${set.data.id}
    `;
    const snapshot = version?.frozenPrompts as FrozenPrompt[];

    // The freeze carries the attributes (spec 063) — and only where tagged.
    expect(snapshot.filter((p) => p.audience === "sellers")).toHaveLength(2);
    expect(snapshot.filter((p) => p.priceTier === "$5M+")).toHaveLength(2);
    expect(snapshot.filter((p) => p.audience == null)).toHaveLength(1);

    // Retagging alone must not force a new version (metadata, not identity).
    await sql`
      update prompts set audience = 'buyers'
      where prompt_set_id = ${set.data.id} and position = 1
    `;
    const refrozen = await setSvc.freezePromptSet(user, { id: set.data.id });
    expect(refrozen.ok).toBe(false);
    if (!refrozen.ok) expect(refrozen.error.message).toMatch(/nothing to freeze/i);

    // Run, parse, score on the mock provider.
    const started = await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
      label: "coverage run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();

    const rows = await coverage.runCoverage(started.data.id);
    expect(rows).not.toBeNull();
    if (!rows) return;

    // Expected presence, derived from the mentions actually written.
    const [subject] = await sql`
      select id from companies where is_self and archived_at is null
    `;
    const mentioned = await sql`
      select distinct res.prompt_id
      from mentions m join responses res on res.id = m.response_id
      where res.run_id = ${started.data.id} and m.company_id = ${subject?.id}
        and m.mentioned
        and not exists (
          select 1 from mentions newer
          where newer.response_id = m.response_id
            and newer.company_id = m.company_id
            and newer.revision > m.revision
        )
    `;
    const mentionedIds = new Set(mentioned.map((r) => r.promptId as string));
    const expectFor = (filter: (p: FrozenPrompt) => boolean) => ({
      promptCount: snapshot.filter(filter).length,
      mentionedPrompts: snapshot.filter((p) => filter(p) && mentionedIds.has(p.promptId))
        .length,
    });

    const audience = rows.filter((r) => r.dimension === "audience");
    expect(audience.map((r) => r.segment).sort()).toEqual(["sellers", "unspecified"]);
    expect(audience.find((r) => r.segment === "sellers")).toMatchObject(
      expectFor((p) => p.audience === "sellers")
    );
    expect(audience.find((r) => r.segment === "unspecified")).toMatchObject(
      expectFor((p) => p.audience == null)
    );

    const priceTier = rows.filter((r) => r.dimension === "price_tier");
    expect(priceTier.find((r) => r.segment === "$5M+")).toMatchObject(
      expectFor((p) => p.priceTier === "$5M+")
    );

    const intent = rows.filter((r) => r.dimension === "intent");
    expect(intent.find((r) => r.segment === "high intent")?.promptCount).toBe(2);
    expect(intent.find((r) => r.segment === "standard intent")?.promptCount).toBe(1);

    // Recommended never exceeds mentioned, per row (structural invariant).
    for (const row of rows) {
      expect(row.recommendedPrompts).toBeLessThanOrEqual(row.mentionedPrompts);
      expect(row.mentionedPrompts).toBeLessThanOrEqual(row.promptCount);
    }
  });

  it("degrades honestly on untagged sets: category and intent only", async () => {
    await companySvc.upsertCompany(user, { name: "Lumina", isSelf: true });
    const project = await projectSvc.createProject(user, { name: "Plain Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Plain",
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
    const started = await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
      label: "plain run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();

    const rows = await coverage.runCoverage(started.data.id);
    expect(rows).not.toBeNull();
    const dimensions = new Set(rows?.map((r) => r.dimension));
    expect(dimensions).toEqual(new Set(["category", "intent"]));
  });
});
