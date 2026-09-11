/** Add 3 cap-eligible JC prospects to Thu 8/27 as Arm B v2 (operator request 2026-08-26: fill toward 20/day). Numbers verified from snapshots: Jill 27/64 mentions (market leader), Mumoli rec 13/64, Sikora rec 9/64. Cap-safe slots 10:57/11:07/11:17 ET. */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";
const APPLY = process.argv.includes("--apply");
const SIG = `\n\n—\nFrancisco Zuluaga · Recommended First\n1399 Myrtle Ave, Brooklyn, NY 11237\nIf you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`;
const SEAT = `I work with one team per market on being the name these answers give — the Jersey City seat is open. Every question and complete answer is counted on one page you can check yourself. No link — reply "send it" and I'll send it over either way.`;
const SEAT_LEAD = `I work with one team per market on being the name these answers give — in Jersey City that seat is open, and your count is the argument for it being you. Every question and complete answer is counted on one page you can check yourself. No link — reply "send it" and I'll send it over either way.`;
const OPEN = `I was benchmarking several leading Jersey City teams across buyer and seller questions in openai (64 monitored responses).`;
const ROWS: { business: string; slot: string; find: string; rival: string | null; lead?: boolean }[] = [
  { business: "The Pinto Group", slot: "2026-08-27T15:07:00Z", find: "One result about The Pinto Group surprised me: The Pinto Group was recommended in 10 of the 64 monitored responses (15.6%).", rival: "The Jill Biggs Group was mentioned in 27 of the same 64 answers." },
];
async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = u as unknown as CurrentUser;
  for (const r of ROWS) {
    const [p] = await sql`select p.id, p.business_name,
      (select c.id from prospect_contacts c where c.prospect_id=p.id and c.archived_at is null and not c.do_not_contact and c.email is not null order by c.is_primary desc limit 1) cid,
      (select c.name from prospect_contacts c where c.prospect_id=p.id and c.archived_at is null and not c.do_not_contact and c.email is not null order by c.is_primary desc limit 1) cname
      from prospects p where p.business_name = ${r.business} and p.archived_at is null`;
    if (!p?.cid) { console.error(`SKIP no contact: ${r.business}`); continue; }
    const first = ((p.cname as string | null) ?? "").split(" ")[0] || "there";
    const body = `Hi ${first},\n\n${OPEN}\n\n${r.find}\n\n${r.rival ? `${r.rival}\n\n` : ""}${r.lead ? SEAT_LEAD : SEAT}${SIG}`;
    const subject = `A Jersey City benchmark result about ${r.business}`;
    if (!APPLY) { console.log(`=== ${r.business} @ ${r.slot}\nSUBJ: ${subject}\n${body}\n`); continue; }
    const c = await createOutreachDraft(user, { prospectId: p.id, channel: "email", contactId: p.cid, subject, body, cta: 'reply "send it"' });
    if (!c.ok) { console.error(`FAIL create ${r.business}: ${c.error.message}`); continue; }
    const a = await approveOutreachDraft(user, { draftId: c.data.draftId });
    if (!a.ok) { console.error(`FAIL approve ${r.business}: ${a.error.message}`); continue; }
    const s = await scheduleDraftSend(user, { draftId: c.data.draftId, sendAt: new Date(r.slot), businessPurpose: "Fill Thu 8/27 toward 20 sends; Arm B v2; cap-safe slot." });
    console.log(s.ok ? `scheduled: ${r.business} @ ${r.slot}` : `FAIL schedule ${r.business}: ${s.error.message}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
