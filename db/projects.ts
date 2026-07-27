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

export async function listProjects(opts: {
  includeArchived: boolean;
}): Promise<ProjectWithCounts[]> {
  return sql<ProjectWithCounts[]>`
    select p.id, p.name, p.description, p.status, p.created_at, p.archived_at,
      (select count(*)::int from prompt_sets s
        where s.project_id = p.id and s.archived_at is null) as prompt_set_count,
      (select count(*)::int from runs r
        where r.project_id = p.id) as run_count
    from projects p
    ${opts.includeArchived ? sql`` : sql`where p.status = 'active'`}
    order by p.created_at desc
  `;
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
  const rows = await sql<ProjectWithCounts[]>`
    select p.id, p.name, p.description, p.status, p.created_at, p.archived_at,
      (select count(*)::int from prompt_sets s
        where s.project_id = p.id and s.archived_at is null) as prompt_set_count,
      (select count(*)::int from runs r
        where r.project_id = p.id) as run_count
    from projects p
    where p.id = ${id}
  `;
  return rows[0] ?? null;
}
