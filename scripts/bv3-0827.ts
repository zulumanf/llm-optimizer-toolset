/** B-v3 template (operator copy 2026-08-27) for all unsent scheduled T1s.
 * Bodies rebuilt from each snapshot: self count, top-mention rival (exact
 * count or % per the near-integer rule), rival line omitted when the
 * prospect leads. Supersede on approve (QA gate); slots kept. */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";
const APPLY = process.argv.includes("--apply");
const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
const near = (x: number) => Math.abs(x - Math.round(x)) < 0.05;
const SIG = `\n\n—\nFrancisco Zuluaga · Recommended First\n1399 Myrtle Ave, Brooklyn, NY 11237\n\nIf you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`;
async function main() {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = u as unknown as CurrentUser;
  const rows = await sql`select d.id, d.prospect_id, d.channel, d.subject, d.contact_id, d.scheduled_send_at, p.business_name biz, l.name launch,
      a.snapshot->'keyFinding'->'metrics' m, a.snapshot->'comparison' comp,
      (select c.name from prospect_contacts c where c.id = d.contact_id) cname
    from outreach_drafts d join prospects p on p.id=d.prospect_id join market_launches l on l.id=p.launch_id
    join prospect_audits a on a.prospect_id=p.id and a.status='published'
    where d.status='approved' and d.sent_recorded_at is null and d.scheduled_send_at > now() and d.channel = 'email'`;
  console.log(`${rows.length} T1 drafts${APPLY ? "" : " (dry-run)"}`);
  let ok = 0;
  for (const r of rows) {
    const biz = r.biz as string;
    const market = (r.launch as string).split("—")[0]!.replace("luxury residential", "").trim() || (r.launch as string);
    const m = (r.m ?? {}) as Record<string, number | undefined>;
    const sample = m.sampleSize ?? 0;
    const selfRate = m.mentionRate ?? m.recommendationRate ?? 0;
    const selfX = selfRate * sample;
    if (!sample || !near(selfX)) { console.log(`SKIP metrics: ${biz}`); continue; }
    const rivals = ((r.comp ?? []) as { name: string; mentionRate?: number | null }[])
      .filter((e) => { const a = norm(e.name), b = norm(biz); return a !== b && !a.includes(b) && !b.includes(a); })
      .map((e) => ({ name: e.name, rate: e.mentionRate ?? 0 })).sort((a, b) => b.rate - a.rate);
    const top = rivals[0];
    const leads = !top || selfRate >= top.rate;
    let rivalLine = "";
    if (!leads && top) {
      const x = top.rate * sample;
      rivalLine = near(x) ? `${top.name} appeared in ${Math.round(x)}.\n\n` : `${top.name} appeared in ${Math.round(top.rate * 1000) / 10}% of them.\n\n`;
    }
    const first = ((r.cname as string | null) ?? "").split(" ")[0] || "there";
    const body = `Hi ${first},\n\nI tested ${sample} ChatGPT and Perplexity answers to buyer and seller questions to see which ${market} real estate teams they recommend.\n\n${biz} appeared in ${Math.round(selfX)} of ${sample} answers.\n\n${rivalLine}I help one real estate team per market become more likely to be the team these AI answers recommend. The ${market} spot is still open.\n\nI put your full benchmark together so you can verify every result yourself.\n\nReply "send it" and I'll send it over.${SIG}`;
    if (!APPLY) { if (ok === 0) console.log(`\n=== SAMPLE ${biz}\n${body}\n`); ok++; continue; }
    const c = await createOutreachDraft(user, { prospectId: r.prospectId, channel: "email", contactId: r.contactId ?? undefined, subject: r.subject, body, cta: 'reply "send it"' });
    if (!c.ok) { console.log(`FAIL create ${biz}: ${c.error.message}`); continue; }
    const a = await approveOutreachDraft(user, { draftId: c.data.draftId });
    if (!a.ok) { console.log(`FAIL approve ${biz}: ${a.error.message}`); continue; }
    const s = await scheduleDraftSend(user, { draftId: c.data.draftId, sendAt: r.scheduledSendAt, businessPurpose: "B-v3 template (operator copy 2026-08-27); slot kept." });
    if (!s.ok) { console.log(`FAIL sched ${biz}: ${s.error.message}`); continue; }
    ok++;
  }
  console.log(`${ok}/${rows.length} ${APPLY ? "updated" : "ready"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
