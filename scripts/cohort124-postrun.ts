/**
 * Cohort-124 bootstrap postrun (2026-08-31): after a "Cohort 124 batch 1"
 * market benchmark completes, bind its launch's prospects to the run and
 * evaluate mismatch eligibility — link benchmark, score, generate findings,
 * approve a primary finding, then competitiveMismatchReview. Read-only
 * against outreach state; nothing sends.
 *
 * Run: npx tsx scripts/cohort124-postrun.ts            (all completed batch runs)
 *      npx tsx scripts/cohort124-postrun.ts --city Greenville
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { upsertCompany } from "@/lib/companies/service";
import {
  competitiveMismatchReview,
  mismatchStrength,
} from "@/lib/prospects/mismatch";
import { suggestCompanyForProspect, confirmCompanyLink } from "@/lib/prospects/discovery";
import * as svc from "@/lib/prospects/service";

const KIND_PREFERENCE = [
  "authority_visibility_gap",
  "absence",
  "competitor_contrast",
  "citation_gap",
];

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

async function main(): Promise<void> {
  const user = await operatorUser();
  const cityFilter = (() => {
    const i = process.argv.indexOf("--city");
    return i >= 0 ? process.argv[i + 1]! : null;
  })();

  const runs = await sql`
    select r.id, r.label, r.project_id, r.completed_at
    from runs r
    where r.label like 'Cohort 124 batch 1:%' and r.completed_at is not null
    order by r.completed_at asc
  `;
  const summary: string[] = [];
  for (const run of runs) {
    const city = (run.label as string).replace("Cohort 124 batch 1:", "").split(",")[0]!.trim();
    if (cityFilter && city.toLowerCase() !== cityFilter.toLowerCase()) continue;
    // The launch whose prospects this run benchmarks: its market is tracked
    // as the project's market via the bootstrap; resolve by city name +
    // launch created for this cohort (state-aware names guaranteed by the
    // driver: either "City — luxury residential" (fresh install) or
    // "City ST — luxury residential" (collision fallback)).
    const stateToken = (run.label as string).split(",")[1]?.trim() ?? "";
    const [launch] = await sql`
      select l.id, l.name from market_launches l
      join markets m on m.id = l.market_id
      where l.archived_at is null
        and lower(m.name) = ${city.toLowerCase()}
        and m.state_code = ${stateToken}
      order by l.created_at desc limit 1
    `;
    if (!launch) {
      console.log(`${city}: no launch resolved — SKIPPED`);
      continue;
    }
    // The worker's compute_scores job sits behind a deep parse backlog;
    // linkBenchmark requires scores rows, so compute here (same handler,
    // idempotent) once the run's responses are parsed.
    const { computeScores } = await import("@/lib/scoring/compute");
    await computeScores(run.id as string);
    const prospects = await sql`
      select p.id, p.business_name, p.company_id from prospects p
      where p.launch_id = ${launch.id} and p.archived_at is null and not p.do_not_contact
    `;
    let eligible = 0;
    let strong = 0;
    const reasons = new Map<string, number>();
    for (const p of prospects) {
      if (!p.companyId) {
        const suggestion = await suggestCompanyForProspect(p.id as string);
        let companyId = suggestion?.verdict === "match" ? suggestion.companyId : null;
        if (!companyId) {
          const minted = await upsertCompany(user, { name: p.businessName as string, aliases: [] });
          if (minted.ok) companyId = minted.data.id as string;
        }
        if (companyId) await confirmCompanyLink(user, { prospectId: p.id as string, companyId });
      }
      let benchmarkId: string | null = null;
      const link = await svc.linkBenchmark(user, { prospectId: p.id as string, runId: run.id as string });
      if (link.ok) benchmarkId = link.data.benchmarkId as string;
      else {
        const [existing] = await sql`
          select id from prospect_benchmarks where prospect_id = ${p.id} and run_id = ${run.id}`;
        benchmarkId = (existing?.id as string | undefined) ?? null;
      }
      if (!benchmarkId) {
        console.log(`  ${p.businessName}: benchmark link failed — ${link.ok ? "?" : link.error.message}`);
        continue;
      }
      await svc.computeProspectScore(user, { prospectId: p.id as string });
      const gen = await svc.generateFindings(user, { benchmarkId });
      if (gen.ok) {
        const cands = await sql`
          select id, kind from prospect_findings
          where prospect_id = ${p.id} and benchmark_id = ${benchmarkId} and status = 'candidate'
          order by created_at desc`;
        const pick = KIND_PREFERENCE.map((k) => cands.find((c) => c.kind === k)).find(Boolean);
        if (pick) {
          await svc.reviewFinding(user, { findingId: pick.id as string, decision: "approved", makePrimary: true });
        }
      }
      const review = await competitiveMismatchReview(p.id as string);
      const e = review?.evaluation;
      if (e?.eligible && e.selected) {
        eligible += 1;
        const s = mismatchStrength(e.selected);
        if (s === "strong") strong += 1;
        console.log(
          `  ELIGIBLE[${s}] ${p.businessName} vs ${e.selected.displayName} ` +
            `(recs ${review!.prospect.recommendationCount}→${e.selected.recommendationCount} of ${review!.benchmark!.answerCount})`
        );
      } else {
        for (const code of e?.reasonCodes ?? ["NO_REVIEW"]) {
          reasons.set(code, (reasons.get(code) ?? 0) + 1);
        }
      }
    }
    const reasonStr = [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(" ");
    summary.push(`${city}: ${prospects.length} prospects → ${eligible} eligible (${strong} strong) | ${reasonStr}`);
    console.log(`=== ${city} done: ${eligible}/${prospects.length} eligible (${strong} strong)`);
  }
  console.log("\nSUMMARY:");
  for (const s of summary) console.log("  " + s);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
