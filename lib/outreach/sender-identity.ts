/**
 * Outbound sender identity (spec 052). CAN-SPAM requires a truthful sender
 * and a physical postal address in commercial email; the platform had
 * neither as data — the footer carried only a user name. One active row;
 * changing it appends a new row and deactivates the old (history is audit
 * evidence). Cold outreach REFUSES until an admin configures this: the
 * missing operator decision blocks sends instead of producing
 * non-compliant ones.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";

export interface SenderIdentity {
  id: string;
  senderName: string;
  companyName: string;
  postalAddress: string;
  replyToEmail: string;
}

/** Shown whenever the postal-address gate refuses. */
export const INCOMPLETE_POSTAL_ADDRESS_MESSAGE =
  "The sender postal address is incomplete: enter the full street address or PO Box (for example \"123 Main St, Jersey City, NJ 07302\"). City and state alone are not a physical postal address.";

/**
 * Conservative structural check (spec 150), NOT legal validation: at least
 * two comma/line-separated parts, and the first part carries a number (the
 * street number or PO Box). Rejects "Brooklyn, NY", "NY", "" and
 * "Brooklyn, NY 11201" (no street or box). Never guesses or fills one in.
 */
export function isCompletePostalAddress(address: string | null | undefined): boolean {
  const parts = (address ?? "")
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return false;
  return /\d/.test(parts[0]!);
}

export async function getActiveSenderIdentity(): Promise<SenderIdentity | null> {
  const [row] = await sql`
    select id, sender_name, company_name, postal_address, reply_to_email
    from outreach_sender_identity where active
  `;
  if (!row) return null;
  return {
    id: row.id as string,
    senderName: row.senderName as string,
    companyName: row.companyName as string,
    postalAddress: row.postalAddress as string,
    replyToEmail: row.replyToEmail as string,
  };
}

const identitySchema = z.object({
  senderName: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(2).max(120),
  postalAddress: z
    .string()
    .trim()
    .min(10, "A real physical postal address is required (CAN-SPAM §7704(a)(5)).")
    .max(300)
    .refine(isCompletePostalAddress, INCOMPLETE_POSTAL_ADDRESS_MESSAGE),
  replyToEmail: z.string().trim().toLowerCase().email(),
});

/** Admin-only: the legal sender of the company's outbound email. */
export async function setSenderIdentity(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ identityId: string }>> {
  const parsed = identitySchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    const identityId = await sql.begin(async (tx) => {
      await tx`update outreach_sender_identity set active = false where active`;
      const [row] = await tx`
        insert into outreach_sender_identity
          (sender_name, company_name, postal_address, reply_to_email, created_by)
        values (${input.senderName}, ${input.companyName}, ${input.postalAddress},
          ${input.replyToEmail}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "outreach.sender_identity_set",
        entity: "outreach_sender_identity",
        entityId: row?.id as string,
        detail: { senderName: input.senderName, companyName: input.companyName },
      });
      return row?.id as string;
    });
    return ok({ identityId });
  } catch (err) {
    return fail(err);
  }
}
