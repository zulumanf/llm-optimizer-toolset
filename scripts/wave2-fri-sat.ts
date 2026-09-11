/**
 * Wave 2 (2026-09-04/05): fill Friday and Saturday to the Gmail cap with new
 * competitive-mismatch Touch 1 sends. Same policy as cohort124-queue.ts —
 * live mismatch eligibility, source-verified primary contact, suppression,
 * 30-day person recontact, 3-per-brokerage-per-market, one email per
 * person — then createOutreachDraft (frozen evidence) → qaDraft clean →
 * approveOutreachDraft → scheduleDraftSend at a cap-aware slot: the earliest
 * instant inside the recipient's 08:00–18:00 local day at which the trailing
 * 24-hour window (sent + queued + planned) stays under GMAIL_DAILY_SEND_CAP.
 *
 * Run: npx tsx scripts/wave2-fri-sat.ts [--dry] [--fri N] [--sat N]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";
import { competitiveMismatchReview, mismatchStrength } from "@/lib/prospects/mismatch";
import { qaDraft } from "@/lib/prospects/draft-qa";
import { checkSuppression } from "@/lib/outreach/suppression";
import { marketTimezone } from "@/lib/prospects/followups";
import { wallClock, zonedInstant } from "@/lib/prospects/business-days";
import { BROKERAGE_SEND_CAP_30D, GMAIL_DAILY_SEND_CAP, MISMATCH_TEMPLATE_VERSION, normalizeBrokerage, RECONTACT_PERSON_WINDOW_DAYS } from "@/lib/prospects/constants";

const dry = process.argv.includes("--dry");
const arg = (k: string, d: number): number => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const TARGET: { day: string; start: { tz: "local" | "ET"; hour: number }; count: number }[] = [
  { day: "2026-09-04", start: { tz: "ET", hour: 11 }, count: arg("--fri", 8) },
  { day: "2026-09-05", start: { tz: "local", hour: 9 }, count: arg("--sat", 16) },
];
const MAX_PER_MARKET = 8;
const SPACING_MS = 2 * 60_000;
const LOCAL_START = 8, LOCAL_END = 18;
const CAP_MS = 24 * 3_600_000;

interface Cand { prospectId: string; name: string; market: string; launchId: string; brokerage: string | null; contactId: string; email: string; competitor: string; strength: string; gap: number; tz: string }

function fmt(d: Date, tz: string): string { const w = wallClock(d, tz); return `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][w.weekday]} ${String(w.hour).padStart(2,"0")}:${String(w.minute).padStart(2,"0")} ${tz.split("/")[1]}`; }

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;

  // ---- candidates
  const rows = await sql`
    select p.id, p.business_name, p.launch_id, p.brokerage_affiliation, l.name as launch,
      c.id as contact_id, c.email, c.provenance
    from prospects p
    join market_launches l on l.id = p.launch_id
    join lateral (select id, email, provenance from prospect_contacts c where c.prospect_id = p.id and c.is_primary and not c.do_not_contact and c.archived_at is null and c.email is not null limit 1) c on true
    where p.archived_at is null and not p.do_not_contact and p.company_id is not null
      and exists (select 1 from realtrends_records r where r.company_id = p.company_id)
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed)
      and not exists (select 1 from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null)
      and p.stage not in ('replied','lost','disqualified','do_not_contact')
    order by l.name, p.business_name`;
  const cands: Cand[] = [];
  const rejects: Record<string, string[]> = {};
  const rej = (why: string, name: string): void => { (rejects[why] ??= []).push(name); };
  for (const r of rows) {
    const name = r.businessName as string;
    if (["ai_inferred", "estimated"].includes(r.provenance as string)) { rej("contact not source-verified", name); continue; }
    const review = await competitiveMismatchReview(r.id as string);
    const e = review?.evaluation;
    if (!e?.eligible || !e.selected) { rej(`ineligible`, name); continue; }
    const sup = await checkSuppression({ email: r.email as string, phone: null, projectId: null });
    if (sup.suppressed) { rej("suppressed", name); continue; }
    const [prior] = await sql`select 1 from prospect_outreach_sends s where s.allowed and lower(s.recipient_email) = ${(r.email as string).toLowerCase()} and s.sent_at > now() - make_interval(days => ${RECONTACT_PERSON_WINDOW_DAYS})`;
    if (prior) { rej("person contacted recently", name); continue; }
    const { tz } = await marketTimezone(r.id as string);
    cands.push({ prospectId: r.id as string, name, market: (r.launch as string).split(" —")[0]!.split(" luxury")[0]!.trim(), launchId: r.launchId as string, brokerage: (r.brokerageAffiliation as string | null) ?? null, contactId: r.contactId as string, email: (r.email as string).toLowerCase(), competitor: e.selected.displayName, strength: mismatchStrength(e.selected), gap: e.selected.recommendationGap, tz });
  }
  cands.sort((a, b) => (a.strength === "strong" ? 0 : 1) - (b.strength === "strong" ? 0 : 1) || b.gap - a.gap);

  // ---- diversity + brokerage cap (distinct prospects sent or queued per launch, 30d)
  const perMarket = new Map<string, number>();
  const brokerageUsed = new Map<string, number>();
  const seenEmail = new Set<string>();
  const selected: Cand[] = [];
  const want = TARGET.reduce((n, t) => n + t.count, 0);
  for (const c of cands) {
    if (selected.length >= want) break;
    if ((perMarket.get(c.market) ?? 0) >= MAX_PER_MARKET) { rej("market full", c.name); continue; }
    if (seenEmail.has(c.email)) { rej("duplicate email", c.name); continue; }
    if (c.brokerage) {
      const key = `${c.launchId}|${normalizeBrokerage(c.brokerage)}`;
      if (!brokerageUsed.has(key)) {
        // Normalize in JS to match the gate's bucket exactly.
        const names = await sql`
          select distinct p.id, p.brokerage_affiliation from prospects p
          where p.launch_id = ${c.launchId} and p.brokerage_affiliation is not null
            and (exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed and s.sent_at > now() - interval '30 days')
              or exists (select 1 from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is not null))`;
        const used = names.filter((x) => normalizeBrokerage(x.brokerageAffiliation as string) === normalizeBrokerage(c.brokerage!)).length;
        brokerageUsed.set(key, used);
      }
      if ((brokerageUsed.get(key) ?? 0) >= BROKERAGE_SEND_CAP_30D) { rej("brokerage cap", c.name); continue; }
      brokerageUsed.set(key, (brokerageUsed.get(key) ?? 0) + 1);
    }
    perMarket.set(c.market, (perMarket.get(c.market) ?? 0) + 1);
    seenEmail.add(c.email);
    selected.push(c);
  }

  // ---- cap-aware slots
  const known: number[] = [];
  for (const r of await sql`select sent_at as t from prospect_outreach_sends where allowed and channel = 'gmail' and sent_at > now() - interval '24 hours'`) known.push(new Date(r.t as Date).getTime());
  for (const r of await sql`select scheduled_send_at as t from outreach_drafts where status = 'approved' and sent_recorded_at is null and scheduled_send_at >= now()`) known.push(new Date(r.t as Date).getTime());
  // Friday Touch 2s are rendered later; assume all 16 go (conservative).
  for (const r of await sql`select q.id, q.timezone, q.next_due_at from outreach_followup_sequences q where q.status = 'active' and q.next_due_at < '2026-09-06'`) {
    const { projectedSlot, getFollowupSequence } = await import("@/lib/prospects/followups");
    const seq = await getFollowupSequence(r.id as string);
    const s = seq ? projectedSlot(seq, new Date()) : null;
    if (s) known.push(s.getTime());
  }
  const timeline = [...known].sort((a, b) => a - b);
  const countIn = (t: number): number => timeline.filter((x) => x <= t && x > t - CAP_MS).length;
  const place = (c: Cand, day: string, start: { tz: "local" | "ET"; hour: number }): Date | null => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const first = start.tz === "ET" ? zonedInstant(y, m, d, start.hour, 0, "America/New_York") : zonedInstant(y, m, d, start.hour, 0, c.tz);
    const localStart = zonedInstant(y, m, d, LOCAL_START, 0, c.tz).getTime();
    const localEnd = zonedInstant(y, m, d, LOCAL_END, 0, c.tz).getTime();
    for (let t = Math.max(first.getTime(), localStart); t < localEnd; t += 60_000) {
      if (timeline.some((x) => Math.abs(x - t) < SPACING_MS)) continue;
      if (countIn(t) < GMAIL_DAILY_SEND_CAP) {
        timeline.push(t); timeline.sort((a, b) => a - b);
        return new Date(t);
      }
    }
    return null;
  };
  const plan: { c: Cand; at: Date; day: string }[] = [];
  let i = 0;
  for (const t of TARGET) {
    let placed = 0;
    while (placed < t.count && i < selected.length) {
      const c = selected[i]!; i += 1;
      const at = place(c, t.day, t.start);
      if (!at) { rej(`no cap room ${t.day}`, c.name); continue; }
      plan.push({ c, at, day: t.day }); placed += 1;
    }
  }

  console.log(`candidates ${cands.length} · selected ${selected.length} · planned ${plan.length} (dry=${dry})`);
  for (const [why, names] of Object.entries(rejects)) console.log(`  ${why}: ${names.length}${names.length <= 12 ? " — " + names.join(", ") : ""}`);
  for (const p of plan.sort((a, b) => a.at.getTime() - b.at.getTime())) {
    console.log(`  ${p.day} ${fmt(p.at, p.c.tz).padEnd(22)} ${p.at.toISOString().slice(11, 16)}Z  ${p.c.market.padEnd(16)} ${p.c.name.padEnd(36)} vs ${p.c.competitor} [${p.c.strength}] ${p.c.email}`);
  }
  const worst = Math.max(...timeline.map((t) => countIn(t)));
  console.log(`trailing-24h worst case after plan: ${worst} (cap ${GMAIL_DAILY_SEND_CAP})`);
  if (dry) { console.log("--dry: nothing written"); await sql.end(); return; }

  // ---- draft → QA → approve → schedule
  const failures: string[] = [];
  for (const p of plan) {
    const draft = await createOutreachDraft(user, { prospectId: p.c.prospectId, channel: "email", contactId: p.c.contactId });
    if (!draft.ok) { failures.push(`${p.c.name}: draft — ${draft.error.message}`); continue; }
    const id = draft.data.draftId as string;
    const [row] = await sql`select prompt_version from outreach_drafts where id = ${id}`;
    if (row?.promptVersion !== MISMATCH_TEMPLATE_VERSION) { failures.push(`${p.c.name}: draft template is ${row?.promptVersion}, not mismatch`); continue; }
    const issues = await qaDraft(id);
    if (issues.length) { failures.push(`${p.c.name}: QA — ${issues.map((x) => x.detail).join(" ")}`); continue; }
    const ap = await approveOutreachDraft(user, { draftId: id });
    if (!ap.ok) { failures.push(`${p.c.name}: approve — ${ap.error.message}`); continue; }
    const sc = await scheduleDraftSend(user, { draftId: id, sendAt: p.at, businessPurpose: `Wave 2 (founder decision 2026-09-03): Touch 1 (${MISMATCH_TEMPLATE_VERSION}) to a competitively mismatched team in ${p.c.market}, evidence-frozen; ${p.day === "2026-09-05" ? "Saturday send by operator choice" : "Friday afternoon cap-aware slot"}.` });
    if (!sc.ok) { failures.push(`${p.c.name}: schedule — ${sc.error.message}`); continue; }
    console.log(`  scheduled ${p.c.name} → ${p.at.toISOString()}`);
  }
  if (failures.length) { console.error("FAILURES\n" + failures.join("\n")); process.exitCode = 1; }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
