/**
 * Campaign week 2026-09-08 → 2026-09-14 (Labor Day skipped): cap-aware
 * weekly plan over the EXISTING queue, sequence engine and send gate.
 *
 * What it does, in order:
 *   1. Timeline of every send that will consume the trailing-24h Gmail cap:
 *      actual allowed sends, queued approved drafts, and the PROJECTED slot
 *      of every active follow-up (T2/T3) — deferred exactly as the worker's
 *      capAwareSlot would defer them. Follow-ups are placed first: they have
 *      priority over any new Touch 1 (P1 T3, P2 T2, P3 T1).
 *   2. Touch 1 candidates: live competitive-mismatch eligibility, verified
 *      recipient, suppression/DNC/bounce/recontact, per-market brokerage
 *      cap (sent + queued, 30d), market cap, send-time territory check,
 *      benchmark freshness ON THE PLANNED DAY, and the spec 130 entity QA
 *      (verified lead-agent aliases applied + answers re-resolved on the
 *      frozen run before eligibility is trusted; single-name leads fail
 *      closed). Prospects with stale parked drafts are re-drafted from
 *      current canonical evidence.
 *   3. Placement: first minute inside the recipient's 09:00–10:30 local
 *      window (spilling later in the local day only when that window is
 *      full) at which the trailing 24h stays under the cap AND no already
 *      planned follow-up in the following 24h is pushed over it.
 *   4. --apply: supersede stale parked drafts → createOutreachDraft (frozen
 *      evidence) → qaDraft clean → approveOutreachDraft → scheduleDraftSend.
 *      The worker's gate re-runs every check at dispatch.
 *
 * Run: npx tsx scripts/campaign-0908-plan.ts [--dry|--apply] [--entity-qa]
 *      [--headroom 1] [--max-per-market 8] [--max-t1 N]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";
import { competitiveMismatchReview, mismatchStrength } from "@/lib/prospects/mismatch";
import { qaDraft } from "@/lib/prospects/draft-qa";
import { checkSuppression } from "@/lib/outreach/suppression";
import { detectLaunchConflicts } from "@/lib/prospects/shared";
import { getFollowupSequence, marketTimezone, projectedSlot, slotFor } from "@/lib/prospects/followups";
import { addBusinessDays, isBusinessDay, wallClock, zonedInstant } from "@/lib/prospects/business-days";
import { applyVerifiedAliases, deriveLeadAgentAliases, leadAgentRelationships } from "@/lib/prospects/entity-aliases";
import { parseCompanyIntoRun } from "@/lib/parsing/service";
import {
  BROKERAGE_SEND_CAP_30D,
  FOLLOWUP_CADENCE_BUSINESS_DAYS,
  GMAIL_DAILY_SEND_CAP,
  MISMATCH_TEMPLATE_VERSION,
  MISMATCH_THRESHOLDS,
  normalizeBrokerage,
  RECONTACT_PERSON_WINDOW_DAYS,
} from "@/lib/prospects/constants";

const APPLY = process.argv.includes("--apply");
const ENTITY_QA = process.argv.includes("--entity-qa");
const arg = (k: string, d: number): number => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const HEADROOM = arg("--headroom", 1);
const MAX_PER_MARKET = arg("--max-per-market", 8);
const MAX_T1 = arg("--max-t1", 1000);
const DAY_CAP = GMAIL_DAILY_SEND_CAP - HEADROOM;
const DAYS = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"];
const HORIZON_END = new Date("2026-09-15T04:00:00Z");
const PREFERRED = { start: 9, end: 10.5 };
const LOCAL_START = 8, LOCAL_END = 18;
const SPACING_MS = 2 * 60_000;
const CAP_MS = 24 * 3_600_000;
const ET = "America/New_York";

interface Point { t: number; kind: "sent" | "queued" | "T2" | "T3" | "T1" | "T2p"; label: string }
interface Cand {
  prospectId: string; name: string; market: string; launchId: string; brokerage: string | null; contactId: string;
  email: string; competitor: string; strength: string; gap: number; tz: string; benchmarkAgeDays: number;
  parkedDraftIds: string[];
}

const fmt = (d: Date, tz: string): string => { const w = wallClock(d, tz); return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][w.weekday]} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")} ${tz.split("/")[1]}`; };
const dayKeyEt = (t: number): string => { const w = wallClock(new Date(t), ET); return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`; };

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  const now = new Date();
  const timeline: Point[] = [];
  const countIn = (t: number): number => timeline.filter((x) => x.t <= t && x.t > t - CAP_MS).length;

  // ---- 1. timeline: sent + queued + projected follow-ups (priority order)
  for (const r of await sql`select sent_at as t, recipient_email as e from prospect_outreach_sends where allowed and channel = 'gmail' and sent_at > now() - interval '24 hours'`) timeline.push({ t: new Date(r.t as Date).getTime(), kind: "sent", label: r.e as string });
  for (const r of await sql`select d.scheduled_send_at as t, p.business_name as n, d.touch_number as touch from outreach_drafts d join prospects p on p.id = d.prospect_id where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at >= now()`) timeline.push({ t: new Date(r.t as Date).getTime(), kind: "queued", label: `${r.n}${r.touch ? ` T${r.touch}` : ""}` });
  const seqRows = await sql`
    select q.id, q.status, q.paused_until, q.pause_reason, p.business_name from outreach_followup_sequences q join prospects p on p.id = q.prospect_id
    where q.status = 'active' or (q.status = 'paused' and q.pause_reason like 'out of office%' and q.paused_until is not null)
    order by q.next_due_at asc nulls last`;
  const followups: { name: string; touch: 2 | 3; slot: Date; tz: string; deferred: boolean; queued: boolean }[] = [];
  for (const r of seqRows) {
    const seq = await getFollowupSequence(r.id as string);
    if (!seq || !seq.nextTouch || !seq.nextDueAt) continue;
    const [live] = await sql`select scheduled_send_at from outreach_drafts where sequence_id = ${seq.id} and status = 'approved' and sent_recorded_at is null and scheduled_send_at is not null`;
    if (live) { followups.push({ name: r.businessName as string, touch: seq.nextTouch, slot: new Date(live.scheduledSendAt as Date), tz: seq.timezone, deferred: false, queued: true }); continue; }
    const resumeAt = seq.status === "paused" && seq.pausedUntil ? seq.pausedUntil : now;
    let slot = projectedSlot({ ...seq, status: "active" }, resumeAt)!;
    let deferred = false;
    for (let i = 0; i < 5 && countIn(slot.getTime()) >= GMAIL_DAILY_SEND_CAP; i += 1) { slot = slotFor(seq, new Date(slot.getTime() + 86_400_000)); deferred = true; }
    if (slot.getTime() > HORIZON_END.getTime()) continue;
    timeline.push({ t: slot.getTime(), kind: seq.nextTouch === 3 ? "T3" : "T2", label: r.businessName as string });
    followups.push({ name: r.businessName as string, touch: seq.nextTouch, slot, tz: seq.timezone, deferred, queued: false });
  }
  timeline.sort((a, b) => a.t - b.t);

  // ---- 2. Touch 1 candidates
  const rows = await sql`
    select p.id, p.business_name, p.launch_id, p.brokerage_affiliation, l.name as launch, l.market_id, l.service_category, l.price_segment, p.company_id,
      c.id as contact_id, c.email, c.provenance, c.do_not_contact_reason,
      exists (select 1 from outreach_drafts d where d.prospect_id = p.id and d.status = 'draft' and d.prompt_version = ${MISMATCH_TEMPLATE_VERSION} and d.created_at > now() - interval '3 days') as qa_parked,
      (select coalesce(json_agg(d.id), '[]') from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is null) as parked
    from prospects p
    join market_launches l on l.id = p.launch_id
    join lateral (select id, email, provenance, do_not_contact_reason from prospect_contacts c where c.prospect_id = p.id and c.is_primary and not c.do_not_contact and c.archived_at is null and c.email is not null limit 1) c on true
    where p.archived_at is null and not p.do_not_contact and p.company_id is not null
      and exists (select 1 from realtrends_records r where r.company_id = p.company_id)
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed)
      and not exists (select 1 from outreach_followup_sequences q where q.prospect_id = p.id)
      and not exists (select 1 from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is not null)
      and not exists (select 1 from prospect_replies r where r.prospect_id = p.id)
      and p.stage not in ('replied','lost','disqualified','do_not_contact','closed_lost','waitlisted','conflict_blocked')
    order by l.name, p.business_name`;
  const cands: Cand[] = [];
  const rejects: Record<string, string[]> = {};
  const rej = (why: string, name: string): void => { (rejects[why] ??= []).push(name); };
  const territoryByLaunch = new Map<string, string>();
  for (const r of rows) {
    const name = r.businessName as string;
    if (!["verified", "publicly_sourced", "manual"].includes(r.provenance as string)) { rej("contact not source-verified", name); continue; }
    if (/bounce/i.test((r.doNotContactReason as string | null) ?? "")) { rej("bounced", name); continue; }
    if (r.qaParked) { rej("fresh draft failed QA (operator review; see draft QA)", name); continue; }
    let review = await competitiveMismatchReview(r.id as string, { contactId: r.contactId as string });
    let e = review?.evaluation;
    if (!e?.eligible || !e.selected || !review?.runId) { rej("ineligible (live mismatch gates)", name); continue; }
    // Spec 130 entity QA: both sides' verified lead-agent aliases must be on
    // file and credited on the frozen run before the counts are trusted.
    const sides = await leadAgentRelationships([r.companyId as string, e.selected.companyId]);
    let review_required = false, pending = false;
    for (const rel of sides) {
      const d = deriveLeadAgentAliases(rel);
      if (d.status === "ENTITY_REVIEW_REQUIRED") {
        // A single-name RealTrends lead is resolved when an operator-verified
        // full-name alias (authoritative public page, audited with its source)
        // is already on the company and starts with that recorded name.
        const lead = (rel.teamLead ?? "").trim().toLowerCase();
        const manual = lead && rel.existingAliases.some((a) => a.toLowerCase().split(/\s+/)[0] === lead && a.trim().split(/\s+/).length >= 2);
        if (!manual) { review_required = true; rej(`entity review required (${rel.companyName}: ${d.reason})`, name); break; }
        continue;
      }
      if (d.status === "aliases") {
        if (!ENTITY_QA) { pending = true; break; }
        const applied = await applyVerifiedAliases(user, rel.companyId);
        if (applied.refused) { review_required = true; rej(`alias refused (${rel.companyName}: ${applied.refused})`, name); break; }
        const res = await parseCompanyIntoRun(review.runId, rel.companyId);
        console.log(`  entity-qa ${rel.companyName}: aliases ${JSON.stringify(applied.added)} scanned ${res.scanned} hits ${res.hits} rows added ${res.inserted}`);
      }
    }
    if (review_required) continue;
    if (pending) { rej("entity QA pending (run with --entity-qa)", name); continue; }
    if (sides.some((s) => deriveLeadAgentAliases(s).status === "aliases")) {
      // aliases were just applied: re-evaluate on corrected counts
      review = await competitiveMismatchReview(r.id as string, { contactId: r.contactId as string });
      e = review?.evaluation;
      if (!e?.eligible || !e.selected) { rej("ineligible after entity QA", name); continue; }
    }
    const sup = await checkSuppression({ email: r.email as string, phone: null, projectId: null });
    if (sup.suppressed) { rej("suppressed", name); continue; }
    const [prior] = await sql`select 1 from prospect_outreach_sends s where s.allowed and lower(s.recipient_email) = ${(r.email as string).toLowerCase()} and s.sent_at > now() - make_interval(days => ${RECONTACT_PERSON_WINDOW_DAYS})`;
    if (prior) { rej("person contacted recently", name); continue; }
    const lk = r.launchId as string;
    if (!territoryByLaunch.has(lk)) {
      const det = await detectLaunchConflicts(sql, { marketId: r.marketId as string, serviceCategory: (r.serviceCategory as string | null) ?? null, priceSegment: (r.priceSegment as string | null) ?? null });
      territoryByLaunch.set(lk, det.worstVerdict);
    }
    if (territoryByLaunch.get(lk) !== "clear") { rej(`territory conflict (${territoryByLaunch.get(lk)})`, name); continue; }
    if (!review!.firstName) { rej("no valid first name", name); continue; }
    const { tz } = await marketTimezone(r.id as string);
    cands.push({ prospectId: r.id as string, name, market: (r.launch as string).split(" —")[0]!.split(" luxury")[0]!.trim(), launchId: lk, brokerage: (r.brokerageAffiliation as string | null) ?? null, contactId: r.contactId as string, email: (r.email as string).toLowerCase(), competitor: e.selected.displayName, strength: mismatchStrength(e.selected), gap: e.selected.recommendationGap, tz, benchmarkAgeDays: e.benchmarkAgeDays ?? 999, parkedDraftIds: (r.parked as string[]) ?? [] });
  }
  cands.sort((a, b) => (a.strength === "strong" ? 0 : 1) - (b.strength === "strong" ? 0 : 1) || b.gap - a.gap);

  // ---- brokerage + market caps
  const perMarket = new Map<string, number>();
  // Market cap counts Touch 1s already queued for this campaign week.
  for (const r of await sql`select split_part(l.name, ' —', 1) as market, count(distinct d.prospect_id)::int as n from outreach_drafts d join prospects p on p.id = d.prospect_id join market_launches l on l.id = p.launch_id where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at >= now() and d.prompt_version = ${MISMATCH_TEMPLATE_VERSION} and d.sequence_id is null group by 1`) perMarket.set((r.market as string).split(" luxury")[0]!.trim(), Number(r.n));
  const brokerageUsed = new Map<string, number>();
  const seenEmail = new Set<string>();
  const selected: Cand[] = [];
  for (const c of cands) {
    if (selected.length >= MAX_T1) break;
    if ((perMarket.get(c.market) ?? 0) >= MAX_PER_MARKET) { rej("market cap", c.name); continue; }
    if (seenEmail.has(c.email)) { rej("duplicate email", c.name); continue; }
    if (c.brokerage) {
      const key = `${c.launchId}|${normalizeBrokerage(c.brokerage)}`;
      if (!brokerageUsed.has(key)) {
        const names = await sql`
          select distinct p.id, p.brokerage_affiliation from prospects p
          where p.launch_id = ${c.launchId} and p.brokerage_affiliation is not null
            and (exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed and s.sent_at > now() - interval '30 days')
              or exists (select 1 from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is not null))`;
        brokerageUsed.set(key, names.filter((x) => normalizeBrokerage(x.brokerageAffiliation as string) === normalizeBrokerage(c.brokerage!)).length);
      }
      if ((brokerageUsed.get(key) ?? 0) >= BROKERAGE_SEND_CAP_30D) { rej("brokerage cap", c.name); continue; }
      brokerageUsed.set(key, (brokerageUsed.get(key) ?? 0) + 1);
    }
    perMarket.set(c.market, (perMarket.get(c.market) ?? 0) + 1);
    seenEmail.add(c.email);
    selected.push(c);
  }

  // ---- 3. placement (follow-ups already in the timeline keep priority)
  const fits = (t: number): boolean => {
    if (timeline.some((x) => Math.abs(x.t - t) < SPACING_MS)) return false;
    if (countIn(t) + 1 > DAY_CAP) return false;
    for (const x of timeline) if (x.t > t && x.t < t + CAP_MS && countIn(x.t) + 1 > DAY_CAP) return false;
    return true;
  };
  // Every Touch 1 creates a Touch 2 three business days later (same local
  // morning); the T1 may only go where that projected T2 also fits, so new
  // sends never stack a follow-up wave on top of an already-full day.
  const t2Of = (t: number, tz: string): number | null => { const d = addBusinessDays(new Date(t), FOLLOWUP_CADENCE_BUSINESS_DAYS[2], tz); return d.getTime() > HORIZON_END.getTime() ? null : d.getTime(); };
  const fitsWithT2 = (t: number, tz: string): boolean => {
    if (!fits(t)) return false;
    const t2 = t2Of(t, tz);
    if (t2 === null) return true;
    timeline.push({ t, kind: "T1", label: "probe" });
    const ok = fits(t2);
    timeline.pop();
    return ok;
  };
  const place = (c: Cand, day: string, preferredOnly: boolean): Date | null => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    if (!isBusinessDay(zonedInstant(y, m, d, 12, 0, c.tz), c.tz)) return null;
    const windows: [number, number][] = preferredOnly ? [[PREFERRED.start, PREFERRED.end]] : [[PREFERRED.start, PREFERRED.end], [PREFERRED.end, LOCAL_END], [LOCAL_START, PREFERRED.start]];
    for (const [h0, h1] of windows) {
      const start = zonedInstant(y, m, d, Math.floor(h0), Math.round((h0 % 1) * 60), c.tz).getTime();
      const end = zonedInstant(y, m, d, Math.floor(h1), Math.round((h1 % 1) * 60), c.tz).getTime();
      for (let t = Math.max(start, now.getTime() + 3_600_000); t < end; t += 60_000) {
        if (fitsWithT2(t, c.tz)) {
          timeline.push({ t, kind: "T1", label: c.name });
          const t2 = t2Of(t, c.tz);
          if (t2 !== null) timeline.push({ t: t2, kind: "T2p", label: ` (T2 of new T1)` });
          timeline.sort((a, b) => a.t - b.t); return new Date(t);
        }
      }
    }
    return null;
  };
  const plan: { c: Cand; at: Date; day: string }[] = [];
  const unplaced: Cand[] = [];
  // Pass 1: recipient-local 09:00–10:30 on the earliest day with room;
  // pass 2: any hour of the local business day. Benchmark must still be
  // fresh on the send day (the gate re-checks at dispatch).
  let pending = [...selected];
  for (const preferredOnly of [true, false]) {
    const next: Cand[] = [];
    for (const c of pending) {
      let at: Date | null = null, onDay = "";
      for (const day of DAYS) {
        const ahead = Math.round((new Date(`${day}T12:00:00Z`).getTime() - now.getTime()) / 86_400_000);
        if (c.benchmarkAgeDays + ahead > MISMATCH_THRESHOLDS.maxBenchmarkAgeDays) break;
        at = place(c, day, preferredOnly);
        if (at) { onDay = day; break; }
      }
      if (at) plan.push({ c, at, day: onDay }); else next.push(c);
    }
    pending = next;
  }
  unplaced.push(...pending);

  // ---- report
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} · cap ${GMAIL_DAILY_SEND_CAP}/24h, planning to ${DAY_CAP} · candidates ${cands.length} · selected ${selected.length} · T1 placed ${plan.length} · unplaced ${unplaced.length}`);
  for (const [why, names] of Object.entries(rejects)) console.log(`  reject · ${why}: ${names.length}${names.length <= 15 ? " — " + names.join(", ") : ""}`);
  if (unplaced.length) console.log(`  unplaced (no cap room in window): ${unplaced.map((c) => c.name).join(", ")}`);
  console.log(`\nDAILY PLAN (ET calendar day)`);
  for (const day of DAYS) {
    const pts = timeline.filter((x) => dayKeyEt(x.t) === day);
    const n = (k: Point["kind"]): number => pts.filter((x) => x.kind === k).length;
    console.log(`  ${day}  T3 ${n("T3")}  T2 ${n("T2")}  T1 ${n("T1")}  T2-of-new-T1 ${n("T2p")}  queued-other ${n("queued")}  total ${pts.length}`);
  }
  console.log(`\nFOLLOW-UPS PROJECTED`);
  for (const f of followups.sort((a, b) => a.slot.getTime() - b.slot.getTime())) console.log(`  T${f.touch} ${fmt(f.slot, f.tz).padEnd(22)} ${f.slot.toISOString().slice(5, 16)}Z ${f.name}${f.deferred ? "  (cap-deferred)" : ""}${f.queued ? "  (queued)" : ""}`);
  console.log(`\nTOUCH 1 PLACED`);
  for (const p of plan) console.log(`  ${p.day} ${fmt(p.at, p.c.tz).padEnd(22)} ${p.at.toISOString().slice(11, 16)}Z  ${p.c.market.padEnd(16)} ${p.c.name.padEnd(38)} vs ${p.c.competitor} [${p.c.strength} gap ${p.c.gap}] ${p.c.email}${p.c.parkedDraftIds.length ? "  (re-draft; supersedes parked)" : ""}`);
  const worst = Math.max(0, ...timeline.map((x) => countIn(x.t)));
  console.log(`\ntrailing-24h worst case after plan: ${worst} (cap ${GMAIL_DAILY_SEND_CAP})`);
  if (!APPLY) { console.log("--dry: nothing scheduled"); await sql.end(); return; }

  // ---- 4. apply
  const failures: string[] = [];
  for (const p of plan) {
    if (p.c.parkedDraftIds.length) {
      await sql`update outreach_drafts set status = 'superseded', scheduled_send_at = null, send_claimed_at = null,
        last_send_error = 'Superseded 2026-09-06: stale parked draft; regenerated from current canonical evidence for the 09-08 campaign week.'
        where id = any(${p.c.parkedDraftIds}::uuid[]) and status = 'approved' and sent_recorded_at is null`;
    }
    const draft = await createOutreachDraft(user, { prospectId: p.c.prospectId, channel: "email", contactId: p.c.contactId });
    if (!draft.ok) { failures.push(`${p.c.name}: draft — ${draft.error.message}`); continue; }
    const id = draft.data.draftId;
    const [row] = await sql`select prompt_version from outreach_drafts where id = ${id}`;
    if (row?.promptVersion !== MISMATCH_TEMPLATE_VERSION) { failures.push(`${p.c.name}: draft template is ${row?.promptVersion}, not ${MISMATCH_TEMPLATE_VERSION}`); continue; }
    const issues = await qaDraft(id);
    if (issues.length) { failures.push(`${p.c.name}: QA — ${issues.map((x) => `[${x.check}] ${x.detail}`).join(" ")}`); continue; }
    const ap = await approveOutreachDraft(user, { draftId: id });
    if (!ap.ok) { failures.push(`${p.c.name}: approve — ${ap.error.message}`); continue; }
    const sc = await scheduleDraftSend(user, { draftId: id, sendAt: p.at, businessPurpose: `Campaign week 2026-09-08 (founder directive 2026-09-06, 25/day cap-aware): Touch 1 (${MISMATCH_TEMPLATE_VERSION}) to a competitively mismatched ${p.c.market} entity, evidence frozen at draft, spec 130 entity QA passed; recipient-local morning slot.` });
    if (!sc.ok) { failures.push(`${p.c.name}: schedule — ${sc.error.message}`); continue; }
    console.log(`  scheduled ${p.c.name} → ${p.at.toISOString()} (draft ${id.slice(0, 8)})`);
  }
  if (failures.length) { console.error("FAILURES\n" + failures.join("\n")); process.exitCode = 1; }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
