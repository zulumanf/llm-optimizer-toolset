/** Data-correctness remediation 2026-08-25 (follow-up to bounce-mark-0825):
 *  1. The three hard-bounced addresses were marked DNC but never suppressed,
 *     so the dashboard's delivery rate reads 100% while three sends bounced.
 *     Add global hard_bounce suppressions via the audited service.
 *  2. The "TEST Gmail verification" launch (spec 091 channel test) is live
 *     and pollutes all-cohort metrics. Soft-archive the launch + prospects. */
import "dotenv/config";
import { sql } from "@/db/client";
import { suppress } from "@/lib/outreach/suppression";

const BOUNCED: Record<string, string> = {
  "patrick@southern.properties": "hard_bounce 2026-08-25: domain does not exist (Perplexity-fabricated address)",
  "dale.fior@bhsusa.com": "hard_bounce 2026-08-25: mailbox not found (pattern-guessed address)",
  "info@kghometeam.com": "hard_bounce 2026-08-25: Google Group rejects external senders",
};

async function main(): Promise<void> {
  const [u] = await sql`select id from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");

  await sql.begin(async (tx) => {
    for (const [email, detail] of Object.entries(BOUNCED)) {
      const r = await suppress(tx, { scope: "email", value: email, reason: "hard_bounce", detail, projectId: null, userId: u.id as string });
      console.log(`suppress ${email}: ${r.alreadySuppressed ? "already suppressed" : `added ${r.id}`}`);
    }
  });

  const launches = await sql`
    update market_launches set archived_at = now()
    where name = 'TEST Gmail verification' and archived_at is null
    returning id`;
  for (const l of launches) {
    const ps = await sql`
      update prospects set archived_at = now()
      where launch_id = ${l.id as string} and archived_at is null
      returning business_name`;
    console.log(`archived launch ${l.id}: ${ps.length} prospect(s): ${ps.map((p) => p.businessName).join(", ")}`);
  }
  if (launches.length === 0) console.log("TEST launch already archived");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
