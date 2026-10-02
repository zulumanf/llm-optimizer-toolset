/**
 * A client's recorded subject identity (spec 145D).
 *
 * The names a claim on a third-party page may legitimately be about: the
 * client's subject company, that company's aliases, and the people a human
 * already accepted as this client's (active `person` entities). Everything
 * comes from stored records for one project — never from the page being read,
 * an event payload, observed `entity_aliases`, or shared entities.
 *
 * Discovery and profile correction both read identity here, so there is one
 * definition of "who this client is".
 */
import { sql } from "@/db/client";

export interface ClientSubjectIdentity {
  /** The subject company's name. */
  name: string;
  aliases: string[];
  domain: string | null;
  /** Active person entities of this project, oldest first. */
  principals: string[];
}

export type SubjectIdentityLookup =
  | { status: "client_not_found" }
  | { status: "no_subject_company" }
  | { status: "resolved"; identity: ClientSubjectIdentity };

export async function loadClientSubjectIdentity(
  projectId: string,
  options: {
    /** Cap on principals; omitted means every active person entity. */
    principalLimit?: number;
    /** Skip the principal read when the caller supplies its own. */
    skipPrincipals?: boolean;
  } = {}
): Promise<SubjectIdentityLookup> {
  const [row] = await sql`
    select p.id, c.name, c.aliases, c.domain
    from projects p
    left join companies c on c.id = p.subject_company_id
    where p.id = ${projectId}
  `;
  if (!row) return { status: "client_not_found" };
  if (!row.name) return { status: "no_subject_company" };

  // Principals come from recorded entities rather than from parsing claim
  // prose: an entity row is something a human already accepted as a person.
  // `limit null` is no limit.
  const principals = options.skipPrincipals
    ? []
    : (
        await sql`
          select canonical_name from knowledge_entities
          where project_id = ${projectId} and entity_type = 'person'
            and status = 'active'
          order by created_at limit ${options.principalLimit ?? null}
        `
      ).map((r) => r.canonicalName as string);

  return {
    status: "resolved",
    identity: {
      name: row.name as string,
      aliases: (row.aliases as string[] | null) ?? [],
      domain: (row.domain as string | null) ?? null,
      principals,
    },
  };
}

/**
 * The subject allow list for canonical extraction: name, then aliases, then
 * principals — trimmed, blanks dropped, de-duplicated case-insensitively
 * keeping the first spelling.
 */
export function subjectAllowListFor(
  identity: Pick<ClientSubjectIdentity, "name" | "aliases" | "principals">
): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of [identity.name, ...identity.aliases, ...identity.principals]) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    seen.add(key);
    list.push(value);
  }
  return list;
}
