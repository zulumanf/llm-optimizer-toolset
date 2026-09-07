/**
 * Cohort-124 day-2 recovery (2026-09-02). The 17 Touch-1 drafts parked at
 * dispatch by the greeting check (fixed in PR #135) keep their approval but
 * lost their slot. Re-slot them under the trailing-24h Gmail cap (25):
 *
 *   Thu 2026-09-03 has 16 queued 09:03–13:28 ET. Eight more from 14:00 ET
 *   brings the window to 24 (one send of headroom).
 *   Fri 2026-09-04 from 14:00 ET: Thursday's morning sends have rolled out
 *   of the window, so nine more sit at 8 + 9 = 17.
 *
 * Markets round-robin across the two days so no market lands wholly on the
 * Friday-before-Labor-Day slot. Selection is deterministic (market name,
 * then business name).
 *
 * Run: npx tsx scripts/cohort124-reschedule-parked-0902.ts [--dry]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { scheduleDraftSend } from "@/lib/prospects/service";
import { qaDraft } from "@/lib/prospects/draft-qa";

const OPERATOR_EMAIL = "zulumanf@gmail.com";
const EXPERIMENT_ID = "competitive_mismatch_bootstrap_test_001";
const TEMPLATE = "competitive_mismatch_reply_v1";
/** ET is UTC-4 in September. */
const DAYS: { date: string; startUtc: string; count: number }[] = [
  { date: "2026-09-03", startUtc: "2026-09-03T18:00:00Z", count: 8 },
  { date: "2026-09-04", startUtc: "2026-09-04T18:00:00Z", count: 9 },
];
const SLOT_MINUTES = 10;

interface Parked {
  id: string;
  businessName: string;
  market: string;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const [u] = await sql`select id, email, name, role from users where email = ${OPERATOR_EMAIL}`;
  if (!u) throw new Error(`operator ${OPERATOR_EMAIL} not found`);
  const user = { id: u.id, email: u.email, name: u.name, role: u.role } as CurrentUser;

  const parked = (await sql`
    select d.id, p.business_name, coalesce(l.name, 'unknown') as market
    from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    left join market_launches l on l.id = p.launch_id
    where d.status = 'approved' and d.scheduled_send_at is null
      and d.last_send_error like '%greeting%'
    order by market, p.business_name
  `) as unknown as Parked[];
  const expected = DAYS.reduce((n, d) => n + d.count, 0);
  if (parked.length !== expected) {
    throw new Error(`expected ${expected} parked drafts, found ${parked.length}; refusing to guess`);
  }

  // Round-robin by market: take one per market per pass, so each day gets
  // a spread rather than a block.
  const byMarket = new Map<string, Parked[]>();
  for (const p of parked) byMarket.set(p.market, [...(byMarket.get(p.market) ?? []), p]);
  const order: Parked[] = [];
  while (order.length < parked.length) {
    for (const [, rows] of byMarket) {
      const next = rows.shift();
      if (next) order.push(next);
    }
  }

  const plan: { day: string; sendUtc: Date; row: Parked }[] = [];
  let cursor = 0;
  for (const day of DAYS) {
    const start = new Date(day.startUtc).getTime();
    for (let i = 0; i < day.count; i++) {
      plan.push({ day: day.date, sendUtc: new Date(start + i * SLOT_MINUTES * 60_000), row: order[cursor++]! });
    }
  }

  // Trailing-24h cap simulation including Thursday's already-queued sends.
  const queued = (await sql`
    select scheduled_send_at from outreach_drafts
    where status = 'approved' and scheduled_send_at >= now()
  `) as { scheduledSendAt: Date }[];
  const all = [...queued.map((q) => new Date(q.scheduledSendAt).getTime()), ...plan.map((p) => p.sendUtc.getTime())].sort((a, b) => a - b);
  let worst = 0;
  for (const t of all) worst = Math.max(worst, all.filter((x) => x <= t && x > t - 24 * 3600 * 1000).length);
  console.log(`queued=${queued.length} parked=${parked.length} trailing-24h worst case=${worst} (cap 25)`);
  if (worst > 25) throw new Error("plan breaches the Gmail cap");

  const failures: string[] = [];
  for (const p of plan) {
    const et = p.sendUtc.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    const issues = await qaDraft(p.row.id);
    const qa = issues.length ? `QA FAIL ${issues.map((i) => `[${i.check}] ${i.detail}`).join(" ")}` : "qa ok";
    console.log(`${p.day} ${et} ET  ${p.row.market.padEnd(36)} ${p.row.businessName}  ${qa}`);
    if (issues.length) { failures.push(`${p.row.businessName}: ${qa}`); continue; }
    if (dry) continue;
    const res = await scheduleDraftSend(user, {
      draftId: p.row.id,
      sendAt: p.sendUtc,
      businessPurpose:
        `Experiment ${EXPERIMENT_ID}: founder-approved Touch 1 (${TEMPLATE}) in ${p.row.market}, evidence-frozen. ` +
        `Re-slotted 2026-09-02 after the day-2 dispatch parked on the greeting check (fixed in PR #135).`,
    });
    if (!res.ok) failures.push(`${p.row.businessName}: schedule — ${res.error.message}`);
  }
  console.log(dry ? "\n--dry: nothing written" : `\nscheduled ${plan.length - failures.length} of ${plan.length}`);
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
