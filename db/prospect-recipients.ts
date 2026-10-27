import { sql } from "@/db/client";

/**
 * True when `email` belongs to a non-archived prospect or prospect contact.
 * Spec 162: such recipients may only be emailed through `sendProspectDraft`.
 */
export async function isProspectRecipient(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return false;
  const [row] = await sql<{ hit: boolean }[]>`
    select exists (
      select 1 from prospect_contacts
      where archived_at is null and lower(trim(email)) = ${normalized}
    ) or exists (
      select 1 from prospects
      where archived_at is null and lower(trim(email)) = ${normalized}
    ) as hit
  `;
  return row?.hit === true;
}
