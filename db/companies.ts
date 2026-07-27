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
