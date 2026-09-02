/**
 * Operator decision 2026-08-31: footer postal line becomes just "Brooklyn, NY"
 * (no street address) in ALL outbound email.
 * 1. Appends a new active sender identity row (history preserved).
 * 2. Supersedes every pending scheduled draft with the same body minus the
 *    street address, re-approving (QA validates against the new identity)
 *    and rescheduling at the original slot.
 * Dry-run by default; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { getActiveSenderIdentity, setSenderIdentity } from "@/lib/outreach/sender-identity";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const OLD_LINE = "1399 Myrtle Ave, Brooklyn, NY 11237";
const NEW_LINE = "Brooklyn, NY";
const PURPOSE =
  "Operator decision 2026-08-31: footer shows city/state only (Brooklyn, NY); body superseded with identical content minus street address, original slot kept.";

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = {
    id: u.id as string, email: u.email as string,
    name: u.name as string, role: u.role as CurrentUser["role"],
  };

  const identity = await getActiveSenderIdentity();
  if (!identity) throw new Error("no active sender identity");
  console.log(`identity: "${identity.postalAddress}" → "${NEW_LINE}"${APPLY ? "" : " (dry-run)"}`);
  if (APPLY && identity.postalAddress !== NEW_LINE) {
    const set = await setSenderIdentity(user, {
      senderName: identity.senderName,
      companyName: identity.companyName,
      postalAddress: NEW_LINE,
      replyToEmail: identity.replyToEmail,
    });
    if (!set.ok) throw new Error(`identity update failed: ${set.error.message}`);
    console.log(`new identity row ${set.data.identityId}`);
  }

  const rows = await sql`
    select d.id, d.prospect_id, d.channel, d.contact_id, d.subject, d.body, d.tone, d.cta,
      d.scheduled_send_at, p.business_name
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null
      and d.scheduled_send_at is not null and d.body like ${"%" + OLD_LINE + "%"}
    order by d.scheduled_send_at`;
  console.log(`${rows.length} pending drafts carry the street address`);

  let ok = 0;
  for (const r of rows) {
    const body = (r.body as string).replace(OLD_LINE, NEW_LINE);
    const tag = `${r.businessName} (${new Date(r.scheduledSendAt as Date).toISOString()})`;
    if (!APPLY) { console.log(`would supersede: ${tag}`); ok++; continue; }
    const created = await createOutreachDraft(user, {
      prospectId: r.prospectId, channel: r.channel, contactId: r.contactId ?? undefined,
      subject: r.subject, body, tone: r.tone ?? undefined, cta: r.cta ?? undefined,
    });
    if (!created.ok) { console.error(`FAIL create: ${tag} — ${created.error.message}`); continue; }
    const approved = await approveOutreachDraft(user, { draftId: created.data.draftId });
    if (!approved.ok) { console.error(`FAIL approve (QA): ${tag} — ${approved.error.message}`); continue; }
    const sched = await scheduleDraftSend(user, {
      draftId: created.data.draftId, sendAt: r.scheduledSendAt, businessPurpose: PURPOSE,
    });
    if (!sched.ok) { console.error(`FAIL schedule: ${tag} — ${sched.error.message}`); continue; }
    console.log(`superseded + rescheduled: ${tag} → draft ${created.data.draftId.slice(0, 8)}`);
    ok++;
  }
  console.log(`\n${ok}/${rows.length} ${APPLY ? "done" : "ready"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
