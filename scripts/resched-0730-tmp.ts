/**
 * Operator decision 2026-08-26: start each day's batch at 07:30 ET so it
 * sits at the top of the inbox. Cap-safe: the gmail gate refuses at 25
 * allowed gmail sends in a strict trailing 24h (service.ts spec 091), so
 * slots are simulated against the real ledger with an effective limit of
 * 24 (one spare for ad-hoc sends). 10-min stagger, order preserved.
 * Dry-run by default; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const GAP_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const EFFECTIVE_CAP = 24; // gate refuses at 25; keep one spare
const PURPOSE =
  "Operator decision 2026-08-26: batch moved to a 07:30 ET start (top-of-inbox), cap-safe slots against the trailing-24h gmail window.";
// August ET = UTC-4. 07:30 ET.
const STARTS: Record<string, string> = {
  "2026-08-27": "2026-08-27T11:30:00Z",
  "2026-08-28": "2026-08-28T11:30:00Z",
};

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };

  const ledger = await sql`select sent_at from prospect_outreach_sends
    where channel = 'gmail' and allowed and sent_at > now() - interval '26 hours' order by sent_at`;
  const events: number[] = ledger.map((r) => new Date(r.sentAt as Date).getTime());

  const drafts = await sql`select d.id, p.business_name, d.channel, d.scheduled_send_at,
      to_char(d.scheduled_send_at at time zone 'America/New_York','YYYY-MM-DD') as day
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at > now()
    order by d.scheduled_send_at`;

  const inWindow = (t: number): number[] => events.filter((e) => e > t - DAY_MS && e <= t);
  let prev = 0;
  for (const d of drafts) {
    const start = STARTS[d.day as string];
    if (!start) { console.log(`skip (day ${d.day} has no 07:30 start defined): ${d.businessName}`); continue; }
    let t = Math.max(new Date(start).getTime(), prev + GAP_MS);
    for (;;) {
      const w = inWindow(t);
      if (w.length < EFFECTIVE_CAP) break;
      t = Math.min(...w) + DAY_MS + 90_000; // first blocker ages out, +90s
    }
    const et = new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
    const old = new Date(d.scheduledSendAt as Date).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });
    if (!APPLY) console.log(`${d.day} ${old} → ${et} ET (${inWindow(t).length + 1}/25 after send) ${d.businessName} [${d.channel}]`);
    else {
      const res = await scheduleDraftSend(user, { draftId: d.id, sendAt: new Date(t), businessPurpose: PURPOSE });
      if (!res.ok) { console.error(`FAIL ${d.businessName}: ${res.error.message}`); continue; }
      console.log(`rescheduled ${d.day} ${old} → ${et} ET: ${d.businessName}`);
    }
    events.push(t); events.sort((a, b) => a - b);
    prev = t;
  }
  console.log(APPLY ? "done" : "dry-run — pass --apply to write");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
