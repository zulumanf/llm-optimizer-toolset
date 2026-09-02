/**
 * Cohort-124 phase 1 (2026-08-31): finish the existing eleven.
 * A) Promote + parse the priority trio (Johnson Group, Judson R. Henderson,
 *    Deanna Anderson) into their markets' fresh runs — exact counts, no
 *    inference. B) Relink uncontacted prospects whose findings bind stale
 *    runs to the fresh run, score, stage + approve a primary finding, and
 *    re-run mismatch eligibility. Nothing sends.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { upsertCompany } from "@/lib/companies/service";
import { addCompetitor } from "@/lib/competitors/service";
import { parseCompanyIntoRun } from "@/lib/parsing/service";
import { confirmDatasetMatch } from "@/lib/prospects/realtrends-dataset";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import {
  competitiveMismatchReview,
  mismatchStrength,
} from "@/lib/prospects/mismatch";
import * as svc from "@/lib/prospects/service";

const KIND_PREFERENCE = ["authority_visibility_gap", "absence", "competitor_contrast", "citation_gap"];

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

async function freshRunForLaunchName(pattern: string): Promise<{ runId: string; projectId: string } | null> {
  const [r] = await sql`
    select r.id as run_id, r.project_id
    from market_launches l
    join prospects p on p.launch_id = l.id and p.archived_at is null
    join prospect_benchmarks pb on pb.prospect_id = p.id
    join runs r on r.id = pb.run_id
    where l.name ilike ${pattern} and r.completed_at is not null
    order by r.completed_at desc limit 1
  `;
  return r ? { runId: r.runId as string, projectId: r.projectId as string } : null;
}

const TRIO = [
  { name: "Johnson Group", aliases: ["The Johnson Group"], launch: "Savannah%", recordId: "fcb915da-9f86-4c8b-983f-54bf246bd094" },
  { name: "Judson R. Henderson", aliases: ["Judson Henderson"], launch: "Princeton%", recordId: "055159e8-b7c3-4b73-9f5f-232337f6886d" },
  { name: "Deanna Anderson", aliases: [], launch: "Princeton%", recordId: "178d3dfd-b161-4d27-aa02-dca4ffe378ad" },
];

async function main(): Promise<void> {
  const user = await operatorUser();

  if (process.argv.includes("--skip-trio")) console.log("(trio skipped)");
  else {
  console.log("=== A) trio promote + parse");
  for (const t of TRIO) {
    const run = await freshRunForLaunchName(t.launch);
    if (!run) { console.log(`${t.name}: no fresh run`); continue; }
    const company = await upsertCompany(user, { name: t.name, aliases: t.aliases });
    if (!company.ok) { console.log(`${t.name}: company FAILED — ${company.error.message}`); continue; }
    const companyId = company.data.id as string;
    await addCompetitor(user, { projectId: run.projectId, companyId, tier: "secondary" });
    const parsed = await parseCompanyIntoRun(run.runId, companyId);
    await confirmDatasetMatch(user, { recordId: t.recordId, companyId });
    const counts = await providerRecommendationCounts(run.runId, "openai", [companyId]);
    console.log(
      `${t.name}: hits ${parsed.hits}, inserted ${parsed.inserted}, recommended(raw) ${parsed.recommended}` +
        ` → OpenAI count ${counts.recommendedByCompany[companyId] ?? 0} of ${counts.answerCount}`
    );
  }

  }
  console.log("\n=== B) relink stale-bound uncontacted prospects");
  const rows = await sql`
    select p.id, p.business_name, p.launch_id, l.name as launch_name
    from prospects p join market_launches l on l.id = p.launch_id
    where p.archived_at is null and not p.do_not_contact
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed)
  `;
  for (const p of rows) {
    const before = await competitiveMismatchReview(p.id as string);
    const codes = before?.evaluation.reasonCodes ?? [];
    const staleOnly =
      codes.length > 0 &&
      codes.every((c) => ["BENCHMARK_TOO_OLD", "NO_BENCHMARK", "BENCHMARK_SCOPE_INVALID", "CHATGPT_DATA_UNAVAILABLE"].includes(c));
    if (!staleOnly) continue;
    const run = await freshRunForLaunchName((p.launchName as string).split(/[—–-]/)[0]!.trim() + "%");
    if (!run) { console.log(`${p.businessName}: no fresh run`); continue; }
    // Company link first where missing (benchmark data is company-keyed).
    const [pr] = await sql`select company_id, business_name from prospects where id = ${p.id}`;
    if (!pr?.companyId) {
      const { suggestCompanyForProspect, confirmCompanyLink } = await import("@/lib/prospects/discovery");
      const suggestion = await suggestCompanyForProspect(p.id as string);
      let companyId = suggestion?.verdict === "match" ? suggestion.companyId : null;
      if (!companyId) {
        const minted = await upsertCompany(user, { name: pr!.businessName as string, aliases: [] });
        if (minted.ok) companyId = minted.data.id as string;
      }
      if (companyId) await confirmCompanyLink(user, { prospectId: p.id as string, companyId });
      else { console.log(`${p.businessName}: no company link possible`); continue; }
    }
    let benchmarkId: string | null = null;
    const link = await svc.linkBenchmark(user, { prospectId: p.id as string, runId: run.runId });
    if (link.ok) benchmarkId = link.data.benchmarkId as string;
    else {
      const [existing] = await sql`
        select id from prospect_benchmarks where prospect_id = ${p.id} and run_id = ${run.runId}`;
      benchmarkId = (existing?.id as string | undefined) ?? null;
    }
    if (!benchmarkId) { console.log(`${p.businessName}: no benchmark link — ${link.ok ? "?" : link.error.message}`); continue; }
    await svc.computeProspectScore(user, { prospectId: p.id as string });
    const gen = await svc.generateFindings(user, { benchmarkId });
    if (!gen.ok) { console.log(`${p.businessName}: findings FAILED — ${gen.error.message}`); continue; }
    const cands = await sql`
      select id, kind from prospect_findings
      where prospect_id = ${p.id} and benchmark_id = ${benchmarkId} and status = 'candidate'
      order by created_at desc`;
    const pick = KIND_PREFERENCE.map((k) => cands.find((c) => c.kind === k)).find(Boolean);
    if (pick) {
      await svc.reviewFinding(user, { findingId: pick.id as string, decision: "approved", makePrimary: true });
    }
    const after = await competitiveMismatchReview(p.id as string);
    const e = after?.evaluation;
    console.log(
      `${p.businessName} (${p.launchName}): relinked → ` +
        (e?.eligible
          ? `ELIGIBLE ${mismatchStrength(e.selected!)} vs ${e.selected!.displayName} (${after!.prospect.recommendationCount}→${e.selected!.recommendationCount} of ${after!.benchmark!.answerCount})`
          : `still ineligible: ${e?.reasonCodes.join(", ")}`)
    );
  }
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
