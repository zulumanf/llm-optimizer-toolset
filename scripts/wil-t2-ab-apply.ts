/**
 * Wilmington touch-2 A/B test (prepared 2026-08-25 for the 2026-08-28 batch).
 * Arm A: link CTA (naked branded URL + "nothing to log into" line).
 * Arm B: no link — reply-CTA, finding stated in the body.
 * Reads scripts/wil-t2-ab-drafts.json; every count matches the prospect's
 * QA-gated touch-1 body. Design + holds: scripts/RUNBOOK-ab-0828.md.
 *
 *   --create    create followup_email drafts bound to the primary contact
 *   --approve   approve the latest pending followup draft (runs the QA gate)
 *   --schedule <ISO-UTC>  schedule approved, unsent drafts staggered
 * Dry-run by default; --apply to write.
 *
 * Prep:     npx tsx scripts/wil-t2-ab-apply.ts --create --approve --apply
 * Friday:   npx tsx scripts/wil-t2-ab-apply.ts --schedule 2026-08-28T15:10:00Z --apply
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const DO_CREATE = argv.includes("--create");
const DO_APPROVE = argv.includes("--approve");
const SCHEDULE_AT = argv.includes("--schedule") ? argv[argv.indexOf("--schedule") + 1] : null;
const STAGGER_MIN = 10;
const BUSINESS_PURPOSE =
  "Wilmington T2 reply-CTA A/B test (RUNBOOK-ab-0828): 3-business-day cadence after 2026-08-25 first touch; counts match the QA-gated touch-1 body.";

interface Row { arm: "A" | "B"; prospectIdPrefix: string; business: string; subject: string; body: string }

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const drafts = JSON.parse(readFileSync("scripts/wil-t2-ab-drafts.json", "utf8")) as Row[];

  let slot = 0;
  for (const d of drafts) {
    const [p] = await sql`
      select p.id, p.business_name, p.stage,
        (select c.id from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null
          and not c.do_not_contact and c.email is not null
          order by c.is_primary desc, c.created_at limit 1) as contact_id,
        (select d2.id from outreach_drafts d2 where d2.prospect_id = p.id and d2.channel = 'followup_email'
          and d2.status = 'draft' and d2.sent_recorded_at is null order by d2.version desc limit 1) as pending_id,
        (select d2.id from outreach_drafts d2 where d2.prospect_id = p.id and d2.channel = 'followup_email'
          and d2.status = 'approved' and d2.sent_recorded_at is null and d2.scheduled_send_at is null
          order by d2.version desc limit 1) as approved_unscheduled_id,
        (select count(*)::int from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as sends
      from prospects p where p.id::text like ${d.prospectIdPrefix + "%"}`;
    if (!p) { console.error(`NOT FOUND: ${d.business}`); continue; }
    const tag = `[arm ${d.arm}] ${p.businessName} (${(p.id as string).slice(0, 8)})`;
    if (p.businessName !== d.business) { console.error(`NAME MISMATCH: ${tag} vs ${d.business} — skipping`); continue; }
    if (p.stage !== "identified" && p.stage !== "contacted") { console.log(`skip (stage ${p.stage} — conversation moved): ${tag}`); continue; }
    if (Number(p.sends) !== 1) { console.log(`skip (expected exactly 1 prior send, found ${p.sends}): ${tag}`); continue; }
    if (!p.contactId) { console.log(`skip (no contactable contact): ${tag}`); continue; }

    let pendingId = (p.pendingId as string | null) ?? null;
    if (DO_CREATE && !pendingId && !p.approvedUnscheduledId) {
      if (!APPLY) console.log(`would create followup draft: ${tag}`);
      else {
        const res = await createOutreachDraft(user, {
          prospectId: p.id, channel: "followup_email", contactId: p.contactId,
          subject: d.subject, body: d.body,
        });
        if (!res.ok) { console.error(`FAILED create: ${tag} — ${res.error.message}`); continue; }
        pendingId = res.data.draftId;
        console.log(`followup draft v${res.data.version} created: ${tag}`);
      }
    }

    let approvedId = (p.approvedUnscheduledId as string | null) ?? null;
    if (DO_APPROVE && pendingId) {
      if (!APPLY) console.log(`would approve: ${tag}`);
      else {
        const res = await approveOutreachDraft(user, { draftId: pendingId });
        if (!res.ok) { console.error(`FAILED approve: ${tag} — ${res.error.message}`); continue; }
        approvedId = res.data.draftId;
        console.log(`approved: ${tag}`);
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
