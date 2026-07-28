import { sql } from "@/db/client";

export interface Company {
  id: string;
  name: string;
  aliases: string[];
  domain: string | null;
  isSelf: boolean;
  createdAt: Date;
  archivedAt: Date | null;
}

const COLUMNS = sql`id, name, aliases, domain, is_self, created_at, archived_at`;

export async function listCompanies(opts?: {
  includeArchived?: boolean;
}): Promise<Company[]> {
  return sql<Company[]>`
    select ${COLUMNS} from companies
    ${opts?.includeArchived ? sql`` : sql`where archived_at is null`}
    order by is_self desc, name asc
  `;
}

export async function listActiveCompanies(): Promise<Company[]> {
  return sql<Company[]>`
    select ${COLUMNS} from companies where archived_at is null
    order by is_self desc, name asc
  `;
}

export async function getCompany(id: string): Promise<Company | null> {
  const rows = await sql<Company[]>`select ${COLUMNS} from companies where id = ${id}`;
  return rows[0] ?? null;
}

export async function selfCompanyExists(): Promise<boolean> {
  const rows = await sql`
    select 1 from companies where is_self and archived_at is null limit 1
  `;
  return rows.length > 0;
}

/**
 * The project's subject (client) company — explicit subject_company_id, with
 * the legacy global is_self company as fallback (docs/15 migration path).
 */
export async function getSubjectCompany(projectId: string): Promise<Company | null> {
  const rows = await sql<Company[]>`
    select c.id, c.name, c.aliases, c.domain, c.is_self, c.created_at, c.archived_at
    from projects p
    join companies c on c.id = coalesce(
      p.subject_company_id,
      (select id from companies where is_self and archived_at is null limit 1)
    )
    where p.id = ${projectId} and c.archived_at is null
  `;
  return rows[0] ?? null;
}

/**
 * Companies this project's parser/scorer considers: its subject plus every
 * active company that is not another project's subject — clients never leak
 * into each other's measurements (spec 008 no-cross-talk).
 */
export async function listCompaniesForProject(projectId: string): Promise<Company[]> {
  const subject = await getSubjectCompany(projectId);
  return sql<Company[]>`
    select id, name, aliases, domain, is_self, created_at, archived_at
    from companies
    where archived_at is null
      and (
        id = ${subject?.id ?? null} or
        id not in (
          select subject_company_id from projects
          where subject_company_id is not null and id != ${projectId}
        )
      )
    order by (id = ${subject?.id ?? null}) desc, name asc
  `;
}
