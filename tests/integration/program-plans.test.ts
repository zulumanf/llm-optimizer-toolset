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
      truncate plan_items, program_plans, gap_findings, knowledge_entities,
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
});
