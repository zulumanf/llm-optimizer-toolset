/**
 * Friday 2026-08-28 batch → Arm B v2 (named rival + open seat), same
 * decision and receipts discipline as bv2-seat-0827.ts. Princeton T1s get
 * the CTA-paragraph transform (rivals from their snapshots; Maura Mills
 * leads the market → lead-defense); Wilmington T2s swap the generic
 * "other Wilmington names" sentence for the named rival and add the seat
 * line, keeping the paste-three-answers reply CTA. Supersede on approve
 * (QA gate); slots unchanged. Dry-run; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const PURPOSE =
  "Arm B v2 (operator decision 2026-08-26): named-rival + open-seat framing for Friday's batch; rival numbers from audit snapshots; slot unchanged.";

const T1_RIVAL: Record<string, { market: string; sentence: string | null }> = {
  "NJ Luxury RE Group": { market: "Princeton", sentence: "Maura Mills was mentioned in 65 of the same 512 answers." },
  "Richard Abrams": { market: "Princeton", sentence: "Maura Mills was mentioned in 65 of the same 512 answers." },
  "Wolfpack Homes Team": { market: "Princeton", sentence: "Maura Mills was mentioned in 65 of the same 512 answers." },
  "Maura Mills": { market: "Princeton", sentence: null },
};
const T2_RIVAL_SENTENCE = "Katina Geralis came up in 6.8% of the same 354 answers.";
const T2_GENERIC = "The same answers do recommend other Wilmington names in response to those questions.";
const T2_SEAT = "I work with one team per market on being the name these answers give — the Wilmington seat is open.";
const T2_CTA = 'Reply "show me" and';

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
      and (d.scheduled_send_at at time zone 'America/New_York')::date = '2026-08-28'
    order by d.scheduled_send_at`;
  console.log(`${rows.length} drafts for 2026-08-28${APPLY ? "" : " (dry-run)"}`);
  let ok = 0;
  for (const r of rows) {
    const biz = r.businessName as string;
    const body = r.body as string;
    const tag = `${biz} [${r.channel}] @ ${new Date(r.scheduledSendAt as Date).toISOString()}`;
    let next: string | null = null;
    if (r.channel === "followup_email") {
      if (!body.includes(T2_GENERIC) || !body.includes(T2_CTA)) { console.error(`SKIP T2 markers not found: ${tag}\n${body}\n`); continue; }
      next = body.replace(T2_GENERIC, T2_RIVAL_SENTENCE).replace(T2_CTA, `${T2_SEAT}\n\n${T2_CTA}`);
    } else {
      const conf = T1_RIVAL[biz];
      if (!conf) { console.error(`SKIP no rival config: ${tag}`); continue; }
      if (!CTA_PARA.test(body)) { console.error(`SKIP CTA paragraph not found: ${tag}\n${body}\n`); continue; }
      next = body.replace(CTA_PARA, conf.sentence ? `${conf.sentence}\n\n${seatPara(conf.market, false)}` : seatPara(conf.market, true));
    }
    if (!APPLY) { console.log(`\n=== ${tag}\nSUBJ: ${r.subject}\n${next}`); ok++; continue; }
    const created = await createOutreachDraft(user, {
      prospectId: r.prospectId, channel: r.channel, contactId: r.contactId ?? undefined,
      subject: r.subject, body: next, cta: r.channel === "followup_email" ? 'reply "show me"' : 'reply "send it"',
    });
    if (!created.ok) { console.error(`FAIL create: ${tag} — ${created.error.message}`); continue; }
    const approved = await approveOutreachDraft(user, { draftId: created.data.draftId });
    if (!approved.ok) { console.error(`FAIL approve (QA): ${tag} — ${approved.error.message}`); continue; }
    const sched = await scheduleDraftSend(user, { draftId: created.data.draftId, sendAt: r.scheduledSendAt, businessPurpose: PURPOSE });
    if (!sched.ok) { console.error(`FAIL schedule: ${tag} — ${sched.error.message}`); continue; }
    console.log(`upgraded: ${tag}`);
    ok++;
  }
  console.log(`\n${ok}/${rows.length} ${APPLY ? "upgraded" : "ready"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
