/**
 * Operator decision 2026-08-31: no em-dashes in outbound email (subjects or
 * bodies). Template code fixed separately (template versions bumped to v2).
 * This script fixes the data: supersedes the 51 pending scheduled drafts
 * (greeting "Name —" → "Name,", sig divider "—" → "--", subject " — " →
 * " - ", one known prose dash in the Debbie Reed founder note) and
 * rescheduules each at its original slot. Refuses any body whose em-dashes
 * fall outside those known shapes. Dry-run by default; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const PURPOSE =
  "Operator decision 2026-08-31: remove em-dashes from outbound copy; body superseded with equivalent content, original slot kept.";

function transform(body: string): string {
  return body
    .replace(/^([^\n]{1,60}) —\n/, "$1,\n")
    .replace("\n\n—\n", "\n\n--\n")
    .replace(" by name — a couple", " by name. A couple");
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = {
    id: u.id as string, email: u.email as string,
    name: u.name as string, role: u.role as CurrentUser["role"],
  };

  const rows = await sql`
    select d.id, d.prospect_id, d.channel, d.contact_id, d.subject, d.body, d.tone, d.cta,
      d.scheduled_send_at, p.business_name
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null
      and d.scheduled_send_at is not null
      and (d.body like '%—%' or d.subject like '%—%')
    order by d.scheduled_send_at`;
  console.log(`${rows.length} pending drafts carry em-dashes${APPLY ? "" : " (dry-run)"}`);

  let ok = 0;
  for (const r of rows) {
    const body = transform(r.body as string);
    const subject = ((r.subject as string | null) ?? "").replace(" — ", " - ");
    const tag = `${r.businessName} (${new Date(r.scheduledSendAt as Date).toISOString()})`;
    if (body.includes("—") || subject.includes("—")) {
      console.error(`SKIP unexpected em-dash shape: ${tag}`);
      continue;
    }
    if (!APPLY) { console.log(`would supersede: ${tag} | subj: ${subject}`); ok++; continue; }
    const created = await createOutreachDraft(user, {
      prospectId: r.prospectId, channel: r.channel, contactId: r.contactId ?? undefined,
      subject, body, tone: r.tone ?? undefined, cta: r.cta ?? undefined,
    });
    if (!created.ok) { console.error(`FAIL create: ${tag} — ${created.error.message}`); continue; }
    const approved = await approveOutreachDraft(user, { draftId: created.data.draftId });
    if (!approved.ok) { console.error(`FAIL approve (QA): ${tag} — ${approved.error.message}`); continue; }
    const sched = await scheduleDraftSend(user, {
      draftId: created.data.draftId, sendAt: r.scheduledSendAt, businessPurpose: PURPOSE,
    });
    if (!sched.ok) { console.error(`FAIL schedule: ${tag} — ${sched.error.message}`); continue; }
    console.log(`superseded + rescheduled: ${tag} → ${created.data.draftId.slice(0, 8)}`);
    ok++;
  }
  console.log(`\n${ok}/${rows.length} ${APPLY ? "done" : "ready"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
