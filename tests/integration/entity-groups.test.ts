/**
 * Spec 030 batch 3: the knowledge-graph ↔ measurement bridge (roadmap 2.3)
 * and per-client trigger cloning (2.5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000601",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("entity groups & trigger cloning (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let groups: typeof import("@/lib/competitors/groups");
  let triggers: typeof import("@/lib/triggers/service");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let competitorSvc: typeof import("@/lib/competitors/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let jobs: typeof import("@/db/jobs");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    groups = await import("@/lib/competitors/groups");
    triggers = await import("@/lib/triggers/service");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    competitorSvc = await import("@/lib/competitors/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    jobs = await import("@/db/jobs");
    execute = await import("@/lib/runs/execute");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate trigger_fires, automation_triggers, entity_relationships,
        entity_aliases, knowledge_entities, jobs, scores, response_parses,
        mentions, sources, response_citations, brand_candidates, responses,
        runs, prompt_set_versions, prompts, prompt_sets, competitors,
        companies, audit_log, domain_events, projects cascade
    `);
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run")
        await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  it("groups an agent under their brokerage with an honest group rate", async () => {
    // Mock's default answer names both Lumina (agent) and Acme (brokerage).
    const agent = await companySvc.upsertCompany(user, { name: "Lumina" });
    const brokerage = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!agent.ok || !brokerage.ok) throw new Error("company setup failed");
    const project = await projectSvc.createProject(user, { name: "Bridge Co" });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: agent.data.id,
    });
    await competitorSvc.addCompetitor(user, {
      projectId: project.data.id,
      companyId: brokerage.data.id,
      tier: "primary",
    });

    // Knowledge-graph side: two entities linked to the measured companies,
    // one approved works_for relationship.
    const [agentEntity] = await sql`
      insert into knowledge_entities
        (project_id, entity_type, canonical_name, slug, company_id)
      values (${project.data.id}, 'person', 'Lumina', 'lumina', ${agent.data.id})
      returning id
    `;
    const [brokerageEntity] = await sql`
      insert into knowledge_entities
        (project_id, entity_type, canonical_name, slug, company_id)
      values (${project.data.id}, 'brokerage', 'Acme', 'acme', ${brokerage.data.id})
      returning id
    `;
    await sql`
      insert into entity_relationships
        (project_id, from_entity_id, to_entity_id, relationship_type, status)
      values (${project.data.id}, ${agentEntity?.id as string},
        ${brokerageEntity?.id as string}, 'works_for', 'approved')
    `;

    // No scored run yet → group exists, rate honestly null.
    let result = await groups.relationshipGroups(project.data.id);
    expect(result).toHaveLength(1);
    expect(result[0]?.groupMentionRate).toBeNull();

    // Run the real pipeline.
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "best tools?",
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
      label: "bridge run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();

    result = await groups.relationshipGroups(project.data.id);
    expect(result).toHaveLength(1);
    const group = result[0]!;
    expect(group.parentName).toBe("Acme");
    expect(group.members).toHaveLength(1);
    expect(group.members[0]?.name).toBe("Lumina");
    expect(group.members[0]?.relationshipType).toBe("works_for");
    // Both members appear in every mock answer: members at 1.0 each, and
    // the group at 1.0 — NOT 2.0, proving the distinct-response arithmetic.
    expect(group.members[0]?.mentionRate).toBe(1);
    expect(group.groupMentionRate).toBe(1);
    expect(group.sampleSize).toBe(2);

    // A proposed (unapproved) relationship never groups.
    await sql`update entity_relationships set status = 'proposed'`;
    result = await groups.relationshipGroups(project.data.id);
    expect(result).toHaveLength(0);
  });

  it("clones a platform schedule to a client, enabled — once", async () => {
    const project = await projectSvc.createProject(user, { name: "Trigger Co" });
    if (!project.ok) throw new Error(project.error.message);

    const template = await triggers.registerTrigger({
      key: "wf.weekly_operations.schedule",
      kind: "schedule",
      workflowKey: "weekly_operations",
      projectId: null,
      enabled: false,
      cron: "0 9 * * 1",
      timezone: "UTC",
    });

    const clone = await triggers.cloneTriggerForClient({
      triggerId: template.triggerId,
      projectId: project.data.id,
      createdBy: user.id,
    });
    const [row] = await sql`
      select key, project_id, enabled, cron, workflow_key
      from automation_triggers where id = ${clone.triggerId}
    `;
    expect(row?.projectId).toBe(project.data.id);
    expect(row?.enabled).toBe(true);
    expect(row?.cron).toBe("0 9 * * 1");
    expect(row?.key).toBe(`wf.weekly_operations.schedule:${project.data.id}`);

    // Template untouched.
    const [source] = await sql`
      select enabled, project_id from automation_triggers
      where id = ${template.triggerId}
    `;
    expect(source?.enabled).toBe(false);
    expect(source?.projectId).toBeNull();

    // Second clone for the same client → conflict, not a duplicate.
    await expect(
      triggers.cloneTriggerForClient({
        triggerId: template.triggerId,
        projectId: project.data.id,
      })
    ).rejects.toThrow(/already has a clone/i);

    // Cloning a client-scoped trigger is refused.
    await expect(
      triggers.cloneTriggerForClient({
        triggerId: clone.triggerId,
        projectId: project.data.id,
      })
    ).rejects.toThrow(/platform template/i);
  });
});
