/**
 * Integration tests for the agency operations feed (docs/17 A3): the daily
 * "what needs me" queue across every client.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("operations feed (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let operations: typeof import("@/db/operations");
  let onboarding: typeof import("@/lib/verticals/onboarding");
  let projectSvc: typeof import("@/lib/projects/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    operations = await import("@/db/operations");
    onboarding = await import("@/lib/verticals/onboarding");
    projectSvc = await import("@/lib/projects/service");
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
       prompt_sets, projects, vertical_packs cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function onboardRealtor(name: string): Promise<string> {
    const result = await onboarding.onboardClient(user, {
      clientName: name,
      packKey: "real-estate-agent",
      company: { name: `${name} Realty`, aliases: [], domain: null },
      variables: { market: ["Miami"], clientType: ["sellers"] },
      facts: [],
      competitors: [],
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data.projectId;
  }

  it("a freshly onboarded client shows setup items, not urgent ones", async () => {
    await onboardRealtor("Fresh Client");
    const { items, metrics } = await operations.attentionFeed();
    expect(metrics.activeClients).toBe(1);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("never_run");
    expect(items.every((i) => i.severity !== "urgent")).toBe(true);
    expect(metrics.clientsNeedingAttention).toBe(0);
  });

  it("flags a project with no subject as urgent", async () => {
    const project = await projectSvc.createProject(user, { name: "Unconfigured" });
    if (!project.ok) throw new Error(project.error.message);
    const { items } = await operations.attentionFeed();
    const noSubject = items.find((i) => i.kind === "no_subject");
    expect(noSubject?.severity).toBe("urgent");
    expect(noSubject?.href).toContain("/knowledge");
  });

  it("surfaces queued approvals as attention-level work", async () => {
    const projectId = await onboardRealtor("Accuracy Client");
    // A fresh onboard has no frozen version, so assert the human-decision
    // signal (task approvals) rather than fabricating a run.
    // Suggested tasks must carry evidence (spec 007 DB constraint)
    await sql`
      with e as (
        insert into evidence (kind, ref_id, note, created_by)
        values ('score', gen_random_uuid(), 'test evidence', ${user.id})
        returning id
      )
      insert into tasks (project_id, title, description, priority, status,
        evidence_ids)
      select ${projectId}, 'Suggested work', 'x', 'p1', 'suggested',
        array[e.id] from e
    `;
    const { items } = await operations.attentionFeed();
    const approvals = items.find((i) => i.kind === "approvals_waiting");
    expect(approvals?.severity).toBe("attention");
    expect(approvals?.count).toBe(1);
    expect(approvals?.href).toContain("/tasks");
  });

  it("orders urgent before attention before info, and counts descending", async () => {
    const a = await onboardRealtor("Client A");
    await onboardRealtor("Client B");
    await sql`
      with e as (
        insert into evidence (kind, ref_id, note, created_by)
        values ('score', gen_random_uuid(), 'test evidence', ${user.id})
        returning id
      )
      insert into tasks (project_id, title, description, priority, status,
        evidence_ids)
      select ${a}, 'task ' || g, 'x', 'p2', 'suggested', array[e.id]
      from generate_series(1, 3) g, e
    `;
    const project = await projectSvc.createProject(user, { name: "Broken" });
    if (!project.ok) throw new Error(project.error.message);

    const { items, metrics } = await operations.attentionFeed();
    const severities = items.map((i) => i.severity);
    const firstInfo = severities.indexOf("info");
    const lastUrgent = severities.lastIndexOf("urgent");
    expect(lastUrgent).toBeLessThan(firstInfo === -1 ? severities.length : firstInfo);
    expect(items[0]?.severity).toBe("urgent");
    expect(metrics.activeClients).toBe(3);
    // Client A's 3 approvals are the attention item
    const approvals = items.find((i) => i.kind === "approvals_waiting");
    expect(approvals?.count).toBe(3);
  });

  it("cost rollup reports per-client spend, highest first", async () => {
    const a = await onboardRealtor("Spender");
    const b = await onboardRealtor("Thrifty");
    const [versionA] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts, frozen_by)
      select ps.id, 1, '[]'::jsonb, ${user.id} from prompt_sets ps
      where ps.project_id = ${a} returning id
    `;
    const [versionB] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts, frozen_by)
      select ps.id, 1, '[]'::jsonb, ${user.id} from prompt_sets ps
      where ps.project_id = ${b} returning id
    `;
    await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        trigger, budget_usd, status, cost_usd)
      values
        (${a}, ${versionA?.id}, 'big', '[]'::jsonb, 'manual', 5, 'completed', 4.20),
        (${b}, ${versionB?.id}, 'small', '[]'::jsonb, 'manual', 5, 'completed', 0.30)
    `;
    const rollup = await operations.clientCostRollup();
    expect(rollup[0]?.projectName).toBe("Spender");
    expect(rollup[0]?.spend7d).toBeCloseTo(4.2, 2);
    expect(rollup[1]?.spend7d).toBeCloseTo(0.3, 2);

    const { metrics } = await operations.attentionFeed();
    expect(metrics.spend7d).toBeCloseTo(4.5, 2);
    expect(metrics.runs7d).toBe(2);
  });

  it("archived clients drop out of the feed entirely", async () => {
    const projectId = await onboardRealtor("Leaving");
    await projectSvc.archiveProject(
      { ...user, role: "admin" },
      { id: projectId, confirmName: "Leaving" }
    );
    const { items, metrics } = await operations.attentionFeed();
    expect(metrics.activeClients).toBe(0);
    expect(items).toHaveLength(0);
  });
});
