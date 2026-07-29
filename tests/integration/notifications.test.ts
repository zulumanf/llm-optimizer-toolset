/**
 * Integration tests for notifications (docs/17 B2). The contract that
 * matters: notifications are DERIVED from live state — they self-resolve,
 * never stack duplicates, and re-open if a fixed issue comes back.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000001001",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("notifications (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let notifications: typeof import("@/lib/notifications/service");
  let onboarding: typeof import("@/lib/verticals/onboarding");
  let projectSvc: typeof import("@/lib/projects/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let companySvc: typeof import("@/lib/companies/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    notifications = await import("@/lib/notifications/service");
    onboarding = await import("@/lib/verticals/onboarding");
    projectSvc = await import("@/lib/projects/service");
    claimsSvc = await import("@/lib/claims/service");
    companySvc = await import("@/lib/companies/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, notifications, accuracy_findings,
       evidence_exports, client_validation_observations, client_validation_runs,
       audit_samples, evidence_artifacts, content_versions, content_assets,
       gap_findings, claims, tasks, evidence, intervention_runs, interventions,
       reports, brand_candidates, competitors, scores, sources,
       response_parses, mentions, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects,
       vertical_packs cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  /** A project with no subject is an urgent signal — the simplest reliable
   * way to create and then clear a notifiable condition. */
  async function brokenProject(name: string): Promise<string> {
    const project = await projectSvc.createProject(user, { name });
    if (!project.ok) throw new Error(project.error.message);
    return project.data.id;
  }

  async function fixSubject(projectId: string, companyName: string): Promise<void> {
    const company = await companySvc.upsertCompany(user, {
      name: companyName,
      aliases: [],
    });
    if (!company.ok) throw new Error(company.error.message);
    const set = await claimsSvc.setSubjectCompany(user, {
      projectId,
      companyId: company.data.id,
    });
    if (!set.ok) throw new Error(set.error.message);
  }

  it("creates notifications only for real work, not hygiene", async () => {
    await onboarding.onboardClient(user, {
      clientName: "Hygiene Only",
      packKey: "generic-product",
      company: { name: "Hygiene Co", aliases: [] },
      variables: { category: ["widget"], audience: ["builders"] },
      facts: [],
      competitors: [],
    });
    const result = await notifications.syncNotifications();
    // A fresh client is all info-level setup — nothing should notify
    expect(result.created).toBe(0);
    expect(await notifications.unreadCount()).toBe(0);
  });

  it("creates one notification per issue and never duplicates on re-sync", async () => {
    await brokenProject("Broken One");
    const first = await notifications.syncNotifications();
    expect(first.created).toBe(1);

    const second = await notifications.syncNotifications();
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(1);

    const [count] = await sql`select count(*)::int as n from notifications`;
    expect(count?.n).toBe(1);
    expect(await notifications.unreadCount()).toBe(1);
  });

  it("self-resolves when the underlying issue is fixed", async () => {
    const projectId = await brokenProject("Fix Me");
    await notifications.syncNotifications();
    expect(await notifications.unreadCount()).toBe(1);

    await fixSubject(projectId, "Fix Me Co");
    const result = await notifications.syncNotifications();
    expect(result.resolved).toBe(1);
    expect(await notifications.unreadCount()).toBe(0);

    const open = await notifications.listNotifications({ status: "open" });
    expect(open).toHaveLength(0);
    const resolved = await notifications.listNotifications({ status: "resolved" });
    expect(resolved).toHaveLength(1);
  });

  it("re-opens a resolved notification if the issue returns", async () => {
    const projectId = await brokenProject("Regression");
    await notifications.syncNotifications();
    await fixSubject(projectId, "Regression Co");
    await notifications.syncNotifications();

    // Break it again
    await sql`update projects set subject_company_id = null where id = ${projectId}`;
    await sql`update companies set archived_at = now()`;
    const result = await notifications.syncNotifications();
    expect(result.created).toBe(0); // same dedupe key, reused row
    expect(await notifications.unreadCount()).toBe(1);
    const [row] = await sql`select status, resolved_at from notifications`;
    expect(row?.status).toBe("unread");
    expect(row?.resolvedAt).toBeNull();
  });

  it("read and dismissed states survive re-sync; dismissal is audited", async () => {
    await brokenProject("Stateful");
    await notifications.syncNotifications();
    const [notification] = await notifications.listNotifications({ status: "open" });

    const read = await notifications.setNotificationStatus(user, {
      notificationId: notification!.id,
      status: "read",
    });
    expect(read.ok).toBe(true);
    await notifications.syncNotifications();
    const [afterSync] = await sql`select status from notifications`;
    expect(afterSync?.status).toBe("read"); // not reset to unread

    const dismissed = await notifications.setNotificationStatus(user, {
      notificationId: notification!.id,
      status: "dismissed",
    });
    expect(dismissed.ok).toBe(true);
    const audits = await sql`
      select action from audit_log where action = 'notification.dismiss'
    `;
    expect(audits).toHaveLength(1);

    // A dismissed notification stays out of the open list even after re-sync
    await notifications.syncNotifications();
    const open = await notifications.listNotifications({ status: "open" });
    expect(open).toHaveLength(0);
  });

  it("markAllRead clears the badge and the digest reflects open work", async () => {
    await brokenProject("Digest A");
    await brokenProject("Digest B");
    await notifications.syncNotifications();
    expect(await notifications.unreadCount()).toBe(2);

    const digest = await notifications.digestText();
    expect(digest).toContain("URGENT");
    expect(digest).toContain("Digest A");
    expect(digest).toContain("Digest B");

    const marked = await notifications.markAllRead();
    expect(marked).toBe(2);
    expect(await notifications.unreadCount()).toBe(0);
    // Still open (read ≠ resolved), so the digest still lists them
    expect(await notifications.digestText()).toContain("Digest A");
  });

  it("digest is honest when nothing is open", async () => {
    expect(await notifications.digestText()).toBe("Nothing open across all clients.");
  });
});
