/**
 * Thursday 2026-08-27 T1 batch with the initial-email A/B test (link vs
 * offer-audit-by-reply). Reads scripts/thu-t1-plan.json rows:
 *   { arm, prospectIdPrefix, business,
 *     contact?: { name, email, sourceUrl },   // created if no contactable contact exists
 *     subject?, body?,                        // when present: create draft (+approve = QA gate)
 *     useExistingDraft?: true }               // schedule the already-approved draft as-is
 * Counts in bodies come from the audit snapshots (frozen page truth).
 *
 *   --create --approve      create contacts + drafts, approve (QA gate runs)
 *   --schedule <ISO-UTC>    schedule approved unsent 'email' drafts, staggered
 * Dry-run by default; --apply to write.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { addContact, approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const DO_CREATE = argv.includes("--create");
const DO_APPROVE = argv.includes("--approve");
const SCHEDULE_AT = argv.includes("--schedule") ? argv[argv.indexOf("--schedule") + 1] : null;
const STAGGER_MIN = 13;
const BUSINESS_PURPOSE =
  "T1 initial-email A/B test (RUNBOOK-ab-0828): link CTA vs audit offered by reply; counts match the published audit snapshot.";

interface Row {
  arm: "A" | "B";
  prospectIdPrefix: string;
  business: string;
  contact?: { name: string; email: string; sourceUrl: string };
  subject?: string;
  body?: string;
  useExistingDraft?: boolean;
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const rows = JSON.parse(readFileSync("scripts/thu-t1-plan.json", "utf8")) as Row[];

  let slot = 0;
  for (const r of rows) {
    const [p] = await sql`
      select p.id, p.business_name, p.stage,
        (select c.id from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null
          and not c.do_not_contact and c.email is not null
          order by c.is_primary desc, c.created_at limit 1) as contact_id,
        (select d2.id from outreach_drafts d2 where d2.prospect_id = p.id and d2.channel = 'email'
          and d2.status = 'draft' and d2.sent_recorded_at is null order by d2.version desc limit 1) as pending_id,
        (select d2.id from outreach_drafts d2 where d2.prospect_id = p.id and d2.channel = 'email'
          and d2.status = 'approved' and d2.sent_recorded_at is null and d2.scheduled_send_at is null
          order by d2.version desc limit 1) as approved_id,
        (select count(*)::int from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as sends
      from prospects p where p.id::text like ${r.prospectIdPrefix + "%"} and p.archived_at is null`;
    if (!p) { console.error(`NOT FOUND: ${r.business}`); continue; }
    const tag = `[arm ${r.arm}] ${p.businessName} (${(p.id as string).slice(0, 8)})`;
    if (p.businessName !== r.business) { console.error(`NAME MISMATCH: ${tag} vs ${r.business} — skipping`); continue; }
    if (Number(p.sends) !== 0) { console.log(`skip (already contacted, ${p.sends} sends): ${tag}`); continue; }

    let contactId = (p.contactId as string | null) ?? null;
    if (DO_CREATE && r.contact && !contactId) {
      if (!APPLY) console.log(`would add contact ${r.contact.email} (${r.contact.sourceUrl}): ${tag}`);
      else {
        const res = await addContact(user, {
          prospectId: p.id, name: r.contact.name, email: r.contact.email, isPrimary: true,
          provenance: "publicly_sourced", notes: `email seen at ${r.contact.sourceUrl} (2026-08-25 contact research)`,
        });
        if (!res.ok) { console.error(`FAILED contact: ${tag} — ${res.error.message}`); continue; }
        contactId = res.data.contactId;
        console.log(`contact added: ${tag}`);
      }
    }
    if (!contactId && !(r.contact && !APPLY)) { if (!r.contact) console.log(`skip (no contact): ${tag}`); }

    let pendingId = (p.pendingId as string | null) ?? null;
    if (DO_CREATE && r.body && !pendingId) {
      if (!APPLY) console.log(`would create draft: ${tag}`);
      else if (contactId) {
        const res = await createOutreachDraft(user, {
          prospectId: p.id, channel: "email", contactId, subject: r.subject, body: r.body,
        });
        if (!res.ok) { console.error(`FAILED create: ${tag} — ${res.error.message}`); continue; }
        pendingId = res.data.draftId;
        console.log(`draft v${res.data.version} created: ${tag}`);
      }
    }

    let approvedId = (p.approvedId as string | null) ?? null;
    if (DO_APPROVE && pendingId) {
      if (!APPLY) console.log(`would approve: ${tag}`);
      else {
        const res = await approveOutreachDraft(user, { draftId: pendingId });
        if (!res.ok) { console.error(`FAILED approve (QA gate?): ${tag} — ${res.error.message}`); continue; }
        approvedId = res.data.draftId;
        console.log(`approved: ${tag}`);
      }
    }
    if (r.useExistingDraft && !approvedId) console.log(`WARNING: no approved draft to schedule: ${tag}`);

    if (SCHEDULE_AT && (approvedId || (!APPLY && (r.body || r.useExistingDraft)))) {
      const at = new Date(new Date(SCHEDULE_AT).getTime() + slot * STAGGER_MIN * 60_000);
      slot += 1;
      if (!APPLY) console.log(`would schedule: ${tag} at ${at.toISOString()}`);
      else {
        const res = await scheduleDraftSend(user, { draftId: approvedId!, sendAt: at, businessPurpose: BUSINESS_PURPOSE });
        if (!res.ok) { console.error(`FAILED schedule: ${tag} — ${res.error.message}`); continue; }
        console.log(`scheduled: ${tag} at ${res.data.sendAt}`);
      }
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
