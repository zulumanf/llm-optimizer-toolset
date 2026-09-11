/**
 * JC batch 2 outreach (2026-08-21). Runs AFTER scripts/jc-batch2-findings.ts
 * --apply. Reads scripts/jc-batch2-contacts.json (publicly sourced emails,
 * each with its source page in notes) and, per prospect:
 *   --contacts  add the primary contact (skipped if the prospect already has
 *               a contact with an email)
 *   --drafts    generate the system reply-first draft (v2 primary finding +
 *               live audit link + sender footer) bound to that contact
 *   --approve   approve the latest unapproved draft
 *   --schedule <ISO>  schedule approved, unsent drafts starting at <ISO>,
 *               staggered STAGGER_MIN apart (worker drain runs every 10 min)
 * Dry-run by default; --apply to write. Team Moza is excluded (emailed by hand).
 *
 *   npx tsx scripts/jc-batch2-outreach.ts --contacts --drafts --apply
 *   npx tsx scripts/jc-batch2-outreach.ts --approve --schedule 2026-08-24T12:15:00Z --apply
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import {
  addContact,
  approveOutreachDraft,
  createOutreachDraft,
  scheduleDraftSend,
} from "@/lib/prospects/service";
import { FINDING_GENERATOR_VERSION } from "@/lib/prospects/constants";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const DO_CONTACTS = argv.includes("--contacts");
const DO_DRAFTS = argv.includes("--drafts");
const DO_APPROVE = argv.includes("--approve");
const SCHEDULE_AT = argv.includes("--schedule") ? argv[argv.indexOf("--schedule") + 1] : null;
const STAGGER_MIN = 10;
const EXCLUDE = new Set(["Team Moza"]);
const BUSINESS_PURPOSE =
  "JC batch 2 first-touch outreach: published AI-visibility benchmark audit, reply-first ask; contact publicly sourced (source page on contact record).";

interface ContactRow {
  business: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  provenance: "publicly_sourced";
  notes: string;
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const contacts = JSON.parse(readFileSync("scripts/jc-batch2-contacts.json", "utf8")) as ContactRow[];

  const rows = await sql`
    select p.id, p.business_name,
      (select f.generator_version from prospect_findings f where f.prospect_id = p.id and f.is_primary and f.status = 'approved') as primary_version,
      (select c.id from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null and c.email is not null order by c.is_primary desc, c.created_at limit 1) as contact_id,
      (select d.id from outreach_drafts d where d.prospect_id = p.id and d.status = 'draft' order by d.version desc limit 1) as pending_draft_id,
      (select d.id from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is null order by d.version desc limit 1) as approved_unscheduled_id,
      exists(select 1 from prospect_audits a where a.prospect_id = p.id and a.status = 'published') as published
    from prospects p join market_launches l on l.id = p.launch_id
    where l.name ilike '%jersey%' and p.archived_at is null
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id)
    order by p.business_name`;

  let slot = 0;
  for (const r of rows) {
    const name = r.businessName as string;
    if (EXCLUDE.has(name)) continue;
    const tag = `${name} (${(r.id as string).slice(0, 8)})`;
    const src = contacts.find((c) => c.business === name);

    let contactId = (r.contactId as string | null) ?? null;
    if (DO_CONTACTS && !contactId) {
      if (!src) { console.log(`no contact sourced: ${tag}`); continue; }
      if (!APPLY) { console.log(`would add contact: ${tag} → ${src.email}`); }
      else {
        const res = await addContact(user, {
          prospectId: r.id, name: src.name, role: src.role, email: src.email, phone: src.phone,
          preferredChannel: "email", isPrimary: true, provenance: src.provenance, notes: src.notes,
        });
        if (!res.ok) { console.error(`FAILED contact: ${tag} — ${res.error.message}`); continue; }
        contactId = res.data.contactId;
        console.log(`contact added: ${tag} → ${src.email}`);
      }
    }

    if (DO_DRAFTS && !r.pendingDraftId && !r.approvedUnscheduledId) {
      if (r.primaryVersion !== FINDING_GENERATOR_VERSION) { console.log(`skip draft (primary not v2): ${tag}`); continue; }
      if (!r.published) { console.log(`skip draft (no live audit): ${tag}`); continue; }
      if (!contactId) { console.log(`skip draft (no contact): ${tag}`); continue; }
      if (!APPLY) console.log(`would create draft: ${tag}`);
      else {
        const res = await createOutreachDraft(user, { prospectId: r.id, channel: "email", contactId });
        if (!res.ok) { console.error(`FAILED draft: ${tag} — ${res.error.message}`); continue; }
        console.log(`draft v${res.data.version} created: ${tag} (${res.data.draftId})`);
        r.pendingDraftId = res.data.draftId;
      }
    }

    let approvedId = (r.approvedUnscheduledId as string | null) ?? null;
    if (DO_APPROVE && r.pendingDraftId) {
      if (!APPLY) console.log(`would approve draft: ${tag}`);
      else {
        const res = await approveOutreachDraft(user, { draftId: r.pendingDraftId });
        if (!res.ok) { console.error(`FAILED approve: ${tag} — ${res.error.message}`); continue; }
        approvedId = res.data.draftId;
        console.log(`draft approved: ${tag}`);
      }
    }

    if (SCHEDULE_AT && approvedId) {
      const at = new Date(new Date(SCHEDULE_AT).getTime() + slot * STAGGER_MIN * 60_000);
      slot += 1;
      if (!APPLY) console.log(`would schedule: ${tag} at ${at.toISOString()}`);
      else {
        const res = await scheduleDraftSend(user, { draftId: approvedId, sendAt: at, businessPurpose: BUSINESS_PURPOSE });
        if (!res.ok) { console.error(`FAILED schedule: ${tag} — ${res.error.message}`); continue; }
        console.log(`scheduled: ${tag} at ${res.data.sendAt}`);
      }
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
