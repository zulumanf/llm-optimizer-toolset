import { sql } from "@/db/client";

export type ProjectStatus = "active" | "archived";

export interface Project {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface ProjectWithCounts extends Project {
  promptSetCount: number;
  runCount: number;
}

/**
 * Counts are 0 until specs/002 (prompt_sets) and specs/003 (runs) create
 * their tables — noted in spec 001; wire real counts in those specs.
 */
export async function listProjects(opts: {
  includeArchived: boolean;
}): Promise<ProjectWithCounts[]> {
  const rows = await sql<Project[]>`
    select id, name, description, status, created_at, archived_at
    from projects
    ${opts.includeArchived ? sql`` : sql`where status = 'active'`}
    order by created_at desc
  `;
  return rows.map((r) => ({ ...r, promptSetCount: 0, runCount: 0 }));
}

export async function listActiveProjects(): Promise<Project[]> {
  return sql<Project[]>`
    select id, name, description, status, created_at, archived_at
    from projects
    where status = 'active'
    order by name asc
  `;
}

export async function getProject(id: string): Promise<ProjectWithCounts | null> {
  const rows = await sql<Project[]>`
    select id, name, description, status, created_at, archived_at
    from projects
    where id = ${id}
  `;
  const row = rows[0];
  return row ? { ...row, promptSetCount: 0, runCount: 0 } : null;
}
