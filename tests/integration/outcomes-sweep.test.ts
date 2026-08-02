/**
 * Spec 034 — the outcome measurement sweep. Recorded actions get measured
 * once due, with honest labels: signal only on material movement, confounded
 * when another action overlaps, insufficient_measurement when nothing
 * comparable exists, and write-once idempotency on repeat passes.
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

const DAY = 86_400_000;

describe.skipIf(!TEST_URL)("outcome measurement sweep (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let sweep: typeof import("@/lib/outcomes/sweep");
  let graph: typeof import("@/lib/outcomes/graph");
  let constants: typeof import("@/lib/constants");
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let companySvc: typeof import("@/lib/companies/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    sweep = await import("@/lib/outcomes/sweep");
    graph = await import("@/lib/outcomes/graph");
    constants = await import("@/lib/constants");
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    companySvc = await import("@/lib/companies/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, action_outcomes, scores, runs,
       prompt_set_versions, prompts, prompt_sets, companies, projects cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Project + subject + frozen version; returns ids. */
  async function seedProject(): Promise<{
    projectId: string;
    companyId: string;
    versionId: string;
  }> {
    const company = await companySvc.upsertCompany(user, {
      name: "Lumina",
      isSelf: true,
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name: "Sweep Test" });
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
    return {
      projectId: project.data.id,
      companyId: company.data.id,
      versionId: version?.id as string,
    };
  }

  /** A completed run with one stored mention_rate score at a controlled time. */
  async function seedScoredRunAt(
    ids: { projectId: string; companyId: string; versionId: string },
    startedAt: Date,
    mentionRate: number,
    scoringVersion?: string
  ): Promise<string> {
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        status, trigger, budget_usd, started_at)
      values (${ids.projectId}, ${ids.versionId}, ${"run " + startedAt.toISOString()},
        ${sql.json([{ provider: "mock", model: "mock-model", repetitions: 1 }])},
        'completed', 'manual', 5, ${startedAt})
      returning id
    `;
    await sql`
      insert into scores (run_id, company_id, metric, provider, value,
        sample_size, scoring_version)
      values (${run!.id}, ${ids.companyId}, 'mention_rate', 'all',
        ${mentionRate}, 10, ${scoringVersion ?? constants.SCORING_VERSION})
    `;
    return run!.id as string;
  }

  /** An unmeasured action whose clock starts at `at`. */
  async function seedAction(
    projectId: string,
    at: Date,
    actionType = "content_asset"
  ): Promise<string> {
    const [row] = await sql`
      insert into action_outcomes (project_id, action_type, created_at)
      values (${projectId}, ${actionType}, ${at})
      returning id
    `;
    return row!.id as string;
  }

  it("measures a due action against nearest same-version runs and labels the movement", async () => {
    const ids = await seedProject();
    const t0 = new Date("2026-06-01T12:00:00Z");
    await seedScoredRunAt(ids, new Date(t0.getTime() - 2 * DAY), 0.2);
    await seedScoredRunAt(ids, new Date(t0.getTime() + 20 * DAY), 0.5);
    const actionId = await seedAction(ids.projectId, t0);

    const result = await sweep.measureDueActionOutcomes(
      new Date(t0.getTime() + 31 * DAY)
    );
    expect(result.due).toBe(1);
    expect(result.measured).toBe(1);

    const [row] = await sql`select * from action_outcomes where id = ${actionId}`;
    expect(row?.effectiveness).toBe("positive_signal");
    expect(Number(row?.visibilityBefore)).toBeCloseTo(0.2);
    expect(Number(row?.visibilityAfter)).toBeCloseTo(0.5);
    expect(row?.measuredAt).not.toBeNull();

    // Second pass: write-once — nothing due, nothing changed.
    const again = await sweep.measureDueActionOutcomes(
      new Date(t0.getTime() + 40 * DAY)
    );
    expect(again.due).toBe(0);
  });

  it("flat numbers label no_detectable_change, not a signal", async () => {
    const ids = await seedProject();
    const t0 = new Date("2026-06-01T12:00:00Z");
    await seedScoredRunAt(ids, new Date(t0.getTime() - 2 * DAY), 0.3);
    await seedScoredRunAt(ids, new Date(t0.getTime() + 20 * DAY), 0.3);
    const actionId = await seedAction(ids.projectId, t0);

    await sweep.measureDueActionOutcomes(new Date(t0.getTime() + 31 * DAY));
    const [row] = await sql`select effectiveness from action_outcomes where id = ${actionId}`;
    expect(row?.effectiveness).toBe("no_detectable_change");
  });

  it("an overlapping action turns movement into confounded, never a signal", async () => {
    const ids = await seedProject();
    const t0 = new Date("2026-06-01T12:00:00Z");
    await seedScoredRunAt(ids, new Date(t0.getTime() - 2 * DAY), 0.2);
    await seedScoredRunAt(ids, new Date(t0.getTime() + 20 * DAY), 0.5);
    const actionId = await seedAction(ids.projectId, t0);
    await seedAction(ids.projectId, new Date(t0.getTime() + 10 * DAY), "profile_fix");

    await sweep.measureDueActionOutcomes(new Date(t0.getTime() + 31 * DAY));
    const [row] = await sql`
      select effectiveness, confounders from action_outcomes where id = ${actionId}
    `;
    expect(row?.effectiveness).toBe("confounded");
    expect(row?.confounders).toContain("overlapping action: profile_fix");
  });

  it("waits while no post-action run exists, then gives up honestly", async () => {
    const ids = await seedProject();
    const t0 = new Date("2026-06-01T12:00:00Z");
    await seedScoredRunAt(ids, new Date(t0.getTime() - 2 * DAY), 0.2);
    const actionId = await seedAction(ids.projectId, t0);

    // Due but not past give-up: stays unmeasured, counted as waiting.
    const waiting = await sweep.measureDueActionOutcomes(
      new Date(t0.getTime() + 31 * DAY)
    );
    expect(waiting.waiting).toBe(1);
    expect(waiting.measured).toBe(0);

    // Past give-up (30 expected + 60 grace): settles as insufficient.
    const gaveUp = await sweep.measureDueActionOutcomes(
      new Date(t0.getTime() + 91 * DAY)
    );
    expect(gaveUp.settledUnmeasurable).toBe(1);
    const [row] = await sql`
      select effectiveness, measured_at from action_outcomes where id = ${actionId}
    `;
    expect(row?.effectiveness).toBe("insufficient_measurement");
    expect(row?.measuredAt).not.toBeNull();
  });

  it("never compares across scoring versions — a mismatched before stays null", async () => {
    const ids = await seedProject();
    const t0 = new Date("2026-06-01T12:00:00Z");
    // Before-run exists but was scored under an older version.
    await seedScoredRunAt(ids, new Date(t0.getTime() - 2 * DAY), 0.2, "v0.9");
    await seedScoredRunAt(ids, new Date(t0.getTime() + 20 * DAY), 0.5);
    const actionId = await seedAction(ids.projectId, t0);

    await sweep.measureDueActionOutcomes(new Date(t0.getTime() + 31 * DAY));
    const [row] = await sql`
      select effectiveness, visibility_before, visibility_after
      from action_outcomes where id = ${actionId}
    `;
    expect(row?.visibilityBefore).toBeNull();
    expect(Number(row?.visibilityAfter)).toBeCloseTo(0.5);
    // With no comparable before under the current version, every pair is
    // one-sided — the honest label is insufficient, not a fabricated signal.
    expect(row?.effectiveness).toBe("insufficient_measurement");
  });

  it("due-date math: expected_days_to_impact and the give-up boundary", () => {
    const base = {
      completedOn: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      expectedDaysToImpact: 14,
    };
    expect(sweep.isDue(base, new Date("2026-06-14T00:00:00Z"))).toBe(false);
    expect(sweep.isDue(base, new Date("2026-06-15T00:00:00Z"))).toBe(true);
    expect(sweep.isPastGiveUp(base, new Date("2026-08-13T00:00:00Z"))).toBe(false);
    expect(sweep.isPastGiveUp(base, new Date("2026-08-14T00:00:00Z"))).toBe(true);
    // completed_on wins over created_at when present.
    const completed = { ...base, completedOn: new Date("2026-06-10T00:00:00Z") };
    expect(sweep.isDue(completed, new Date("2026-06-20T00:00:00Z"))).toBe(false);
    expect(sweep.isDue(completed, new Date("2026-06-24T00:00:00Z"))).toBe(true);
    expect(graph.OUTCOME_MATERIALITY_THRESHOLD).toBe(0.1);
  });
});
