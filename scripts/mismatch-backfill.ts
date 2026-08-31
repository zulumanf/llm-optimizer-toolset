/**
 * Spec 124 phase 22 — evaluate competitive-mismatch eligibility across
 * current prospects. Read-only: no drafts are generated, nothing is sent.
 * Prints eligible prospects (with their best comparison), already-contacted
 * prospects where the angle could inform a future follow-up, and the
 * rejection-reason tally that tells us which data gap to close next.
 *
 * Run: npx tsx scripts/mismatch-backfill.ts
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { competitiveMismatchReview } from "@/lib/prospects/mismatch";

async function main(): Promise<void> {
  const prospects = await sql`
    select p.id, p.business_name, l.name as launch_name,
      exists (select 1 from prospect_outreach_sends s
        where s.prospect_id = p.id and s.allowed) as contacted
    from prospects p
    join market_launches l on l.id = p.launch_id
    where p.archived_at is null
    order by l.name, p.business_name
  `;
  const reasonTally = new Map<string, number>();
  let eligible = 0;
  let ineligible = 0;
  const lines: string[] = [];
  for (const p of prospects) {
    const review = await competitiveMismatchReview(p.id as string);
    if (!review) continue;
    const e = review.evaluation;
    if (e.eligible && e.selected) {
      eligible += 1;
      const tag = p.contacted ? "already contacted — follow-up angle only" : "READY (unsent)";
      lines.push(
        `ELIGIBLE  ${p.launchName} · ${p.businessName} vs ${e.selected.displayName}` +
          ` · recs ${review.prospect.recommendationCount}→${e.selected.recommendationCount}` +
          ` of ${review.benchmark?.answerCount} · ${tag}`
      );
    } else {
      ineligible += 1;
      for (const code of e.reasonCodes) {
        reasonTally.set(code, (reasonTally.get(code) ?? 0) + 1);
      }
    }
  }
  for (const line of lines) console.log(line);
  console.log(`\nProspects evaluated: ${prospects.length}`);
  console.log(`Eligible: ${eligible}`);
  console.log(`Ineligible: ${ineligible}`);
  console.log(`\nTop reasons:`);
  for (const [code, n] of [...reasonTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${code}: ${n}`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
