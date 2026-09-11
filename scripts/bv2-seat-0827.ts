/**
 * Operator decision 2026-08-26 (v2): tomorrow's 15 T1 sends upgrade to the
 * "named rival + open seat" Arm B — every rival number below is read off
 * the prospect's own published audit snapshot (comparison rows), stated
 * only in the form the page can verify (exact counts where rate×sample is
 * integer, else the snapshot's percentage). Transform: replace the B CTA
 * paragraph with rival sentence + seat/CTA paragraph; fold in the
 * A→An Annapolis subject fix; supersede on approve (QA gate); keep slot.
 * Dry-run by default; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const PURPOSE =
  "Arm B v2 (operator decision 2026-08-26): named-rival + open-seat framing; rival numbers from the audit snapshot comparison; slot unchanged.";

/** Per-prospect rival sentence — numbers from the snapshot comparison rows
 * pulled 2026-08-26 (see session log). null = lead-defense case. */
const RIVAL: Record<string, { market: string; sentence: string | null }> = {
  "Jen Holden Group": { market: "Annapolis", sentence: "Brad Kappel Team was mentioned in 34 of the same 512 answers." },
  "Housecats Company": { market: "Annapolis", sentence: "Brad Kappel Team was mentioned in 34 of the same 512 answers." },
  "Chesapeake Home Team": { market: "Annapolis", sentence: "Brad Kappel Team was mentioned in 34 of the same 512 answers." },
  "Steffany Farmer": { market: "Savannah", sentence: "Heather Murphy Real Estate Group was mentioned in 81 of the same 512 answers." },
  "David Rotundo": { market: "Savannah", sentence: "Heather Murphy Real Estate Group was mentioned in 81 of the same 512 answers." },
  "Sharon Darley": { market: "Savannah", sentence: "Heather Murphy Real Estate Group was mentioned in 81 of the same 512 answers." },
  "Team Callahan": { market: "Savannah", sentence: "Sabriya Scott was mentioned in 62 of the same 512 answers." },
  "Heather Murphy Group": { market: "Savannah", sentence: "Sabriya Scott was mentioned in 62 of the same 512 answers." },
  "The Oldfather Group": { market: "Wilmington", sentence: "Katina Geralis came up in 6.8% of the same 354 answers." },
  "The Mottola Group": { market: "Wilmington", sentence: "Katina Geralis came up in 6.8% of the same 354 answers." },
  "Robert Blackhurst": { market: "Wilmington", sentence: "Katina Geralis came up in 6.8% of the same 354 answers." },
  "Team Spartina": { market: "Charleston", sentence: "Chucktown Homes was mentioned in 59 of the same 512 answers." },
  "Chucktown Homes": { market: "Charleston", sentence: null },
  "The Ngai Group": { market: "Jersey City", sentence: "The Jill Biggs Group was mentioned in 27 of the same 64 answers." },
  "Team Moza": { market: "Jersey City", sentence: "The Jill Biggs Group was mentioned in 61 of the same 128 answers." },
};

const CTA_PARA =
  /I put every question and complete answer on one page, so you can search for your own name and check the counting yourself\. No link — reply "send it" and I'll send the page over\./;

const seatPara = (market: string, leadDefense: boolean): string =>
  `${
    leadDefense
      ? `I work with one team per market on being the name these answers give — in ${market} that seat is open, and your count is the argument for it being you.`
      : `I work with one team per market on being the name these answers give — the ${market} seat is open.`
  } Every question and complete answer is counted on one page you can check yourself. No link — reply "send it" and I'll send it over either way.`;

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };

  const rows = await sql`
    select d.id, d.prospect_id, d.channel, d.subject, d.body, d.contact_id, d.scheduled_send_at, p.business_name
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null
      and (d.scheduled_send_at at time zone 'America/New_York')::date = '2026-08-27'
    order by d.scheduled_send_at`;
  console.log(`${rows.length} drafts for 2026-08-27${APPLY ? "" : " (dry-run)"}`);
  let ok = 0;
  for (const r of rows) {
    const biz = r.businessName as string;
    const conf = RIVAL[biz];
    const tag = `${biz} @ ${new Date(r.scheduledSendAt as Date).toISOString()}`;
    if (!conf) { console.error(`SKIP no rival config: ${tag}`); continue; }
    const body = r.body as string;
    if (!CTA_PARA.test(body)) { console.error(`SKIP CTA paragraph not found (manual review): ${tag}\n${body}\n`); continue; }
    const replacement = conf.sentence
      ? `${conf.sentence}\n\n${seatPara(conf.market, false)}`
      : seatPara(conf.market, true);
    const next = body.replace(CTA_PARA, replacement);
    const subject = (r.subject as string).replace(/^A Annapolis/, "An Annapolis");
    if (!APPLY) { console.log(`\n=== ${tag}\nSUBJ: ${subject}\n${next}`); ok++; continue; }
    const created = await createOutreachDraft(user, {
      prospectId: r.prospectId, channel: r.channel, contactId: r.contactId ?? undefined,
      subject, body: next, cta: 'reply "send it"',
    });
    if (!created.ok) { console.error(`FAIL create: ${tag} — ${created.error.message}`); continue; }
    const approved = await approveOutreachDraft(user, { draftId: created.data.draftId });
    if (!approved.ok) { console.error(`FAIL approve (QA): ${tag} — ${approved.error.message}`); continue; }
    const sched = await scheduleDraftSend(user, { draftId: created.data.draftId, sendAt: r.scheduledSendAt, businessPurpose: PURPOSE });
    if (!sched.ok) { console.error(`FAIL schedule: ${tag} — ${sched.error.message}`); continue; }
    console.log(`upgraded + approved + scheduled: ${tag}`);
    ok++;
  }
  console.log(`\n${ok}/${rows.length} ${APPLY ? "upgraded" : "ready"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
