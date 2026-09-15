/**
 * Supply engine binding (2026-09-14): bind promoted prospects to their
 * market's freshest completed benchmark run so competitiveMismatchReview
 * can read counts — the same steps the pipeline's scoring stage and the
 * cohort-124 postrun perform (link → prospect score → findings → approve
 * the primary finding), scoped to the prospect ids given. Idempotent:
 * an existing link or primary finding is reused. Nothing sends.
 *
 * Run: DATABASE_URL=<direct url> npx tsx scripts/supply-bind.ts --prospects <id,id,...>
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { competitiveMismatchReview, mismatchStrength } from "@/lib/prospects/mismatch";
import * as svc from "@/lib/prospects/service";
import { computeScores } from "@/lib/scoring/compute";

const KIND_PREFERENCE = ["authority_visibility_gap", "absence", "competitor_contrast"];
const scoredRuns = new Set<string>();

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

/** The run to bind: any completed run on the launch's market benchmark
 * project (not only already-linked ones), preferring a COMPLETE OpenAI
 * answer set (spec 136 blocks incomplete runs) and then the freshest;
 * never while a run on that project is in flight. */
async function freshestRunForLaunch(launchId: string): Promise<string | null> {
  const [proj] = await sql`
    select r.project_id from prospects p join prospect_benchmarks pb on pb.prospect_id = p.id join runs r on r.id = pb.run_id
    where p.launch_id = ${launchId} order by r.completed_at desc nulls last limit 1`;
  if (!proj) return null;
  const [inFlight] = await sql`select 1 from runs where project_id = ${proj.projectId} and status in ('pending','running') limit 1`;
  if (inFlight) return null;
  const [r] = await sql`
    select r.id, (select count(*)::int from responses x where x.run_id = r.id and x.provider = 'openai' and x.error is null) as answers
    from runs r where r.project_id = ${proj.projectId} and r.completed_at is not null
    order by answers desc, r.completed_at desc limit 1`;
  return (r?.id as string | undefined) ?? null;
}

async function bind(user: CurrentUser, prospectId: string): Promise<string> {
  const [p] = await sql`select business_name, launch_id, company_id from prospects where id = ${prospectId} and archived_at is null`;
  if (!p) return `${prospectId}: not found`;
  if (!p.companyId) return `${p.businessName as string}: no company link (identity review) — skipped`;
  const runId = await freshestRunForLaunch(p.launchId as string);
  if (!runId) return `${p.businessName as string}: no completed run for the launch (or one in flight) — skipped`;
  // A company attached after the run (backfill re-parse) has responses but
  // no scores rows until scoring runs again; idempotent, same handler as the
  // worker — computed once per run per process (it is the expensive step).
  if (!scoredRuns.has(runId)) { await computeScores(runId); scoredRuns.add(runId); }
  let benchmarkId: string | null = null;
  const link = await svc.linkBenchmark(user, { prospectId, runId });
  if (link.ok) benchmarkId = link.data.benchmarkId;
  else {
    const [existing] = await sql`select id from prospect_benchmarks where prospect_id = ${prospectId} and run_id = ${runId}`;
    benchmarkId = (existing?.id as string | undefined) ?? null;
  }
  if (!benchmarkId) return `${p.businessName as string}: link failed — ${link.ok ? "?" : link.error.message}`;
  await svc.computeProspectScore(user, { prospectId });
  const [primary] = await sql`select id from prospect_findings where prospect_id = ${prospectId} and benchmark_id = ${benchmarkId} and status = 'approved' limit 1`;
  if (!primary) {
    const gen = await svc.generateFindings(user, { benchmarkId });
    if (gen.ok) {
      const cands = await sql`select id, kind from prospect_findings where prospect_id = ${prospectId} and benchmark_id = ${benchmarkId} and status = 'candidate' order by created_at desc`;
      const pick = KIND_PREFERENCE.map((k) => cands.find((c) => c.kind === k)).find(Boolean);
      if (pick) await svc.reviewFinding(user, { findingId: pick.id as string, decision: "approved", makePrimary: true });
    }
  }
  const review = await competitiveMismatchReview(prospectId, { now: new Date() });
  const e = review?.evaluation;
  if (e?.eligible && e.selected) {
    return `${p.businessName as string}: ELIGIBLE[${mismatchStrength(e.selected)}] vs ${e.selected.displayName} (${review!.prospect.recommendationCount}→${e.selected.recommendationCount} of ${review!.benchmark!.answerCount})`;
  }
  return `${p.businessName as string}: not eligible — ${(e?.reasonCodes ?? ["NO_REVIEW"]).join(",")}`;
}

async function main(): Promise<void> {
  const ids = (arg("--prospects") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("--prospects <id,...> is required");
  const user = await operatorUser();
  for (const id of ids) console.log(await bind(user, id));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
