/**
 * Spec 034 — the learnings store. Confidence labels that assert evidence
 * must point at measured outcomes; retirement requires a reason and keeps
 * the row readable; search spans project + cross-project rows.
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

const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("learnings (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/learnings/service");
  let projectSvc: typeof import("@/lib/projects/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    svc = await import("@/lib/learnings/service");
    projectSvc = await import("@/lib/projects/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`update users set role = 'client_viewer' where id = ${clientViewer.id}`;
  });

  beforeEach(async () => {
    await sql.unsafe(
      "truncate audit_log, learnings, action_outcomes, projects cascade"
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedProjectId(): Promise<string> {
    const project = await projectSvc.createProject(user, { name: "Learn Test" });
    if (!project.ok) throw new Error(project.error.message);
    return project.data.id;
  }

  async function seedOutcome(
    projectId: string,
    measured: boolean
  ): Promise<string> {
    const [row] = await sql`
      insert into action_outcomes (project_id, action_type, effectiveness, measured_at)
      values (${projectId}, 'content_asset',
        ${measured ? "positive_signal" : "insufficient_measurement"},
        ${measured ? sql`now()` : null})
      returning id
    `;
    return row!.id as string;
  }

  it("records a learning with an audit row; client accounts cannot", async () => {
    const projectId = await seedProjectId();
    const result = await svc.recordLearning(user, {
      projectId,
      category: "content",
      statement: "Comparison pages lift recommendation rate for comparison prompts.",
      confidenceLabel: "probable",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("active");

    const [audit] = await sql`
      select action from audit_log where entity_id = ${result.data.id}
    `;
    expect(audit?.action).toBe("learning.recorded");

    const denied = await svc.recordLearning(clientViewer, {
      category: "content",
      statement: "nope",
      confidenceLabel: "unknown",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe("forbidden");
  });

  it("confirmed requires measured source outcomes — unmeasured or missing ones are named", async () => {
    const projectId = await seedProjectId();

    const noSources = await svc.recordLearning(user, {
      projectId,
      category: "authority",
      statement: "Third-party citations drive recommendations in this vertical.",
      confidenceLabel: "confirmed",
    });
    expect(noSources.ok).toBe(false);
    if (!noSources.ok) expect(noSources.error.message).toContain("at least one");

    const unmeasured = await seedOutcome(projectId, false);
    const notYet = await svc.recordLearning(user, {
      projectId,
      category: "authority",
      statement: "Third-party citations drive recommendations in this vertical.",
      confidenceLabel: "confirmed",
      sourceActionOutcomeIds: [unmeasured],
    });
    expect(notYet.ok).toBe(false);
    if (!notYet.ok) expect(notYet.error.message).toContain(unmeasured);

    const measured = await seedOutcome(projectId, true);
    const confirmed = await svc.recordLearning(user, {
      projectId,
      category: "authority",
      statement: "Third-party citations drive recommendations in this vertical.",
      confidenceLabel: "confirmed",
      sourceActionOutcomeIds: [measured],
    });
    expect(confirmed.ok).toBe(true);
  });

  it("search matches text, respects category, and includes cross-project rows", async () => {
    const projectId = await seedProjectId();
    await svc.recordLearning(user, {
      projectId,
      category: "content",
      statement: "FAQ pages get cited for how-to prompts.",
      confidenceLabel: "correlated",
    });
    await svc.recordLearning(user, {
      projectId: null,
      category: "process",
      statement: "Weekly cadence beats monthly for catching movement.",
      confidenceLabel: "probable",
    });

    const byProject = await svc.searchLearnings({ projectId });
    expect(byProject).toHaveLength(2); // project row + cross-project row

    const byText = await svc.searchLearnings({ query: "faq" });
    expect(byText).toHaveLength(1);
    expect(byText[0]?.category).toBe("content");

    const byCategory = await svc.searchLearnings({ category: "process" });
    expect(byCategory).toHaveLength(1);
  });

  it("retiring requires a reason, keeps the row, and hides it from default search", async () => {
    const projectId = await seedProjectId();
    const recorded = await svc.recordLearning(user, {
      projectId,
      category: "technical",
      statement: "Schema markup made no measurable difference here.",
      confidenceLabel: "correlated",
    });
    if (!recorded.ok) throw new Error("seed failed");

    const noReason = await svc.retireLearning(user, { id: recorded.data.id, reason: " " });
    expect(noReason.ok).toBe(false);

    const retired = await svc.retireLearning(user, {
      id: recorded.data.id,
      reason: "Contradicted by the Q3 measurement round.",
    });
    expect(retired.ok).toBe(true);

    const again = await svc.retireLearning(user, {
      id: recorded.data.id,
      reason: "twice",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe("conflict");

    expect(await svc.searchLearnings({ projectId })).toHaveLength(0);
    const withRetired = await svc.searchLearnings({ projectId, includeRetired: true });
    expect(withRetired).toHaveLength(1);
    expect(withRetired[0]?.retiredReason).toContain("Q3");
  });
});
