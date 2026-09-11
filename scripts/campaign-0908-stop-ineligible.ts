/**
 * Campaign week 2026-09-08: permanently stop the six sequences whose sent
 * Touch 1 claim no longer passes the mismatch gate after the spec 130
 * correction (founder decision 2026-09-06). Terminal; historical sends
 * untouched; any queued touch is cancelled by the engine.
 * Run: npx tsx scripts/campaign-0908-stop-ineligible.ts [--dry]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { sequenceForProspect, stopFollowupSequence } from "@/lib/prospects/followups";
const DEFAULT_NAMES = ["Brace Homes", "Caul Team", "Hamilton and Co.", "Team Stevens", "The Johnson Team", "Williams Richwine Group"];
const ni = process.argv.indexOf("--names");
const NAMES = ni >= 0 ? process.argv[ni + 1]!.split("|") : DEFAULT_NAMES;
const dry = process.argv.includes("--dry");
async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  for (const name of NAMES) {
    const [p] = await sql`select id from prospects where business_name = ${name}`;
    const seq = p ? await sequenceForProspect(p.id as string) : null;
    if (!seq) { console.log(`${name}: no sequence`); continue; }
    if (seq.status === "stopped") { console.log(`${name}: already stopped (${seq.stopReason})`); continue; }
    if (dry) { console.log(`${name}: would stop (${seq.status})`); continue; }
    const r = await stopFollowupSequence(user, { sequenceId: seq.id, reason: "NO_LONGER_ELIGIBLE after spec 130 correction; founder decision 2026-09-06: no ordinary T2/T3; correction handled separately" });
    const after = await sequenceForProspect(p!.id as string);
    const [q] = await sql`select count(*)::int as n from outreach_drafts where sequence_id = ${seq.id} and status = 'approved' and sent_recorded_at is null`;
    console.log(`${name}: ${r.ok ? "STOPPED" : "refused: " + r.error.message} · status ${after?.status} · queued touches remaining ${q?.n}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
