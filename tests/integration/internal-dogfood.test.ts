/**
 * Internal dogfood isolation (migration 084): a kind='internal' project runs
 * the full measurement pipeline but never appears on any client/portfolio
 * surface — dogfood data must not blend into client metrics.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000601",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("internal dogfood project (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let projectsDb: typeof import("@/db/projects");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    projectsDb = await import("@/db/projects");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`
      insert into users (id, email, name, role)
      values (${user.id}, ${user.email}, ${user.name}, 'operator')
      on conflict (id) do nothing
    `;
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  it("accepts kind='internal' and hides it from every client surface", async () => {
    const clientProject = await projectSvc.createProject(user, { name: "Real Client" });
    if (!clientProject.ok) throw new Error(clientProject.error.message);
    const dogfood = await projectSvc.createProject(user, { name: "RecommendedFirst" });
    if (!dogfood.ok) throw new Error(dogfood.error.message);
    await sql`update projects set kind = 'internal' where id = ${dogfood.data.id}`;

    const portfolio = await projectsDb.listPortfolio({ includeArchived: true });
    expect(portfolio.map((p) => p.id)).not.toContain(dogfood.data.id);
    expect(portfolio.map((p) => p.id)).toContain(clientProject.data.id);

    const projects = await projectsDb.listProjects({ includeArchived: true });
    expect(projects.map((p) => p.id)).not.toContain(dogfood.data.id);

    const active = await projectsDb.listActiveProjects();
    expect(active.map((p) => p.id)).not.toContain(dogfood.data.id);

    // The internal surface finds it; the full project detail keeps working.
    const internal = await projectsDb.getInternalProject();
    expect(internal?.id).toBe(dogfood.data.id);
    const detail = await projectsDb.getProject(dogfood.data.id);
    expect(detail?.name).toBe("RecommendedFirst");
  });
});
