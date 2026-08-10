/**
 * Prospect PII erasure (spec 052, audit F26/F27). Cold outreach contacts
 * real people who never opted in; the first "delete my data" reply must
 * have a code path. The reconciliation with the never-delete principle
 * (PRINCIPLES.md #3, recorded in DECISIONS.md): measurement data —
 * responses, mentions, scores — is immutable and contains no contact PII;
 * contact PII is deletable on request. What must survive an erasure is the
 * promise never to contact the person again, and that lives in the
 * suppression list as a normalized match key — the tombstone.
 *
 * Admin-only, reason required, audited. Tombstone and erasure commit in
 * ONE transaction: the person is never erased without the suppression
 * entry that keeps the never-again promise.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { suppress } from "@/lib/outreach/suppression";

const eraseSchema = z.object({
  contactId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(5, "Record why (e.g. 'erasure request by email 2026-08-09')."),
});

export async function eraseProspectContactPii(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ contactId: string; suppressed: boolean }>> {
  const parsed = eraseSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    const [contact] = await sql`
      select id, prospect_id, email, pii_erased_at from prospect_contacts
      where id = ${input.contactId}
    `;
    if (!contact) return fail(new ClassifiedError("not_found", "Contact not found."));
    if (contact.piiErasedAt) {
      return fail(new ClassifiedError("conflict", "This contact is already erased."));
    }

    let suppressed = false;
    await sql.begin(async (tx) => {
      // Tombstone in the same transaction as the erasure: never one
      // without the other.
      if (contact.email) {
        await suppress(tx, {
          scope: "email",
          value: contact.email as string,
          reason: "legal_request",
          detail: `erasure_request: ${input.reason}`,
          projectId: null,
          userId: user.id,
        });
        suppressed = true;
      }
      await tx`
        update prospect_contacts
        set name = '[erased]', email = null, phone = null, linkedin = null,
          notes = null, pii_erased_at = now(), archived_at = coalesce(archived_at, now())
        where id = ${input.contactId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.contact_pii_erased",
        entity: "prospect_contact",
        entityId: input.contactId,
        detail: { reason: input.reason, suppressed },
      });
    });
    return ok({ contactId: input.contactId, suppressed });
  } catch (err) {
    return fail(err);
  }
}

/** Same contract for the prospect row's own contact fields. The business
 * name stays — a team's name is commercial identity, not personal data. */
export async function eraseProspectAccountPii(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ prospectId: string; suppressed: boolean }>> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      reason: z.string().trim().min(5),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    const [prospect] = await sql`
      select id, email from prospects where id = ${input.prospectId}
    `;
    if (!prospect) return fail(new ClassifiedError("not_found", "Prospect not found."));

    let suppressed = false;
    await sql.begin(async (tx) => {
      if (prospect.email) {
        await suppress(tx, {
          scope: "email",
          value: prospect.email as string,
          reason: "legal_request",
          detail: `erasure_request: ${input.reason}`,
          projectId: null,
          userId: user.id,
        });
        suppressed = true;
      }
      await tx`
        update prospects set email = null, phone = null, socials = '{}'::jsonb,
          updated_at = now()
        where id = ${input.prospectId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.account_pii_erased",
        entity: "prospect",
        entityId: input.prospectId,
        detail: { reason: input.reason, suppressed },
      });
    });
    return ok({ prospectId: input.prospectId, suppressed });
  } catch (err) {
    return fail(err);
  }
}

export interface StalePiiRow {
  contactId: string;
  prospectId: string;
  prospectName: string;
  contactName: string;
  createdAt: Date;
  lastActivityAt: Date | null;
}

/**
 * Contacts whose prospect has had no activity beyond the window — the
 * retention question made visible before a retention policy exists.
 */
export async function stalePiiReport(windowDays = 365): Promise<StalePiiRow[]> {
  const rows = await sql`
    select c.id as contact_id, c.prospect_id, p.business_name, c.name,
      c.created_at,
      (select max(a.occurred_at) from prospect_activities a
        where a.prospect_id = c.prospect_id) as last_activity_at
    from prospect_contacts c
    join prospects p on p.id = c.prospect_id
    where c.pii_erased_at is null
      and c.created_at < now() - make_interval(days => ${windowDays})
      and coalesce(
        (select max(a.occurred_at) from prospect_activities a
          where a.prospect_id = c.prospect_id),
        c.created_at
      ) < now() - make_interval(days => ${windowDays})
    order by c.created_at asc
  `;
  return rows.map((r) => ({
    contactId: r.contactId as string,
    prospectId: r.prospectId as string,
    prospectName: r.businessName as string,
    contactName: r.name as string,
    createdAt: r.createdAt as Date,
    lastActivityAt: (r.lastActivityAt as Date | null) ?? null,
  }));
}
