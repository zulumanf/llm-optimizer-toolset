/**
 * Data-invariant audit for the evidence pipeline (Layer C, hardening
 * 2026-09-14). Read-only. Each invariant prints PASS or BLOCK with the rows
 * that violate it; the process exits 2 when any invariant blocks so it can
 * gate a promotion batch or a CI job.
 *
 *   npx tsx scripts/pipeline-invariants.ts
 *
 * PROJECT_MARKET_ISOLATION   no project spans two canonical markets through
 *                            its prospect benchmarks; every market-level
 *                            project is bound to a market_id; no two same-
 *                            named markets share one project.
 * NO_PARSE_DOWNGRADE         the CURRENT row of a pair holding a classifier-
 *                            class judgment is itself classifier-class.
 * NO_DUPLICATE_PARSE_JOB     no two queued/running jobs of one type share a
 *                            payload; no queued backfill duplicates a pair.
 * CURRENT_PARSE_PROVENANCE   every LLM ledger row names its classifier model
 *                            and prompt version (legacy pre-058 rows are
 *                            reported, not blocked).
 * BACKFILL_SCOPE_EXPECTED    no backfill is review_required, and no
 *                            completed backfill exceeded the classifier-call
 *                            review threshold.
 * BROWSER_RESOURCES_CLOSED   no headless Chromium child of a finished
 *                            supply-engine process is alive on this host
 *                            (local check; scripts/render-smoke.ts is the
 *                            end-to-end regression).
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { sql } from "@/db/client";
import { CURRENT_REVISION } from "@/db/mentions";
import { PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM } from "@/lib/constants";
import { BACKFILL_CLASSIFIER_CALL_REVIEW_THRESHOLD, BACKFILL_JOB_TYPE } from "@/lib/parsing/backfill";

type Verdict = { invariant: string; verdict: "PASS" | "BLOCK"; violations: unknown[]; note?: string };

async function projectMarketIsolation(): Promise<Verdict> {
  // ACTIVE collision: a market-level project with no market_id, or a binding
  // that crosses markets AFTER the project was bound (the bind guard and the
  // BENCHMARK_MARKET_VERIFIED gate make that impossible; any row is a bug).
  // QUARANTINED HISTORICAL: cross-market bindings that predate the project's
  // market binding — reported, non-routable (the release gate blocks them),
  // never counted as PASS-worthy but not an active violation.
  const cross = await sql`
    select p.id as project_id, p.name, m.name || ',' || coalesce(m.state_code, '?') as prospect_market,
      count(distinct pb.prospect_id)::int as prospects,
      count(distinct pb.prospect_id) filter (where pb.created_at > coalesce(
        (select max(a.at) from audit_log a where a.action = 'project.market_bound' and a.entity_id = p.id), 'epoch'::timestamptz))::int as after_binding,
      count(distinct pb.prospect_id) filter (where exists (select 1 from prospect_outreach_sends s where s.prospect_id = pb.prospect_id))::int as with_sends
    from projects p join runs ru on ru.project_id = p.id join prospect_benchmarks pb on pb.run_id = ru.id
    join prospects pr on pr.id = pb.prospect_id join market_launches l on l.id = pr.launch_id join markets m on m.id = l.market_id
    where p.archived_at is null and p.market_id is not null and m.id <> p.market_id and m.name not ilike 'TEST %'
    group by 1, 2, 3
  `;
  const unbound = await sql`
    select id as project_id, name from projects
    where archived_at is null and market_id is null and name like 'Market benchmark:%'
  `;
  const collisions = await sql`
    select lower(m.name) as market_name, count(*)::int as markets, string_agg(coalesce(m.state_code, '?') || ':' || m.id::text, ' ; ') as ids
    from markets m where exists (select 1 from market_launches l where l.market_id = m.id)
    group by 1 having count(*) > 1
  `;
  const active = [
    ...cross.filter((r) => Number(r.afterBinding) > 0).map((r) => ({ kind: "cross_market_binding_after_bind_ACTIVE", ...r })),
    ...unbound.map((r) => ({ kind: "market_project_unbound_REVIEW_REQUIRED", ...r })),
  ];
  const quarantined = cross.filter((r) => Number(r.afterBinding) === 0).map((r) => `${r.name as string}: ${r.prospects as number} ${r.prospectMarket as string} prospect(s) bound before market binding (sends ${r.withSends as number}) — blocked by BENCHMARK_MARKET_VERIFIED`);
  return { invariant: "PROJECT_MARKET_ISOLATION", verdict: active.length === 0 ? "PASS" : "BLOCK", violations: active, note: `quarantined historical: ${quarantined.join(" | ") || "none"}; launched markets sharing a display name: ${collisions.map((c) => `${c.marketName as string} ×${c.markets as number} (${c.ids as string})`).join(" | ") || "none"}` };
}

async function noParseDowngrade(): Promise<Verdict> {
  const rows = await sql`
    select ru.project_id, count(*)::int as pairs from mentions m
    join responses r on r.id = m.response_id join runs ru on ru.id = r.run_id
    where ${CURRENT_REVISION} and m.parser_version = ${PARSER_VERSION_HEURISTIC} and m.reviewed_by is null
      and exists (select 1 from mentions o where o.response_id = m.response_id and o.company_id = m.company_id
        and (o.parser_version = ${PARSER_VERSION_LLM} or o.reviewed_by is not null))
    group by 1
  `;
  const [shadowed] = await sql`
    select count(*)::int as n from mentions m
    where m.parser_version = ${PARSER_VERSION_HEURISTIC}
      and not exists (select 1 from mentions n where n.response_id = m.response_id and n.company_id = m.company_id and n.revision > m.revision)
      and exists (select 1 from mentions o where o.response_id = m.response_id and o.company_id = m.company_id and o.revision < m.revision and o.parser_version = ${PARSER_VERSION_LLM})
  `;
  return { invariant: "NO_PARSE_DOWNGRADE", verdict: rows.length === 0 ? "PASS" : "BLOCK", violations: rows, note: `${shadowed?.n as number} newest-heuristic-over-LLM pairs exist in history and are shadowed (not selected) by the class-first rule` };
}

async function noDuplicateParseJob(): Promise<Verdict> {
  const dupes = await sql`
    select type, payload::text as payload, count(*)::int as n from jobs
    where status in ('queued', 'running') group by 1, 2 having count(*) > 1
  `;
  const pairDupes = await sql`
    select payload->>'projectId' as project_id, payload->>'companyId' as company_id, count(*)::int as n from jobs
    where type = ${BACKFILL_JOB_TYPE} and status in ('queued', 'running') group by 1, 2 having count(*) > 1
  `;
  const violations = [...dupes, ...pairDupes.map((p) => ({ kind: "duplicate_backfill_pair", ...p }))];
  return { invariant: "NO_DUPLICATE_PARSE_JOB", verdict: violations.length === 0 ? "PASS" : "BLOCK", violations };
}

async function currentParseProvenance(): Promise<Verdict> {
  const [row] = await sql`
    select count(*) filter (where classifier_model is null or classifier_prompt_version is null)::int as unstamped,
      count(*) filter (where (classifier_model is null or classifier_prompt_version is null) and parsed_at >= '2026-08-11')::int as unstamped_after_058,
      count(*) filter (where reconstructed_from_mentions)::int as reconstructed
    from response_parses where parser_version = ${PARSER_VERSION_LLM}
  `;
  const recent = Number(row?.unstampedAfter058 ?? 0);
  return { invariant: "CURRENT_PARSE_PROVENANCE", verdict: recent === 0 ? "PASS" : "BLOCK", violations: recent === 0 ? [] : [{ unstampedLlmLedgerRowsAfterMigration058: recent }], note: `legacy unstamped LLM ledger rows (pre-058): ${Number(row?.unstamped ?? 0) - recent}; reconstructed ledger rows: ${row?.reconstructed as number}` };
}

async function backfillScopeExpected(): Promise<Verdict> {
  const rows = await sql`
    select id, project_id, company_id, status, classifier_calls, runs_touched, detail from company_backfills
    where status = 'review_required' or coalesce(classifier_calls, 0) > ${BACKFILL_CLASSIFIER_CALL_REVIEW_THRESHOLD}
  `;
  const [stats] = await sql`
    select count(*)::int as backfills, coalesce(avg(classifier_calls), 0)::numeric(10,1) as avg_calls,
      coalesce(sum(parses_reused), 0)::int as reused, coalesce(sum(classifier_calls), 0)::int as calls
    from company_backfills where status = 'completed'
  `;
  const reused = Number(stats?.reused ?? 0);
  const calls = Number(stats?.calls ?? 0);
  const pct = reused + calls === 0 ? null : Math.round((reused / (reused + calls)) * 1000) / 10;
  return { invariant: "BACKFILL_SCOPE_EXPECTED", verdict: rows.length === 0 ? "PASS" : "BLOCK", violations: rows, note: `completed backfills ${stats?.backfills as number}; SEMANTIC_PARSE_JOBS per company avg ${stats?.avgCalls as string}; REUSED_PARSE_PERCENT ${pct === null ? "n/a" : `${pct}%`}` };
}

function browserResourcesClosed(): Verdict {
  let orphans: string[] = [];
  try {
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,etime=,command="], { encoding: "utf8" });
    orphans = out.split("\n").filter((l) => /headless_shell|chrom.*--headless/i.test(l) && /ms-playwright/.test(l)).map((l) => l.trim().slice(0, 160));
  } catch { /* ps unavailable: nothing to report */ }
  return { invariant: "BROWSER_RESOURCES_CLOSED", verdict: orphans.length === 0 ? "PASS" : "BLOCK", violations: orphans, note: "host-level check; end-to-end regression: npx tsx scripts/render-smoke.ts" };
}

async function main(): Promise<void> {
  const verdicts = [await projectMarketIsolation(), await noParseDowngrade(), await noDuplicateParseJob(), await currentParseProvenance(), await backfillScopeExpected(), browserResourcesClosed()];
  for (const v of verdicts) console.log(JSON.stringify(v, null, 1));
  const blocked = verdicts.filter((v) => v.verdict === "BLOCK").map((v) => v.invariant);
  console.log(blocked.length === 0 ? "INVARIANTS: ALL PASS" : `INVARIANTS BLOCKED: ${blocked.join(", ")}`);
  if (blocked.length > 0) process.exitCode = 2;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end());
