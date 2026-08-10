/**
 * Spec 026 — plan composition.
 *
 * The properties worth testing are the ones that separate a composed plan from
 * a generated one: determinism, traceability to findings, exclusions that
 * state a reason, and a refusal to produce ceremony when there is nothing to
 * plan from.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000001101",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const clientUser: CurrentUser = { ...user, id: "00000000-0000-4000-8000-000000001001", role: "client_viewer" };

describe.skipIf(!TEST_URL)("program plans (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let plans: typeof import("@/lib/plans/service");
  let projectSvc: typeof import("@/lib/projects/service");
  let projectId = "";
  let runId = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    plans = await import("@/lib/plans/service");
    projectSvc = await import("@/lib/projects/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate plan_items, program_plans, gap_findings, knowledge_entities, source_artifacts,
        claims, evidence, runs, prompt_set_versions, prompt_sets, audit_log,
        projects restart identity cascade
    `);
    const created = await projectSvc.createProject(user, { name: "Plan Client" });
    if (!created.ok) throw new Error(created.error.message);
    projectId = created.data.id;

    // gap_findings.run_id is NOT NULL — findings are always attributed to the
    // measurement that produced them, so a fixture needs a real run.
    const [set] = await sql`
      insert into prompt_sets (project_id, name) values (${projectId}, 'fixture set')
      returning id`;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts, frozen_by)
      values (${set!.id}, 1, '[]'::jsonb, ${user.id}) returning id`;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${projectId}, ${version!.id}, 'fixture run', '[]'::jsonb, 'completed', 'manual', 1)
      returning id`;
    runId = run!.id as string;
  });

  async function seedFindings(): Promise<void> {
    await sql`
      insert into gap_findings (project_id, run_id, gap_type, finding, detail, severity, opportunity_score, detector_version, status)
      values
        (${projectId}, ${runId}, 'entity', 'invisible', ${sql.json({
          unbrandedMentionRate: 0.03,
          topCompetitor: "Compass",
          topCompetitorMentionRate: 0.33,
        } as never)}, 0.9, 87.5, 'gap-detector-v1', 'open'),
        (${projectId}, ${runId}, 'citation', 'no owned citations', ${sql.json({
          totalCitations: 318,
          ownCitations: 0,
        } as never)}, 0.8, 69.0, 'gap-detector-v1', 'open'),
        (${projectId}, ${runId}, 'source_target', 'retrieval path', ${sql.json({
          targets: [
            { domain: "zillow.com", citations: 92 },
            { domain: "realtor.com", citations: 72 },
          ],
        } as never)}, 0.6, 62.5, 'gap-detector-v1', 'open')
    `;
  }

  it("refuses to compose a plan with no findings", async () => {
    // An empty plan is ceremony, and ceremony in a client deliverable is worse
    // than an honest "we have nothing yet".
    const result = await plans.composePlan(user, { projectId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("No open gap findings");
  });

  it("composes a phased plan traceable to its findings", async () => {
    await seedFindings();
    const result = await plans.composePlan(user, { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const planned = result.data.items.filter((i) => i.status === "planned");
    expect(planned.length).toBeGreaterThan(3);
    // Every scheduled play answers a finding that actually exists.
    for (const item of planned) {
      if (item.playKey === "remeasure_and_attribute") continue; // unconditional
      expect(item.sourceFindingId, item.playKey).not.toBeNull();
    }
    expect(new Set(planned.map((i) => i.phase))).toContain("foundation");
  });

  it("is deterministic — same findings, same plan and same hash", async () => {
    await seedFindings();
    const first = await plans.composePlan(user, { projectId });
    const second = await plans.composePlan(user, { projectId });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // The hash deliberately excludes the timestamp, so re-composing an
    // unchanged picture is visibly a no-op rather than "a new plan".
    expect(second.data.compositionHash).toBe(first.data.compositionHash);
    expect(second.data.items.map((i) => i.playKey)).toEqual(
      first.data.items.map((i) => i.playKey)
    );
  });

  it("supersedes the previous plan rather than overwriting it", async () => {
    await seedFindings();
    const first = await plans.composePlan(user, { projectId });
    const second = await plans.composePlan(user, { projectId });
    if (!first.ok || !second.ok) throw new Error("compose failed");

    expect(second.data.supersededId).toBe(first.data.id);
    const [old] = await sql`select status from program_plans where id = ${first.data.id}`;
    expect(old!.status).toBe("superseded");
    // The old plan's items survive: a plan shown to a client in March must
    // still render in June exactly as it did.
    const items = await sql`select id from plan_items where plan_id = ${first.data.id}`;
    expect(items.length).toBeGreaterThan(0);
  });

  it("excludes a play with unmet preconditions and states the reason", async () => {
    // No claims, no entities, no citation data → several plays cannot run.
    await sql`
      insert into gap_findings (project_id, run_id, gap_type, finding, detail, severity, opportunity_score, detector_version, status)
      values (${projectId}, ${runId}, 'entity', 'invisible', '{}'::jsonb, 0.9, 87.5, 'gap-detector-v1', 'open')
    `;
    const result = await plans.composePlan(user, { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const excluded = result.data.items.filter((i) => i.status === "excluded");
    expect(excluded.length).toBeGreaterThan(0);
    for (const item of excluded) {
      // A silent omission tells the operator nothing; a reason tells them what
      // data is missing.
      expect(item.exclusionReason, item.playKey).toBeTruthy();
    }
    expect(excluded.map((i) => i.playKey)).toContain("publish_brokerage_affiliation");
  });

  it("schedules a play once its precondition is satisfied", async () => {
    await seedFindings();
    const before = await plans.composePlan(user, { projectId });
    if (!before.ok) throw new Error("compose failed");
    expect(
      before.data.items.find((i) => i.playKey === "publish_brokerage_affiliation")?.status
    ).toBe("excluded");

    await sql`
      insert into claims (project_id, key, canonical_text, status, created_by)
      values (${projectId}, 'brokerage', 'Team under X brokerage.', 'approved', ${user.id})
    `;
    const after = await plans.composePlan(user, { projectId });
    if (!after.ok) throw new Error("compose failed");
    expect(
      after.data.items.find((i) => i.playKey === "publish_brokerage_affiliation")?.status
    ).toBe("planned");
  });

  it("snapshots the baseline so progress has something to be measured against", async () => {
    await seedFindings();
    const result = await plans.composePlan(user, { projectId });
    if (!result.ok) throw new Error("compose failed");
    const baseline = result.data.baseline as Record<string, unknown>;
    expect(baseline.topCompetitor).toBe("Compass");
    expect(baseline.organicMentionRate).toBe(0.03);
    expect((baseline.citedDomains as unknown[]).length).toBe(2);
  });

  it("refuses composition from a read-only account", async () => {
    await seedFindings();
    const result = await plans.composePlan(clientUser, { projectId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/read-only/i);
  });

  it("approves a draft once, and only a draft", async () => {
    await seedFindings();
    const composed = await plans.composePlan(user, { projectId });
    if (!composed.ok) throw new Error("compose failed");

    expect((await plans.approvePlan(user, { planId: composed.data.id })).ok).toBe(true);
    const second = await plans.approvePlan(user, { planId: composed.data.id });
    expect(second.ok).toBe(false);
  });

  it("plan items become tasks and track them to done (plan 5.4)", async () => {
    const tasks = await import("@/lib/tasks/service");
    await seedFindings();
    const composed = await plans.composePlan(user, { projectId });
    if (!composed.ok) throw new Error("compose failed");

    const [item] = await sql`
      select id from plan_items
      where plan_id = ${composed.data.id} and status = 'planned'
      order by phase, position limit 1
    `;

    // Activation requires an approved plan.
    const early = await plans.activatePlanItem(user, { planItemId: item?.id as string });
    expect(early.ok).toBe(false);

    await plans.approvePlan(user, { planId: composed.data.id });
    const activated = await plans.activatePlanItem(user, { planItemId: item?.id as string });
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;

    // The task is born approved; the item now tracks it.
    const [task] = await sql`
      select status, approved_by from tasks where id = ${activated.data.taskId}
    `;
    expect(task?.status).toBe("approved");
    const [tracking] = await sql`select status, task_id from plan_items where id = ${item?.id}`;
    expect(tracking?.status).toBe("in_progress");
    expect(tracking?.taskId).toBe(activated.data.taskId);

    // Re-activating a non-planned item is refused.
    expect((await plans.activatePlanItem(user, { planItemId: item?.id as string })).ok).toBe(false);

    // Completing the task flips the item to done.
    const completed = await tasks.completeTask(user, { taskId: activated.data.taskId });
    expect(completed.ok).toBe(true);
    const [after] = await sql`select status from plan_items where id = ${item?.id}`;
    expect(after?.status).toBe("done");

    // Dropping is explicit and reasoned — never silent (plan 5.4).
    const [second] = await sql`
      select id from plan_items
      where plan_id = ${composed.data.id} and status = 'planned'
      order by phase, position limit 1
    `;
    const unreasoned = await plans.dropPlanItem(user, {
      planItemId: second?.id as string,
      reason: "",
    });
    expect(unreasoned.ok).toBe(false);
    const dropped = await plans.dropPlanItem(user, {
      planItemId: second?.id as string,
      reason: "Client is handling this internally.",
    });
    expect(dropped.ok).toBe(true);
    const [droppedRow] = await sql`select status from plan_items where id = ${second?.id}`;
    expect(droppedRow?.status).toBe("dropped");
    // A dropped item cannot be activated.
    expect((await plans.activatePlanItem(user, { planItemId: second?.id as string })).ok).toBe(false);

    // Dropping requires a reason; a settled item cannot be dropped.
    expect((await plans.dropPlanItem(user, { planItemId: item?.id as string, reason: "x" })).ok).toBe(false);
    const [other] = await sql`
      select id from plan_items
      where plan_id = ${composed.data.id} and status = 'planned' limit 1
    `;
    if (other) {
      const dropped = await plans.dropPlanItem(user, {
        planItemId: other.id as string,
        reason: "Client is doing this in-house.",
      });
      expect(dropped.ok).toBe(true);
    }

    // The audit rows carry the client (plan 4.4) — trigger or explicit.
    const [stamped] = await sql`
      select count(*)::int as n from audit_log
      where project_id = ${projectId} and action in ('plan.item_activate', 'task.complete')
    `;
    expect(stamped?.n).toBeGreaterThanOrEqual(2);
  });

  it("keeps at most one live plan per client", async () => {
    await seedFindings();
    await plans.composePlan(user, { projectId });
    await plans.composePlan(user, { projectId });
    const live = await sql`
      select id from program_plans
      where project_id = ${projectId} and status in ('draft','approved','active')
    `;
    // Two live plans would be two answers to the same question.
    expect(live).toHaveLength(1);
  });

  // ------------------------------------------- composing across several runs
  /**
   * The bug these pin: composing without a named baseline took client state
   * from whichever run owned the highest-scoring finding. That was the
   * non-search run, which has zero citations — so two plays were excluded for
   * "no citation data" while 318 cited sources sat in a different run.
   *
   * A missing signal must mean "nobody measured it", never "we looked in the
   * wrong place".
   */
  async function makeRun(label: string): Promise<string> {
    const [set] = await sql`
      insert into prompt_sets (project_id, name) values (${projectId}, ${label}) returning id`;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts, frozen_by)
      values (${set!.id}, 1, '[]'::jsonb, ${user.id}) returning id`;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${projectId}, ${version!.id}, ${label}, '[]'::jsonb, 'completed', 'manual', 1)
      returning id`;
    return run!.id as string;
  }

  it("takes each signal from the run that actually has it", async () => {
    // Run A: the highest-scoring finding, but no citation data at all.
    const runA = await makeRun("no-search run");
    await sql`
      insert into gap_findings (project_id, run_id, gap_type, finding, detail, severity, opportunity_score, detector_version, status)
      values (${projectId}, ${runA}, 'entity', 'invisible', ${sql.json({
        unbrandedMentionRate: 0, topCompetitor: "Compass", topCompetitorMentionRate: 0.35,
      } as never)}, 1, 87.5, 'gap-detector-v1', 'open')`;

    // Run B: lower-scoring, but it is where the citations live.
    const runB = await makeRun("search run");
    await sql`
      insert into gap_findings (project_id, run_id, gap_type, finding, detail, severity, opportunity_score, detector_version, status)
      values (${projectId}, ${runB}, 'source_target', 'retrieval path', ${sql.json({
        targets: [{ domain: "zillow.com", citations: 92 }],
      } as never)}, 0.6, 62.5, 'gap-detector-v1', 'open')`;

    const result = await plans.composePlan(user, { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const directory = result.data.items.find((i) => i.playKey === "claim_directory_profiles");
    // Before the fix this was excluded as "No citation data yet".
    expect(directory?.status).toBe("planned");
    expect(directory?.rationale).toContain("zillow.com");
  });

  it("still pins state to one run when a baseline is named", async () => {
    const runA = await makeRun("no-search run");
    await sql`
      insert into gap_findings (project_id, run_id, gap_type, finding, detail, severity, opportunity_score, detector_version, status)
      values (${projectId}, ${runA}, 'entity', 'invisible', '{}'::jsonb, 1, 87.5, 'gap-detector-v1', 'open')`;
    const runB = await makeRun("search run");
    await sql`
      insert into gap_findings (project_id, run_id, gap_type, finding, detail, severity, opportunity_score, detector_version, status)
      values (${projectId}, ${runB}, 'source_target', 'retrieval', ${sql.json({
        targets: [{ domain: "zillow.com", citations: 92 }],
      } as never)}, 0.6, 62.5, 'gap-detector-v1', 'open')`;

    // Explicitly scoped to the run with no citations: the exclusion is then
    // correct and must still happen.
    const result = await plans.composePlan(user, { projectId, baselineRunId: runA });
    if (!result.ok) throw new Error("compose failed");
    const directory = result.data.items.find((i) => i.playKey === "claim_directory_profiles");
    expect(directory?.status).toBe("excluded");
  });

  it("spec 058: confirmed learnings re-order plays — supports up, cautions down, weak labels inert", async () => {
    await seedFindings();
    const learnings = await import("@/lib/learnings/service");

    const baselinePlan = await plans.composePlan(user, { projectId });
    if (!baselinePlan.ok) throw new Error(baselinePlan.error.message);
    const foundationOrder = (plan: typeof baselinePlan.data) =>
      plan.items
        .filter((i) => i.phase === "foundation" && i.status === "planned")
        .sort((a, b) => a.position - b.position)
        .map((i) => i.playKey);
    const before = foundationOrder(baselinePlan.data);
    expect(before[0]).not.toBe("claim_directory_profiles");
    const beforeIndex = before.indexOf("claim_directory_profiles");
    expect(beforeIndex).toBeGreaterThan(0);

    // A weak label moves nothing.
    await learnings.recordLearning(user, {
      category: "authority",
      statement: "Directory work felt promising once.",
      confidenceLabel: "probable",
      playKey: "claim_directory_profiles",
      direction: "supports",
    });
    const unchanged = await plans.composePlan(user, { projectId });
    if (!unchanged.ok) throw new Error(unchanged.error.message);
    expect(foundationOrder(unchanged.data)).toEqual(before);

    // A confirmed supporting learning (measured source required) lifts it.
    const [outcome] = await sql`
      insert into action_outcomes (project_id, action_type, effectiveness, measured_at)
      values (${projectId}, 'intervention_shipped', 'positive_signal', now())
      returning id
    `;
    await learnings.recordLearning(user, {
      category: "authority",
      statement: "Directory cleanup reliably moved citations in comparable engagements.",
      confidenceLabel: "confirmed",
      sourceActionOutcomeIds: [outcome!.id as string],
      playKey: "claim_directory_profiles",
      direction: "supports",
    });
    const lifted = await plans.composePlan(user, { projectId });
    if (!lifted.ok) throw new Error(lifted.error.message);
    const after = foundationOrder(lifted.data);
    expect(after[0]).toBe("claim_directory_profiles");
    const item = lifted.data.items.find(
      (i) => i.playKey === "claim_directory_profiles"
    );
    expect(item?.rationale).toContain("support prioritising this play");
    expect(lifted.data.baseline.learningAdjustmentVersion).toBe("learning-adjust-v1");

    // Two confirmed cautions outweigh the support and drop it below peers.
    for (const statement of [
      "Directory cleanup underperformed for luxury teams.",
      "Second engagement showed the same weak result.",
    ]) {
      const [cautionOutcome] = await sql`
        insert into action_outcomes (project_id, action_type, effectiveness, measured_at)
        values (${projectId}, 'intervention_shipped', 'no_detectable_change', now())
        returning id
      `;
      await learnings.recordLearning(user, {
        category: "authority",
        statement,
        confidenceLabel: "confirmed",
        sourceActionOutcomeIds: [cautionOutcome!.id as string],
        playKey: "claim_directory_profiles",
        direction: "cautions",
      });
    }
    const dropped = await plans.composePlan(user, { projectId });
    if (!dropped.ok) throw new Error(dropped.error.message);
    const finalOrder = foundationOrder(dropped.data);
    // Net -20 (capped): it loses the top spot it had just gained and sorts
    // behind every un-cautioned peer.
    expect(finalOrder[0]).not.toBe("claim_directory_profiles");
    expect(finalOrder.indexOf("claim_directory_profiles")).toBeGreaterThanOrEqual(
      beforeIndex
    );
    const cautioned = dropped.data.items.find(
      (i) => i.playKey === "claim_directory_profiles"
    );
    expect(cautioned?.rationale).toContain("caution against repeating it as-is");
  });
});
