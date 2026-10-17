/** Spec 151 B1/B2: the unified plan over real finding rows. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { clientViewerUser, operatorUser } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("optimization plan (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let plan: typeof import("@/lib/optimization/plan");
  let presence: typeof import("@/lib/optimization/source-presence");
  const user = operatorUser();
  let projectId: string;
  let runId: string;
  let subjectId: string;
  let rivalId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    plan = await import("@/lib/optimization/plan");
    presence = await import("@/lib/optimization/source-presence");
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const [project] = await sql`insert into projects (name) values ('Plan Client') returning id`;
    projectId = project!.id as string;
    const [s] = await sql`insert into companies (name, domain) values ('Rivera Team', 'riverateam.com') returning id`;
    const [r] = await sql`insert into companies (name) values ('Meridian Group') returning id`;
    subjectId = s!.id as string;
    rivalId = r!.id as string;
    await sql`update projects set subject_company_id = ${subjectId} where id = ${projectId}`;
    await sql`insert into competitors (project_id, company_id, tier) values (${projectId}, ${rivalId}, 'primary')`;
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${projectId}, 'S') returning id`;
    const [version] = await sql`insert into prompt_set_versions (prompt_set_id, version, frozen_prompts) values (${set!.id}, 1, '[]') returning id`;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${projectId}, ${version!.id}, 'r', '[]', 'completed', 'manual', 1) returning id
    `;
    runId = run!.id as string;
    await sql`
      insert into scores (run_id, company_id, metric, provider, value, sample_size, scoring_version)
      values (${runId}, ${subjectId}, 'mention_rate', 'all', 0.3, 20, 'v1.1')
    `;
    await sql`
      insert into gap_findings (project_id, run_id, prompt_category, gap_type, finding, severity, opportunity_score, detector_version)
      values (${projectId}, ${runId}, 'recommendation', 'recommendation', 'Mentioned but never recommended.', 0.8, 75, 'gap-detector-v1.2')
    `;
    const [scan] = await sql`
      insert into site_scans (project_id, domain, scanner_version, status) values (${projectId}, 'riverateam.com', 'v1', 'completed') returning id
    `;
    await sql`
      insert into site_findings (project_id, scan_id, check_type, severity, observation, recommendation, priority_score, priority_band, scanner_version)
      values (${projectId}, ${scan!.id}, 'ai_crawler_blocked', 'critical', 'robots.txt blocks GPTBot', 'Allow GPTBot', 90, 'do_now', 'v1')
    `;
    // Two answers citing zillow.com; one names the rival, one the client.
    for (const company of [rivalId, subjectId]) {
      const [resp] = await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text)
        values (${runId}, gen_random_uuid(), 'best agent?', 'openai', 'm', 1, 'answer') returning id
      `;
      await sql`insert into response_citations (response_id, url, domain, kind) values (${resp!.id}, 'https://zillow.com/x', 'zillow.com', 'search')`;
      await sql`
        insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
        values (${resp!.id}, ${company}, true, true, 'mention-parser-v2+llm', 0.9)
      `;
    }
  });

  it("builds once, refreshes idempotently, and preserves status across rebuilds", async () => {
    const first = await plan.buildOptimizationPlan(user, { projectId });
    expect(first.ok && first.data).toMatchObject({ created: 2, refreshed: 0 });
    const list = await plan.listOpportunities(user, projectId);
    expect(list.map((o) => o.category).sort()).toEqual(["visibility_gap", "website"]);
    expect(list[0]?.priorityScore).toBe(90);

    const site = list.find((o) => o.category === "website")!;
    const dismissed = await plan.transitionOpportunity(user, { opportunityId: site.id, to: "dismissed" });
    expect(dismissed.ok).toBe(false); // dismissal needs a reason
    expect((await plan.transitionOpportunity(user, { opportunityId: site.id, to: "dismissed", note: "client blocks bots on purpose" })).ok).toBe(true);

    const second = await plan.buildOptimizationPlan(user, { projectId });
    // The dismissed item is left exactly as decided; the proposed one refreshes.
    expect(second.ok && second.data).toMatchObject({ created: 0, refreshed: 1, unchanged: 1 });
    const after = await plan.listOpportunities(user, projectId);
    expect(after.find((o) => o.id === site.id)?.status).toBe("dismissed");
  });

  it("approval creates the task through the source engine; measuring needs an intervention", async () => {
    await plan.buildOptimizationPlan(user, { projectId });
    const gap = (await plan.listOpportunities(user, projectId)).find((o) => o.category === "visibility_gap")!;
    const skipped = await plan.transitionOpportunity(user, { opportunityId: gap.id, to: "implemented" });
    expect(skipped.ok).toBe(false);
    const approved = await plan.transitionOpportunity(user, { opportunityId: gap.id, to: "approved" });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.data.taskId).not.toBeNull();
    const [finding] = await sql`select status, task_id from gap_findings where project_id = ${projectId}`;
    expect(finding).toMatchObject({ status: "task_created", taskId: approved.data.taskId });

    expect((await plan.transitionOpportunity(user, { opportunityId: gap.id, to: "in_progress" })).ok).toBe(true);
    expect((await plan.transitionOpportunity(user, { opportunityId: gap.id, to: "implemented" })).ok).toBe(true);
    const noIntervention = await plan.transitionOpportunity(user, { opportunityId: gap.id, to: "measuring" });
    expect(noIntervention.ok).toBe(false);

    const events = await sql`select from_status, to_status from opportunity_events where opportunity_id = ${gap.id} order by at`;
    expect(events.map((e) => e.toStatus)).toEqual(["proposed", "approved", "in_progress", "implemented"]);
    await expect(sql`delete from opportunity_events`).rejects.toThrow(/insert-only/);
  });

  it("client accounts cannot write and only read granted projects", async () => {
    const client = clientViewerUser();
    const res = await plan.buildOptimizationPlan(client, { projectId });
    expect(res.ok).toBe(false);
    await expect(plan.listOpportunities(client, projectId)).rejects.toThrow(/not found/i);
  });

  it("source presence separates co-occurrence from page presence", async () => {
    const result = await presence.sourcePresence(projectId);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      domain: "zillow.com",
      answersCiting: 2,
      withCompetitor: 1,
      withClient: 1,
      pagePresence: "not_checked",
      candidate: true,
    });
  });
});
