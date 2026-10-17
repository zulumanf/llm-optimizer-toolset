/** Structured-data suggestion for a project from its approved claims only. */
import { sql } from "@/db/client";
import { assertProjectAccess, type CurrentUser } from "@/lib/auth";
import { buildStructuredData, type EntityKind, type JsonLdResult } from "@/lib/optimization/jsonld";

export async function structuredDataSuggestion(user: CurrentUser, projectId: string, kind: EntityKind): Promise<JsonLdResult> {
  await assertProjectAccess(user, projectId);
  const claims = await sql`
    select id, key, canonical_text, value from claims
    where project_id = ${projectId} and status = 'approved'
    order by key
  `;
  return buildStructuredData(
    kind,
    claims.map((c) => ({ id: c.id as string, key: c.key as string, canonicalText: c.canonicalText as string, value: c.value }))
  );
}
