/**
 * Regression pins for the 2026-08-04 cleanup audit — each test guards a fix
 * or a phase-4/5 behavior that shipped without its own coverage:
 *  - recommendation_rate resolves the PROJECT's subject, not the legacy
 *    global is_self brand (audit finding D: duplication that became a bug)
 *  - audit_log rows self-resolve project_id via the 055 trigger
 *  - clientValueIndex prefers recorded contract value over the spend proxy
 *  - setInterventionVisibility flips the portal flag and audits itself
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ef",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("cleanup-audit regressions (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let jobs: typeof import("@/db/jobs");
  let tasksSvc: typeof import("@/lib/tasks/service");
  let attribution: typeof import("@/lib/attribution/service");
  let threshold: typeof import("@/lib/triggers/threshold");
  let queue: typeof import("@/lib/control-tower/queue");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    parsing = await import("@/lib/parsing/service");
    jobs = await import("@/db/jobs");
    tasksSvc = await import("@/lib/tasks/service");
    attribution = await import("@/lib/attribution/service");
    threshold = await import("@/lib/triggers/threshold");
    queue = await import("@/lib/control-tower/queue");
    mock = await import("@/lib/ai/mock");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, interventions, tasks, evidence, scores, sources,
       response_parses, mentions, response_citations, brand_candidates,
       companies, responses, runs, prompt_set_versions, prompts, prompt_sets,
       projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function scoredProject(name: string, subjectName: string): Promise<string> {
    const subject = unwrap(await companySvc.upsertCompany(operator, { name: subjectName }));
    const [acmeExists] = await sql`
      select id from companies where name = 'Acme' and archived_at is null
    `;
    if (!acmeExists && subjectName !== "Acme") {
      unwrap(await companySvc.upsertCompany(operator, { name: "Acme" }));
    }
    const project = unwrap(await projectSvc.createProject(operator, { name }));
    unwrap(
      await claimsSvc.setSubjectCompany(operator, {
        projectId: project.id,
        companyId: subject.id,
      })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    unwrap(
      await promptSvc.addPrompt(operator, {
        setId: set.id,
        text: "best luxury team in manhattan?",
        category: "recommendation",
      })
    );
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
        budgetUsd: 5,
        label: "regression run",
      })
    );
    for (let i = 0; i < 100; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) break;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      await jobs.completeJob(job.id);
    }
    return project.id;
  }

  it("recommendation_rate counts the project's OWN subject, never a global brand", async () => {
    // The mock's canned answers recommend Acme. A project whose subject IS
    // Acme must measure a positive rate; a project whose subject is a name
    // the mock never recommends must measure zero — under the old is_self
    // filter both projects reported the same global brand's rate.
    const acmeProject = await scoredProject("Acme As Subject", "Acme");
    const hit = await threshold.resolveMetric("recommendation_rate", {
      projectId: acmeProject,
      lookbackDays: 7,
    });
    expect(hit).not.toBeNull();
    expect(hit!.value).toBeGreaterThan(0);

    const riveraProject = await scoredProject("Rivera As Subject", "Rivera Team");
    const miss = await threshold.resolveMetric("recommendation_rate", {
      projectId: riveraProject,
      lookbackDays: 7,
    });
    expect(miss).not.toBeNull();
    expect(miss!.value).toBe(0);
  });

  it("audit_log rows self-resolve project_id via the 055 trigger", async () => {
    const projectId = await scoredProject("Audit Trail Co", "Lumina");
    const [response] = await sql`
      select r.id from responses r join runs on runs.id = r.run_id
      where runs.project_id = ${projectId} limit 1
    `;
    const task = unwrap(
      await tasksSvc.suggestTask(operator, {
        projectId,
        title: "Trigger resolution check",
        evidence: [{ kind: "response", refId: response?.id as string, note: "seed" }],
      })
    );
    // The writer passed no projectId; the entity join must have resolved it.
    const [row] = await sql`
      select project_id from audit_log
      where entity = 'task' and entity_id = ${task.taskId}
    `;
    expect(row?.projectId).toBe(projectId);
  });

  it("clientValueIndex prefers recorded contract value over the spend proxy", async () => {
    const paying = unwrap(await projectSvc.createProject(operator, { name: "Paying Co" }));
    const proxied = unwrap(await projectSvc.createProject(operator, { name: "Proxy Co" }));
    unwrap(
      await projectSvc.updatePortfolioFields(operator, {
        projectId: paying.id,
        contractValueUsd: 50_000,
      })
    );
    const index = await queue.clientValueIndex();
    // The one contract-valued client is the portfolio max → weight 1.
    expect(index.get(paying.id)).toBe(1);
    // No contract and no spend → honestly absent, not defaulted here.
    expect(index.get(proxied.id)).toBeUndefined();
  });

  it("overdue queue items carry a VALID due date (the twice-caught date bug)", async () => {
    const projectId = await scoredProject("Overdue Co", "Lumina");
    const [response] = await sql`
      select r.id from responses r join runs on runs.id = r.run_id
      where runs.project_id = ${projectId} limit 1
    `;
    const task = unwrap(
      await tasksSvc.suggestTask(operator, {
        projectId,
        title: "Overdue queue item",
        evidence: [{ kind: "response", refId: response?.id as string, note: "seed" }],
      })
    );
    unwrap(await tasksSvc.approveTask(operator, { taskId: task.taskId }));
    unwrap(
      await tasksSvc.updateTaskDetails(operator, {
        taskId: task.taskId,
        dueDate: "2026-07-01",
      })
    );
    const items = await queue.actionRequiredQueue({ projectId, limit: 10 });
    const overdue = items.find((i) => i.source === "task_overdue");
    expect(overdue).toBeDefined();
    // The exact crash shape: an Invalid Date throws on toISOString().
    expect(() => overdue!.dueAt!.toISOString()).not.toThrow();
    expect(Number.isNaN(overdue!.dueAt!.getTime())).toBe(false);
    expect(overdue!.priority.total).toBeGreaterThan(0);
  });

  it("setInterventionVisibility flips the portal flag and audits itself", async () => {
    const projectId = await scoredProject("Visible Co", "Lumina");
    const [version] = await sql`
      select v.id from prompt_set_versions v
      join prompt_sets s on s.id = v.prompt_set_id
      where s.project_id = ${projectId}
    `;
    const created = unwrap(
      await attribution.createIntervention(operator, {
        projectId,
        title: "Portal visibility check",
        shippedAt: new Date().toISOString().slice(0, 10),
        promptSetVersionId: version?.id as string,
        postOffsets: [],
      })
    );
    const flipped = unwrap(
      await attribution.setInterventionVisibility(operator, {
        interventionId: created.interventionId,
        clientVisible: true,
      })
    );
    expect(flipped.clientVisible).toBe(true);
    const [row] = await sql`
      select client_visible from interventions where id = ${created.interventionId}
    `;
    expect(row?.clientVisible).toBe(true);
    const [audit] = await sql`
      select project_id from audit_log
      where action = 'intervention.visibility' and entity_id = ${created.interventionId}
    `;
    expect(audit?.projectId).toBe(projectId);

    const missing = await attribution.setInterventionVisibility(operator, {
      interventionId: "00000000-0000-4000-8000-00000000dead",
      clientVisible: true,
    });
    expect(missing.ok).toBe(false);
  });
});
