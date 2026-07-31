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

export interface PortfolioRow extends ProjectWithCounts {
  subjectName: string | null;
  authorityScore: number | null;
  lastRunLabel: string | null;
  lastRunStatus: string | null;
  openFindings: number;
}

/** The client-portfolio view: each project with its subject and headline
 * numbers (latest scored run's 'all' authority for the subject). */
export async function listPortfolio(opts: {
  includeArchived: boolean;
  /** null = unrestricted (staff); a list = the caller's project grants. */
  visibleIds?: string[] | null;
}): Promise<PortfolioRow[]> {
  const visibleIds = opts.visibleIds ?? null;
  return sql<PortfolioRow[]>`
    select p.id, p.name, p.description, p.status, p.created_at, p.archived_at,
      (select count(*)::int from prompt_sets s
        where s.project_id = p.id and s.archived_at is null) as prompt_set_count,
      (select count(*)::int from runs r where r.project_id = p.id) as run_count,
      subject.name as subject_name,
      (select s.value from scores s
        join runs r on r.id = s.run_id
        where r.project_id = p.id and s.company_id = subject.id
          and s.metric = 'authority_score' and s.provider = 'all'
        order by r.started_at desc limit 1) as authority_score,
      last_run.label as last_run_label,
      last_run.status as last_run_status,
      (select count(*)::int from gap_findings f
        where f.project_id = p.id and f.status = 'open') as open_findings
    from projects p
    left join companies subject on subject.id = coalesce(
      p.subject_company_id,
      (select id from companies where is_self and archived_at is null limit 1))
    left join lateral (
      select label, status from runs
      where project_id = p.id order by started_at desc limit 1
    ) last_run on true
    where (${opts.includeArchived} or p.status = 'active')
    ${visibleIds === null ? sql`` : sql`and p.id = any(${visibleIds})`}
    order by p.created_at desc
  `;
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

/**
 * `visibleIds` is the caller's project grant from `visibleProjectIds()`:
 * null means unrestricted (staff), a list means exactly those projects.
 * The filter lives in SQL so a client account's sidebar and portfolio never
 * even read other clients' names.
 */
export async function listActiveProjects(
  visibleIds: string[] | null = null
): Promise<Project[]> {
  return sql<Project[]>`
    select id, name, description, status, created_at, archived_at
    from projects
    where status = 'active'
    ${visibleIds === null ? sql`` : sql`and id = any(${visibleIds})`}
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
