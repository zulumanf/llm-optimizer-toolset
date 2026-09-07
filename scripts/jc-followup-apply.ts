/**
 * JC batch-1 follow-ups (prepared 2026-08-24 for the 2026-08-25 AM batch).
 * Reads scripts/jc-followup-drafts.json (hand-written per-prospect bodies —
 * every number matches the prospect's live published audit snapshot).
 *
 *   --create    create followup_email drafts bound to the primary contact
 *   --approve   approve the latest pending followup draft
 *   --schedule <ISO-UTC>  schedule approved, unsent followup drafts starting
 *               at <ISO>, staggered STAGGER_MIN apart
 * Dry-run by default; --apply to write.
 *
 * Prep:     npx tsx scripts/jc-followup-apply.ts --create --approve --apply
 * Morning:  npx tsx scripts/jc-followup-apply.ts --schedule 2026-08-25T15:10:00Z --apply
 *           (11:10 ET — the 3-business-day cadence makes all 12 due at ~11:05 ET)
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
/** Held from SCHEDULING (drafts stay approved): 30d brokerage cap (spec 052).
 *  Corcoran Sawyer Smith is 3/3 (Leda Duif, Megan Gulick, Foster Tucker);
 *  Compass 2/3 — last slot goes to Arrived Team (higher quality score than
 *  Sutherlin); Redfin 2/3 — last slot to Natasha Bartolomeo (34 > Kate 32).
 *  All five become eligible when the 8/20 sends age out (~2026-09-19). */
const HOLD_FROM_SCHEDULE = new Set(["Kate Liu", "Leda Duif", "Megan Gulick", "The Foster Tucker Team", "The Sutherlin Group"]);
const BUSINESS_PURPOSE =
  "JC batch 1 follow-up (touch 2): 3-business-day cadence after 2026-08-20 first touch; cites refreshed benchmark counts shown on the prospect's live published audit.";

interface FollowupRow { prospectIdPrefix: string; business: string; subject: string; body: string }

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const drafts = JSON.parse(readFileSync("scripts/jc-followup-drafts.json", "utf8")) as FollowupRow[];

  let slot = 0;
  for (const d of drafts) {
    const [p] = await sql`
      select p.id, p.business_name, p.stage,
        (select c.id from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null and c.email is not null
          order by c.is_primary desc, c.created_at limit 1) as contact_id,
        (select d2.id from outreach_drafts d2 where d2.prospect_id = p.id and d2.channel = 'followup_email'
          and d2.status = 'draft' and d2.sent_recorded_at is null order by d2.version desc limit 1) as pending_id,
        (select d2.id from outreach_drafts d2 where d2.prospect_id = p.id and d2.channel = 'followup_email'
          and d2.status = 'approved' and d2.sent_recorded_at is null and d2.scheduled_send_at is null
          order by d2.version desc limit 1) as approved_unscheduled_id,
        (select count(*)::int from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as sends
      from prospects p where p.id::text like ${d.prospectIdPrefix + "%"}`;
    if (!p) { console.error(`NOT FOUND: ${d.business}`); continue; }
    const tag = `${p.businessName} (${(p.id as string).slice(0, 8)})`;
    if (p.businessName !== d.business) { console.error(`NAME MISMATCH: ${tag} vs ${d.business} — skipping`); continue; }
    if (p.stage !== "identified" && p.stage !== "contacted") { console.log(`skip (stage ${p.stage} — conversation moved): ${tag}`); continue; }
    if (Number(p.sends) !== 1) { console.log(`skip (expected exactly 1 prior send, found ${p.sends}): ${tag}`); continue; }
    if (!p.contactId) { console.log(`skip (no contact): ${tag}`); continue; }

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

    if (SCHEDULE_AT && approvedId && HOLD_FROM_SCHEDULE.has(p.businessName as string)) {
      console.log(`hold (brokerage cap — see HOLD_FROM_SCHEDULE): ${tag}`);
    } else if (SCHEDULE_AT && approvedId) {
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
