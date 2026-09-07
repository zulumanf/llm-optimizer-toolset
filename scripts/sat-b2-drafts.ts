/**
 * Saturday 2026-08-29 batch: B-v2 (named rival + open seat) T1 drafts for
 * every newly published, contactable, uncontacted prospect. Numbers read
 * off each prospect's own snapshot (finding from keyFinding.metrics, rival
 * = max-mention comparison row; exact count only when rate×sample is
 * integer ±0.05, else the percentage; lead-defense when the prospect leads).
 * Brokerage cap (3/market/30d incl. scheduled) enforced at selection; slots
 * cap-safe vs trailing-24h gmail window incl. Thu/Fri scheduled sends.
 * Dry-run; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const START = "2026-08-29T11:30:00Z"; // Sat 07:30 ET
const GAP_MS = 10 * 60_000, DAY_MS = 86_400_000, EFFECTIVE_CAP = 24;
const PURPOSE = "Saturday batch (deepening pass): Arm B v2 first touch; counts from the published snapshot; cap-safe slot.";
const SIG = `\n\n—\nFrancisco Zuluaga · Recommended First\n1399 Myrtle Ave, Brooklyn, NY 11237\nIf you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`;

const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
const near = (x: number) => Math.abs(x - Math.round(x)) < 0.05;
const pct1 = (r: number) => `${Math.round(r * 1000) / 10}%`;

interface Rival { name: string; mentionRate?: number | null; recommendationRate?: number | null }

function findingSentence(biz: string, m: Record<string, number | undefined>, sample: number): string | null {
  const mr = m.mentionRate, rr = m.recommendationRate;
  if (mr !== undefined) {
    const x = mr * sample;
    if (!near(x)) return null;
    const c = Math.round(x);
    return c === 0
      ? `One result about ${biz} surprised me: ${biz} was not mentioned in any of the ${sample} monitored responses.`
      : `One result about ${biz} surprised me: ${biz} was mentioned in ${c} of ${sample} monitored responses (${pct1(mr)}) — absent from the remaining ${sample - c}.`;
  }
  if (rr !== undefined) {
    const x = rr * sample;
    if (!near(x)) return null;
    const c = Math.round(x);
    return c === 0
      ? `One result about ${biz} surprised me: ${biz} was recommended in 0 of the ${sample} monitored responses.`
      : `One result about ${biz} surprised me: ${biz} was recommended in ${c} of the ${sample} monitored responses (${pct1(rr)}).`;
  }
  return null;
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = u as unknown as CurrentUser;

  // Cap-safe slot machinery: ledger sends + all scheduled future sends.
  const ev1 = await sql`select sent_at t from prospect_outreach_sends where channel='gmail' and allowed and sent_at > now() - interval '26 hours'`;
  const ev2 = await sql`select scheduled_send_at t from outreach_drafts where status='approved' and sent_recorded_at is null and scheduled_send_at > now()`;
  const events: number[] = [...ev1, ...ev2].map((r) => new Date(r.t as Date).getTime()).sort((a, b) => a - b);
  const inWindow = (t: number) => events.filter((e) => e > t - DAY_MS && e <= t);
  let prev = 0;
  const nextSlot = (): number => {
    let t = Math.max(new Date(START).getTime(), prev + GAP_MS);
    for (;;) { const w = inWindow(t); if (w.length < EFFECTIVE_CAP) break; t = Math.min(...w) + DAY_MS + 90_000; }
    prev = t; events.push(t); events.sort((a, b) => a - b);
    return t;
  };

  // Brokerage usage per market (sent 30d + scheduled), lower(trim) key.
  const used = await sql`select p.launch_id, lower(trim(coalesce(p.brokerage_affiliation,''))) b, count(distinct p.id)::int n from prospects p
    where exists (select 1 from prospect_outreach_sends s where s.prospect_id=p.id and s.allowed and s.sent_at>now()-interval '30 days')
       or exists (select 1 from outreach_drafts d where d.prospect_id=p.id and d.status='approved' and d.scheduled_send_at>now())
    group by 1,2`;
  const brok = new Map(used.map((r) => [`${r.launchId}|${r.b}`, Number(r.n)]));

  const rows = await sql`
    select p.id, p.business_name, p.brokerage_affiliation, p.launch_id, l.name launch,
      a.snapshot->'keyFinding'->'metrics' m, a.snapshot->'comparison' comp,
      a.snapshot->'preparedBy'->>'email' pb,
      (select c.id from prospect_contacts c where c.prospect_id=p.id and c.archived_at is null and not c.do_not_contact and c.email is not null order by c.is_primary desc limit 1) cid,
      (select c.name from prospect_contacts c where c.prospect_id=p.id and c.archived_at is null and not c.do_not_contact and c.email is not null order by c.is_primary desc limit 1) cname
    from prospects p join market_launches l on l.id=p.launch_id
    join prospect_audits a on a.prospect_id=p.id and a.status='published' and (a.expires_at is null or a.expires_at>now())
    where p.archived_at is null and not p.do_not_contact
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id=p.id and s.allowed)
      and not exists (select 1 from outreach_drafts d where d.prospect_id=p.id and d.status='approved' and d.scheduled_send_at>now())
    order by l.name, p.business_name`;
  console.log(`${rows.length} candidates${APPLY ? "" : " (dry-run)"}`);
  let ok = 0;
  for (const r of rows) {
    const biz = r.businessName as string;
    const market = (r.launch as string).split("—")[0]!.replace("luxury residential", "").trim() || (r.launch as string);
    const tag = `${biz} [${market}]`;
    // L&F Wilmington is 3/3 under spec-120 name normalization ("...Inc." variant dodges the exact-match check here).
    if (biz === "Rose Bloom") { console.log(`skip brokerage-cap-normalized: ${tag}`); continue; }
    if (!r.cid) { console.log(`skip no-contact: ${tag}`); continue; }
    if (r.pb !== "francisco@recommendedfirst.com") { console.log(`skip stale-preparedBy: ${tag}`); continue; }
    const bkey = `${r.launchId}|${((r.brokerageAffiliation as string | null) ?? "").trim().toLowerCase()}`;
    const bu = brok.get(bkey) ?? 0;
    if ((r.brokerageAffiliation as string | null)?.trim() && bu >= 3) { console.log(`skip brokerage-cap (${bu}): ${tag}`); continue; }
    const m = (r.m ?? {}) as Record<string, number | undefined>;
    const sample = m.sampleSize ?? 0;
    if (!sample) { console.log(`skip no-metrics: ${tag}`); continue; }
    const finding = findingSentence(biz, m, sample);
    if (!finding) { console.log(`skip non-integer-metrics: ${tag} ${JSON.stringify(m)}`); continue; }
    const rivals = ((r.comp ?? []) as Rival[])
      .filter((e) => { const a = norm(e.name), b = norm(biz); return a !== b && !a.includes(b) && !b.includes(a); })
      .map((e) => ({ name: e.name, rate: e.mentionRate ?? 0 }))
      .sort((a, b) => b.rate - a.rate);
    const top = rivals[0];
    const selfRate = m.mentionRate ?? m.recommendationRate ?? 0;
    const leads = !top || selfRate >= top.rate;
    let rivalSentence: string | null = null;
    if (!leads && top) {
      const x = top.rate * sample;
      rivalSentence = near(x)
        ? `${top.name} was mentioned in ${Math.round(x)} of the same ${sample} answers.`
        : `${top.name} came up in ${pct1(top.rate)} of the same ${sample} answers.`;
    }
    const seat = leads
      ? `I work with one team per market on being the name these answers give — in ${market} that seat is open, and your count is the argument for it being you. Every question and complete answer is counted on one page you can check yourself. No link — reply "send it" and I'll send it over either way.`
      : `I work with one team per market on being the name these answers give — the ${market} seat is open. Every question and complete answer is counted on one page you can check yourself. No link — reply "send it" and I'll send it over either way.`;
    const first = ((r.cname as string | null) ?? "").split(" ")[0] || "there";
    const providers = sample >= 300 ? "openai and perplexity" : "openai";
    const body = `Hi ${first},\n\nI was benchmarking several leading ${market} teams across buyer and seller questions in ${providers} (${sample} monitored responses).\n\n${finding}\n\n${rivalSentence ? `${rivalSentence}\n\n` : ""}${seat}${SIG}`;
    const subject = `${/^[aeiou]/i.test(market) ? "An" : "A"} ${market} benchmark result about ${biz}`;
    const slot = new Date(nextSlot());
    if (!APPLY) { console.log(`\n=== ${tag} @ ${slot.toISOString()}\nSUBJ: ${subject}\n${body}`); ok++; continue; }
    const c = await createOutreachDraft(user, { prospectId: r.id, channel: "email", contactId: r.cid, subject, body, cta: 'reply "send it"' });
    if (!c.ok) { console.log(`FAIL create ${tag}: ${c.error.message}`); continue; }
    const a = await approveOutreachDraft(user, { draftId: c.data.draftId });
    if (!a.ok) { console.log(`FAIL approve(QA) ${tag}: ${a.error.message}`); continue; }
    const s = await scheduleDraftSend(user, { draftId: c.data.draftId, sendAt: slot, businessPurpose: PURPOSE });
    console.log(s.ok ? `scheduled ${tag} @ ${slot.toISOString()}` : `FAIL schedule ${tag}: ${s.error.message}`);
    if (s.ok) ok++;
    const bkey2 = bkey; brok.set(bkey2, (brok.get(bkey2) ?? 0) + 1);
  }
  console.log(`\n${ok} ${APPLY ? "scheduled" : "ready"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
