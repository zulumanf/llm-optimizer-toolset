/**
 * Spec 030 integration: movement events flow into the derived notification
 * system (dedup, self-resolve), and portfolio fields round-trip with the
 * standard denials. Score history is inserted directly — the pure detector
 * has its own fixtures; this proves the plumbing around it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000501",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const client: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000502",
  email: "client@example.com",
  name: "Client Viewer",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("competitor movement & portfolio fields (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let movement: typeof import("@/lib/competitors/movement");
  let notifications: typeof import("@/lib/notifications/service");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let competitorSvc: typeof import("@/lib/competitors/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let projectsDb: typeof import("@/db/projects");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    movement = await import("@/lib/competitors/movement");
    notifications = await import("@/lib/notifications/service");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    competitorSvc = await import("@/lib/competitors/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    projectsDb = await import("@/db/projects");
    await seedTestActors(sql);
    await sql`
      insert into users (id, email, name, role) values
        (${user.id}, ${user.email}, ${user.name}, 'operator'),
        (${client.id}, ${client.email}, ${client.name}, 'client_viewer')
      on conflict (id) do nothing
    `;
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate notifications, scores, runs, prompt_set_versions, prompts,
        prompt_sets, competitors, companies, audit_log, projects cascade
    `);
  });

  interface Seeded {
    projectId: string;
    subjectId: string;
    competitorId: string;
    versionId: string;
  }

  async function seed(): Promise<Seeded> {
    const subject = await companySvc.upsertCompany(user, { name: "Lumina" });
    if (!subject.ok) throw new Error(subject.error.message);
    const competitor = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!competitor.ok) throw new Error(competitor.error.message);
    const project = await projectSvc.createProject(user, { name: "Movement Co" });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: subject.data.id,
    });
    await competitorSvc.addCompetitor(user, {
      projectId: project.data.id,
      companyId: competitor.data.id,
      tier: "primary",
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "best tool?",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    return {
      projectId: project.data.id,
      subjectId: subject.data.id,
      competitorId: competitor.data.id,
      versionId: version?.id as string,
    };
  }

  /** Insert a completed run with mention_rate scores for both companies. */
  async function scoredRun(
    seeded: Seeded,
    startedAt: string,
    rates: { subject: number; competitor: number }
  ): Promise<void> {
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        status, trigger, budget_usd, started_at)
      values (${seeded.projectId}, ${seeded.versionId}, ${"m " + startedAt},
        '[]', 'completed', 'manual', 1, ${startedAt})
      returning id
    `;
    const insert = (companyId: string, provider: string, value: number) => sql`
      insert into scores (run_id, company_id, metric, provider, value,
        sample_size, scoring_version)
      values (${run?.id as string}, ${companyId}, 'mention_rate', ${provider},
        ${value}, 40, 'v1.1')
    `;
    for (const provider of ["openai", "google", "all"]) {
      await insert(seeded.subjectId, provider, rates.subject);
      await insert(seeded.competitorId, provider, rates.competitor);
    }
  }

  it("overtake alerts, deduped and self-resolving", async () => {
    const seeded = await seed();
    await scoredRun(seeded, "2026-07-01", { subject: 0.55, competitor: 0.4 });
    await scoredRun(seeded, "2026-07-15", { subject: 0.45, competitor: 0.62 });

    const events = await movement.movementForProject(seeded.projectId);
    expect(events.some((e) => e.kind === "competitor_overtake")).toBe(true);
    expect(events.some((e) => e.kind === "visibility_drop")).toBe(true);

    const first = await notifications.syncNotifications();
    const [overtake] = await sql`
      select status, body from notifications
      where kind = 'competitor_overtake'
    `;
    expect(overtake).toBeDefined();
    expect(first.created).toBeGreaterThan(0);

    // Idempotent: a re-sync creates nothing new.
    const second = await notifications.syncNotifications();
    expect(second.created).toBe(0);

    // A newer run without the condition resolves the alert (derived state).
    await scoredRun(seeded, "2026-07-29", { subject: 0.7, competitor: 0.5 });
    await notifications.syncNotifications();
    const [resolved] = await sql`
      select status from notifications where kind = 'competitor_overtake'
    `;
    expect(resolved?.status).toBe("resolved");
  });

  it("stays silent across prompt-set versions — a changed ruler is not movement", async () => {
    const seeded = await seed();
    await scoredRun(seeded, "2026-07-01", { subject: 0.55, competitor: 0.4 });
    // New frozen version between runs (content change re-freezes).
    const [setRow] = await sql`
      select prompt_set_id as id from prompt_set_versions where id = ${seeded.versionId}
    `;
    await promptSvc.addPrompt(user, {
      setId: setRow?.id as string,
      text: "another question?",
      category: "problem",
    });
    await setSvc.freezePromptSet(user, { id: setRow?.id as string });
    const [v2] = await sql`
      select id from prompt_set_versions
      where prompt_set_id = ${setRow?.id as string} order by version desc limit 1
    `;
    await scoredRun(
      { ...seeded, versionId: v2?.id as string },
      "2026-07-15",
      { subject: 0.45, competitor: 0.62 }
    );
    const events = await movement.movementForProject(seeded.projectId);
    expect(events).toHaveLength(0);
  });

  it("portfolio fields round-trip, filter, and deny client writes", async () => {
    const seeded = await seed();
    const saved = await projectSvc.updatePortfolioFields(user, {
      projectId: seeded.projectId,
      accountOwnerId: user.id,
      serviceTier: "premium",
    });
    expect(saved.ok).toBe(true);

    const filtered = await projectsDb.listPortfolio({
      includeArchived: false,
      ownerId: user.id,
      serviceTier: "premium",
    });
    expect(filtered.map((p) => p.id)).toEqual([seeded.projectId]);
    // seedTestActors may own this uuid under its own name — assert the
    // join resolved, not a specific label.
    expect(filtered[0]?.accountOwnerId).toBe(user.id);
    expect(filtered[0]?.accountOwnerName).toBeTruthy();

    const none = await projectsDb.listPortfolio({
      includeArchived: false,
      serviceTier: "exclusive",
    });
    expect(none).toHaveLength(0);

    const denied = await projectSvc.updatePortfolioFields(client, {
      projectId: seeded.projectId,
      serviceTier: "standard",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe("forbidden");
  });
});
