/**
 * Spec 124 phase 22/24/25 — evaluate competitive-mismatch eligibility across
 * current prospects and produce the operator's send-ready review queue.
 * Read-only against outreach state: no drafts are generated, nothing sends.
 *
 * Outputs:
 * - funnel counts (verified production → benchmark coverage → inversion →
 *   eligible) and ineligibility tallies;
 * - the send-ready queue, strongest first, with rendered Touch-1 emails,
 *   written to .local-data/realtrends/send-queue.json (gitignored — it
 *   embeds licensed production values);
 * - the minimum benchmark-refresh queue: prospects whose ONLY remaining
 *   blocker is benchmark staleness while a clean production inversion
 *   already exists. Refreshes are listed, never launched — budget stays
 *   with the operator.
 *
 * Run: npx tsx scripts/mismatch-backfill.ts
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import {
  competitiveMismatchReview,
  mismatchStrength,
  formatProductionDisplay,
  type MismatchReasonCode,
} from "@/lib/prospects/mismatch";
import { generateCompetitiveMismatchEmail } from "@/lib/prospects/outreach";

const BENCHMARK_CODES: MismatchReasonCode[] = [
  "BENCHMARK_TOO_OLD",
  "NO_BENCHMARK",
  "BENCHMARK_SCOPE_INVALID",
  "CHATGPT_DATA_UNAVAILABLE",
];
const RECOMMENDATION_CODES: MismatchReasonCode[] = [
  "NO_HIGHER_RECOMMENDATION_COMPETITOR",
  "RECOMMENDATION_GAP_TOO_SMALL",
];

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
  let verifiedProduction = 0;
  let benchmarkCurrent = 0;
  let productionInversion = 0;
  const queue: Record<string, unknown>[] = [];
  const refresh: string[] = [];
  for (const p of prospects) {
    const review = await competitiveMismatchReview(p.id as string);
    if (!review) continue;
    const e = review.evaluation;
    const hasProduction =
      review.prospect.production !== null &&
      review.prospect.production.productionYear !== null;
    if (hasProduction) verifiedProduction += 1;
    const benchmarkOk =
      review.benchmark !== null &&
      review.benchmark.answerCount > 0 &&
      e.benchmarkAgeDays !== null &&
      e.benchmarkAgeDays <= MISMATCH_THRESHOLDS.maxBenchmarkAgeDays;
    if (benchmarkOk) benchmarkCurrent += 1;
    // A clean production inversion = some candidate whose only failures (if
    // any) are on the recommendation side.
    const inversion = e.candidates.some((c) =>
      c.reasonCodes.every((code) => RECOMMENDATION_CODES.includes(code))
    );
    if (hasProduction && inversion) productionInversion += 1;

    if (e.eligible && e.selected) {
      const c = e.selected;
      const draft = generateCompetitiveMismatchEmail(review, c);
      const pv = review.prospect.production!;
      const cv = c.production!;
      const metric = c.metricType!;
      const pVal = metric === "closed_volume" ? pv.volumeUsd : pv.sides;
      const cVal = metric === "closed_volume" ? cv.volumeUsd : cv.sides;
      queue.push({
        strength: mismatchStrength(c),
        prospect: p.businessName,
        prospectId: p.id,
        contacted: p.contacted,
        market: review.marketName,
        reportingYear: pv.productionYear,
        prospectProduction: formatProductionDisplay(metric, pVal),
        competitor: c.displayName,
        competitorProduction: formatProductionDisplay(metric, cVal),
        productionGap: metric === "closed_volume" ? pVal - cVal : null,
        productionGapPct: Math.round((1 - (c.productionRatio ?? 1)) * 100),
        prospectRecs: review.prospect.recommendationCount,
        competitorRecs: c.recommendationCount,
        denominator: review.benchmark!.answerCount,
        recommendationGap: c.recommendationGap,
        benchmarkCapturedAt: review.benchmark!.capturedAt,
        scope: review.scopeCopy,
        subject: draft.subject,
        body: draft.body,
        qaStatus:
          "eligibility validated; full draft QA (claims re-proven) runs at approval and dispatch",
      });
    } else {
      for (const code of e.reasonCodes) {
        reasonTally.set(code, (reasonTally.get(code) ?? 0) + 1);
      }
      const onlyBenchmarkBlocked =
        e.reasonCodes.length > 0 &&
        e.reasonCodes.every((code) => BENCHMARK_CODES.includes(code));
      if (hasProduction && inversion && onlyBenchmarkBlocked) {
        refresh.push(`${p.launchName} · ${p.businessName} (${p.id})`);
      }
    }
  }

  queue.sort(
    (a, b) =>
      (a.strength === b.strength ? 0 : a.strength === "strong" ? -1 : 1) ||
      (b.recommendationGap as number) - (a.recommendationGap as number)
  );
  for (const q of queue) {
    console.log(
      `${String(q.strength).toUpperCase().padEnd(6)} ${q.market} · ${q.prospect} vs ${q.competitor}` +
        ` · RT ${q.prospectProduction} vs ${q.competitorProduction} (${q.productionGapPct}% less)` +
        ` · OpenAI ${q.prospectRecs}→${q.competitorRecs} of ${q.denominator} (gap +${q.recommendationGap})` +
        ` · "${q.subject}"${q.contacted ? " · ALREADY CONTACTED (follow-up angle only)" : ""}`
    );
  }
  mkdirSync(".local-data/realtrends", { recursive: true });
  writeFileSync(
    ".local-data/realtrends/send-queue.json",
    JSON.stringify(queue, null, 2)
  );
  console.log(`\nSend-ready queue written to .local-data/realtrends/send-queue.json`);

  console.log(`\nProspects evaluated: ${prospects.length}`);
  console.log(`With verified production: ${verifiedProduction}`);
  console.log(`With current OpenAI benchmark: ${benchmarkCurrent}`);
  console.log(`With production/recommendation inversion candidate: ${productionInversion}`);
  console.log(`Eligible: ${queue.length}`);
  console.log(`Ineligible: ${prospects.length - queue.length}`);
  console.log(`\nTop reasons:`);
  for (const [code, n] of [...reasonTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${code}: ${n}`);
  }
  if (refresh.length > 0) {
    console.log(
      `\nBenchmark-refresh queue (${refresh.length} — inversion ready, benchmark stale; not launched):`
    );
    for (const r of refresh) console.log(`  ${r}`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
