/**
 * Integration tests for spec 001 against a real Postgres
 * (TEST_DATABASE_URL, remapped to DATABASE_URL in tests/setup.ts).
 * Skipped entirely when TEST_DATABASE_URL is not configured.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000aa",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};
const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000bb",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

function migrate(direction: "up" | "down"): void {
  execSync(`npx tsx scripts/migrate.ts ${direction} --db "${TEST_URL}"`, {
    cwd: ROOT,
    stdio: "pipe",
  });
}

describe.skipIf(!TEST_URL)("projects (integration)", () => {
  // Dynamic imports so the db client is only created when tests actually run
  let sql: (typeof import("@/db/client"))["sql"];
  let service: typeof import("@/lib/projects/service");
  let listProjects: (typeof import("@/db/projects"))["listProjects"];
  let getProject: (typeof import("@/db/projects"))["getProject"];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    service = await import("@/lib/projects/service");
    ({ listProjects, getProject } = await import("@/db/projects"));
    await sql.unsafe("drop schema public cascade; create schema public;");
    migrate("up");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    // TRUNCATE bypasses row triggers, so this works on insert-only tables too;
    // cascade clears tables added by later migrations that reference projects
    await sql.unsafe("truncate audit_log, projects cascade");
  });

  afterAll(async () => {
    await sql.end();
  });

  it("create → list → get round trip, with audit row", async () => {
    const created = await service.createProject(admin, {
      name: "Parva Core",
      description: "Weekly baseline",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listed = await listProjects({ includeArchived: false });
    expect(listed.map((p) => p.name)).toEqual(["Parva Core"]);

    const fetched = await getProject(created.data.id);
    expect(fetched?.description).toBe("Weekly baseline");
    expect(fetched?.status).toBe("active");

    const audits = await sql`select * from audit_log`;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("project.create");
    expect(audits[0]?.userId).toBe(admin.id);
  });

  it("rejects duplicate active names case-insensitively", async () => {
    await service.createProject(admin, { name: "Parva Core" });
    const dup = await service.createProject(admin, { name: "  parva CORE " });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.kind).toBe("conflict");
  });

  it("only one of two concurrent same-name creates succeeds", async () => {
    const [a, b] = await Promise.all([
      service.createProject(admin, { name: "Race" }),
      service.createProject(admin, { name: "Race" }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok && r.error.kind === "conflict");
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it("updates fields and audit-logs the edit", async () => {
    const created = await service.createProject(admin, { name: "Before" });
    if (!created.ok) throw new Error("setup failed");
    const updated = await service.updateProject(admin, {
      id: created.data.id,
      name: "After",
      description: "now described",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.data.name).toBe("After");
      expect(updated.data.description).toBe("now described");
    }
    const audits = await sql`select action from audit_log order by at`;
    expect(audits.map((a) => a.action)).toEqual([
      "project.create",
      "project.update",
    ]);
  });

  it("blocks edits to archived projects and returns not_found for unknown ids", async () => {
    const created = await service.createProject(admin, { name: "Arch" });
    if (!created.ok) throw new Error("setup failed");
    await service.archiveProject(admin, { id: created.data.id });

    const edit = await service.updateProject(admin, {
      id: created.data.id,
      name: "Nope",
    });
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error.kind).toBe("conflict");

    const missing = await service.updateProject(admin, {
      id: "00000000-0000-4000-8000-00000000dead",
      name: "Ghost",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe("not_found");
  });

  it("archive requires admin role, enforced in the service", async () => {
    const created = await service.createProject(operator, { name: "Guarded" });
    if (!created.ok) throw new Error("setup failed");

    const denied = await service.archiveProject(operator, { id: created.data.id });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe("forbidden");

    const allowed = await service.archiveProject(admin, { id: created.data.id });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.data.status).toBe("archived");
      expect(allowed.data.archivedAt).not.toBeNull();
    }
  });

  it("archived projects are hidden by default, visible with includeArchived, and preserved", async () => {
    const created = await service.createProject(admin, { name: "Hidden" });
    if (!created.ok) throw new Error("setup failed");
    await service.archiveProject(admin, { id: created.data.id });

    expect(await listProjects({ includeArchived: false })).toHaveLength(0);
    const all = await listProjects({ includeArchived: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("archived");
  });

  it("unarchive restores, but blocks when the name now collides with an active project", async () => {
    const first = await service.createProject(admin, { name: "Same Name" });
    if (!first.ok) throw new Error("setup failed");
    await service.archiveProject(admin, { id: first.data.id });

    // Name is free again → a new active project may take it
    const second = await service.createProject(admin, { name: "Same Name" });
    expect(second.ok).toBe(true);

    const blocked = await service.unarchiveProject(admin, { id: first.data.id });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.kind).toBe("conflict");

    // After the collision is gone, unarchive succeeds
    if (second.ok) await service.archiveProject(admin, { id: second.data.id });
    const restored = await service.unarchiveProject(admin, { id: first.data.id });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.data.status).toBe("active");
  });

  it("audit_log rejects UPDATE and DELETE at the database level", async () => {
    await service.createProject(admin, { name: "Audited" });
    await expect(
      sql`update audit_log set action = 'tampered'`
    ).rejects.toThrow(/insert-only/);
    await expect(sql`delete from audit_log`).rejects.toThrow(/insert-only/);
  });

  it("every migration rolls back and re-applies cleanly", async () => {
    const counted = await sql`
      select count(*)::int as count from schema_migrations
    `;
    const count = counted[0]?.count as number;
    for (let i = 0; i < count; i += 1) migrate("down");
    const gone = await sql`select to_regclass('public.projects') as t`;
    expect(gone[0]?.t).toBeNull();
    migrate("up");
    const back = await sql`select to_regclass('public.projects') as t`;
    expect(back[0]?.t).toBe("projects");
    const recounted = await sql`
      select count(*)::int as count from schema_migrations
    `;
    expect(recounted[0]?.count).toBe(count);
    // Timeout scales with migration count — each is a separate tsx process
  }, 60_000);
});
