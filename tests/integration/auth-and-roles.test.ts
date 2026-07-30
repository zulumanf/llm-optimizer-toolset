/**
 * Spec 014 acceptance criteria.
 *
 * The RLS tests are the ones worth having. They connect as a NON-OWNER role,
 * because the application's own connection is the table owner and owners
 * bypass row-level security — so a test run on the normal connection would
 * pass while proving nothing. Getting that wrong is the standard way an RLS
 * test suite ends up green and worthless.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const STAFF: CurrentUser = {
  id: "00000000-0000-4000-8000-00000000a001",
  email: "staff@parva.local",
  name: "Staff",
  role: "operator",
};
const CLIENT: CurrentUser = {
  id: "00000000-0000-4000-8000-00000000a002",
  email: "client@example.com",
  name: "Client Viewer",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("auth and roles (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let auth: typeof import("@/lib/auth");
  let accessLog: typeof import("@/lib/security/access-log");
  let projectSvc: typeof import("@/lib/projects/service");

  let projectA = "";
  let projectB = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    auth = await import("@/lib/auth");
    accessLog = await import("@/lib/security/access-log");
    projectSvc = await import("@/lib/projects/service");

    await sql.unsafe("drop schema public cascade; create schema public;");
    await sql.unsafe("drop schema if exists auth cascade;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);

    // A non-owner role, so policies actually apply.
    await sql.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'rls_tester') then
          create role rls_tester nologin;
        end if;
      end $$;
      grant usage on schema public, auth to rls_tester;
      grant select on all tables in schema public to rls_tester;
      grant execute on all functions in schema public, auth to rls_tester;
    `);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate artifact_access_log, user_project_access, audit_log,
        projects, users restart identity cascade
    `);
    await sql`
      insert into users (id, email, name, role) values
        (${STAFF.id}, ${STAFF.email}, ${STAFF.name}, 'operator'),
        (${CLIENT.id}, ${CLIENT.email}, ${CLIENT.name}, 'client_viewer')
    `;
    const a = await projectSvc.createProject(STAFF, { name: "Client A" });
    const b = await projectSvc.createProject(STAFF, { name: "Client B" });
    if (!a.ok || !b.ok) throw new Error("project setup failed");
    projectA = a.data.id;
    projectB = b.data.id;
    await sql`
      insert into user_project_access (user_id, project_id, granted_by)
      values (${CLIENT.id}, ${projectA}, ${STAFF.id})
    `;
  });

  // --------------------------------------------------------- dev mode intact

  it("keeps dev mode working with no Supabase reachable", async () => {
    // The acceptance criterion the whole test suite depends on: 900 tests must
    // not need an inbox.
    expect(process.env.AUTH_MODE ?? "dev").not.toBe("supabase");
    const user = await auth.getCurrentUser();
    expect(user.id).toBe(auth.DEV_USER_ID);
    expect(user.role).toBe("admin");
  });

  // ------------------------------------------------------------ role model

  it("treats only agency roles as staff", () => {
    expect(auth.isStaff({ role: "admin" })).toBe(true);
    expect(auth.isStaff({ role: "operator" })).toBe(true);
    expect(auth.isStaff({ role: "reviewer" })).toBe(true);
    expect(auth.isStaff({ role: "client_viewer" })).toBe(false);
    expect(auth.isStaff({ role: "client_validator" })).toBe(false);
  });

  it("refuses any write from a client account", () => {
    expect(() => auth.assertCanWrite(CLIENT)).toThrow(/read-only/i);
    expect(() => auth.assertCanWrite(STAFF)).not.toThrow();
  });

  it("denies admin-only actions to an operator", () => {
    expect(() => auth.assertRole(STAFF, "admin")).toThrow(/admin role/i);
    expect(() => auth.assertRole({ ...STAFF, role: "admin" }, "admin")).not.toThrow();
  });

  it("denies staff-only actions to a client account", () => {
    expect(() => auth.assertRole(CLIENT, "operator")).toThrow(/staff role/i);
  });

  it("returns null visible-project ids for staff, meaning unrestricted", async () => {
    // Not an empty list: staff must see a project created a second ago without
    // anyone remembering to grant it.
    expect(await auth.visibleProjectIds(STAFF)).toBeNull();
  });

  it("returns exactly the granted projects for a client account", async () => {
    const visible = await auth.visibleProjectIds(CLIENT);
    expect(visible).toEqual([projectA]);
    expect(visible).not.toContain(projectB);
  });

  // ------------------------------------------------------------------- RLS

  /** Run a query as a non-owner adopting `userId`, so policies apply. */
  async function asUser<T>(userId: string | null, query: string): Promise<T[]> {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("set local role rls_tester");
      await tx.unsafe(
        `set local app.current_user_id = ${userId ? `'${userId}'` : "''"}`
      );
      return tx.unsafe(query);
    });
    return rows as unknown as T[];
  }

  it("shows a client account only the projects it was granted", async () => {
    const rows = await asUser<{ id: string }>(CLIENT.id, "select id from projects");
    expect(rows.map((r) => r.id)).toEqual([projectA]);
  });

  it("shows staff every project", async () => {
    const rows = await asUser<{ id: string }>(STAFF.id, "select id from projects");
    expect(rows).toHaveLength(2);
  });

  it("shows an unauthenticated connection nothing at all", async () => {
    const rows = await asUser<{ id: string }>(null, "select id from projects");
    expect(rows).toHaveLength(0);
  });

  it("hides projects from a deactivated account", async () => {
    await sql`update users set active = false where id = ${CLIENT.id}`;
    const rows = await asUser<{ id: string }>(CLIENT.id, "select id from projects");
    // Deactivation must take effect immediately, not at next token refresh.
    expect(rows).toHaveLength(0);
  });

  it("stops a client account reading another user's grants", async () => {
    // A second user's grant exists, so "sees only its own" is a real
    // restriction here rather than a vacuous truth over one row.
    await sql`
      insert into user_project_access (user_id, project_id, granted_by)
      values (${STAFF.id}, ${projectB}, ${STAFF.id})
    `;
    // Aliased: the client applies `transform: postgres.camel`, so selecting
    // `user_id` yields a `userId` key and comparing `user_id` reads undefined.
    const rows = await asUser<{ owner: string }>(
      CLIENT.id,
      "select user_id as owner from user_project_access"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe(CLIENT.id);
  });

  it("stops a client account enumerating the user list", async () => {
    const rows = await asUser<{ id: string }>(CLIENT.id, "select id from users");
    expect(rows.map((r) => r.id)).toEqual([CLIENT.id]);
  });

  // ------------------------------------------------------- audit & access

  it("ties audit rows to a real user row", async () => {
    const rows = await sql`
      select a.user_id, u.email from audit_log a join users u on u.id = a.user_id limit 1
    `;
    expect(rows[0]?.email).toBe(STAFF.email);
  });

  it("rejects an audit row for an unknown actor", async () => {
    // The FK is the point: "who did this" stops being a free-text guess.
    await expect(
      sql`insert into audit_log (user_id, action, entity, entity_id)
          values ('00000000-0000-4000-8000-0000000000ff', 'x', 'y', null)`
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("records an evidence download with its actor", async () => {
    await sql.begin((tx) =>
      accessLog.recordArtifactAccess(tx, {
        userId: STAFF.id,
        artifactType: "evidence_export",
        artifactId: "00000000-0000-4000-8000-00000000b001",
        projectId: projectA,
      })
    );
    const rows = await accessLog.recentArtifactAccess(projectA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userEmail).toBe(STAFF.email);
    expect(rows[0]!.action).toBe("download");
  });

  it("refuses to alter an access record once written", async () => {
    await sql.begin((tx) =>
      accessLog.recordArtifactAccess(tx, {
        userId: STAFF.id,
        artifactType: "report",
        artifactId: "00000000-0000-4000-8000-00000000b002",
        projectId: projectA,
      })
    );
    // An access record that can be edited is not an access record.
    await expect(
      sql`update artifact_access_log set user_id = null`
    ).rejects.toThrow(/forbidden|immutable/i);
    await expect(sql`delete from artifact_access_log`).rejects.toThrow(
      /forbidden|immutable/i
    );
  });
});
