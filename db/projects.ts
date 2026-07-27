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

/** runCount stays 0 until specs/003 creates the runs table (noted in spec 001). */
export async function listProjects(opts: {
  includeArchived: boolean;
}): Promise<ProjectWithCounts[]> {
  const rows = await sql<Omit<ProjectWithCounts, "runCount">[]>`
    select p.id, p.name, p.description, p.status, p.created_at, p.archived_at,
      (select count(*)::int from prompt_sets s
        where s.project_id = p.id and s.archived_at is null) as prompt_set_count
    from projects p
    ${opts.includeArchived ? sql`` : sql`where p.status = 'active'`}
    order by p.created_at desc
  `;
  return rows.map((r) => ({ ...r, runCount: 0 }));
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
  const rows = await sql<Omit<ProjectWithCounts, "runCount">[]>`
    select p.id, p.name, p.description, p.status, p.created_at, p.archived_at,
      (select count(*)::int from prompt_sets s
        where s.project_id = p.id and s.archived_at is null) as prompt_set_count
    from projects p
    where p.id = ${id}
  `;
  const row = rows[0];
  return row ? { ...row, runCount: 0 } : null;
}
