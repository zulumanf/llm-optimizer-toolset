/**
 * Paused parse-job classification and bounded release (2026-09-14).
 *
 * Every paused `parse_response` job (run_after pushed > 1 day out) is
 * classified under the hardened architecture before anything resumes:
 *
 *   INVALID_RESPONSE          payload response no longer exists
 *   LEGACY_PROJECT_AMBIGUOUS  run's project is a market benchmark with no market_id
 *   STALE_SUPERSEDED          a newer job for the same response already finished
 *   NO_OP_LEDGER_REUSE        active-version ledger row present → parseResponse returns at once
 *   NO_OP_LEDGER_RECONSTRUCT  classifier revisions exist, ledger missing → reconstructed, no classifier
 *   ENTITY_RESOLUTION_ONLY    empty/errored answer → heuristic stamp, no candidate, no classifier
 *   CANONICAL_CLASSIFIER_REQUIRED  never parsed / heuristic-only → needs the classifier (provider gate)
 *
 *   npx tsx scripts/paused-jobs-release.ts                         # classify (read-only)
 *   npx tsx scripts/paused-jobs-release.ts --release NO_OP_LEDGER_REUSE --limit 5
 *   npx tsx scripts/paused-jobs-release.ts --report                # economics of resumed jobs
 *
 * --release resumes ONLY the named category, oldest first, up to --limit,
 * and refuses CANONICAL_CLASSIFIER_REQUIRED unless --provider-available is
 * passed after a fresh preflight. Nothing else about the jobs changes.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { PARSER_VERSION_LLM } from "@/lib/constants";

export const PAUSED_CATEGORIES = [
  "INVALID_RESPONSE", "LEGACY_PROJECT_AMBIGUOUS", "STALE_SUPERSEDED", "NO_OP_LEDGER_REUSE",
  "NO_OP_LEDGER_RECONSTRUCT", "ENTITY_RESOLUTION_ONLY", "CANONICAL_CLASSIFIER_REQUIRED",
] as const;
export type PausedCategory = (typeof PAUSED_CATEGORIES)[number];

const RELEASE_MARK = "RELEASED by paused-jobs-release";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** One deterministic SQL classification; the case order IS the precedence. */
const classified = sql`
  with paused as (
    select j.id, j.created_at, (j.payload->>'responseId')::uuid as rid
    from jobs j where j.type = 'parse_response' and j.status = 'queued' and j.run_after > now() + interval '1 day'
  )
  select p.id, p.created_at, ru.project_id, pr.name as project_name,
    case
      when r.id is null then 'INVALID_RESPONSE'
      when pr.market_id is null and pr.name like 'Market benchmark:%' then 'LEGACY_PROJECT_AMBIGUOUS'
      when exists (select 1 from jobs d where d.type = 'parse_response' and d.status = 'done' and (d.payload->>'responseId')::uuid = p.rid and d.created_at > p.created_at) then 'STALE_SUPERSEDED'
      when exists (select 1 from response_parses rp where rp.response_id = p.rid and rp.parser_version = ${PARSER_VERSION_LLM}) then 'NO_OP_LEDGER_REUSE'
      when exists (select 1 from mentions m where m.response_id = p.rid and m.parser_version = ${PARSER_VERSION_LLM}) then 'NO_OP_LEDGER_RECONSTRUCT'
      when r.error is not null or length(coalesce(r.response_text, '')) = 0 then 'ENTITY_RESOLUTION_ONLY'
      else 'CANONICAL_CLASSIFIER_REQUIRED'
    end as category
  from paused p
  left join responses r on r.id = p.rid left join runs ru on ru.id = r.run_id left join projects pr on pr.id = ru.project_id
`;

async function classify(): Promise<void> {
  const rows = await sql`select category, project_name, count(*)::int as n from (${classified}) c group by 1, 2 order by 3 desc`;
  const total = rows.reduce((n, r) => n + Number(r.n), 0);
  console.log(JSON.stringify({ pausedTotal: total, byCategory: rows.map((r) => ({ category: r.category, project: r.projectName, jobs: r.n })) }, null, 1));
}

async function release(category: PausedCategory, limit: number): Promise<void> {
  if (category === "CANONICAL_CLASSIFIER_REQUIRED" && !process.argv.includes("--provider-available")) {
    console.log("REFUSED: CANONICAL_CLASSIFIER_REQUIRED resumes only with --provider-available after a fresh scripts/provider-preflight.ts --force shows AVAILABLE");
    process.exitCode = 2; return;
  }
  if (category === "INVALID_RESPONSE" || category === "LEGACY_PROJECT_AMBIGUOUS" || category === "STALE_SUPERSEDED") {
    console.log(`REFUSED: ${category} is never resumed (invalid, ambiguous, or superseded work)`);
    process.exitCode = 2; return;
  }
  const rows = await sql`
    update jobs set run_after = now(), last_error = ${`${RELEASE_MARK} (${category}) ${new Date().toISOString()}`}
    where id in (select id from (${classified}) c where c.category = ${category} order by c.created_at asc limit ${limit})
    returning id
  `;
  console.log(JSON.stringify({ released: { category, jobs: rows.length } }, null, 1));
}

/** Economics of released jobs: outcome, ledger effect, classifier calls, wall time. */
async function report(): Promise<void> {
  const [j] = await sql`
    select count(*)::int as released,
      count(*) filter (where status = 'done')::int as done,
      count(*) filter (where status = 'queued')::int as still_queued,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'done' and exists (select 1 from response_parses rp where rp.response_id = (payload->>'responseId')::uuid and rp.parser_version = ${PARSER_VERSION_LLM} and rp.reconstructed_from_mentions and rp.parsed_at >= jobs.created_at))::int as reconstructed_by_job,
      count(*) filter (where status = 'done' and exists (select 1 from mentions m where m.response_id = (payload->>'responseId')::uuid and m.created_at > locked_at - interval '5 minutes' and m.parser_version like '%heuristic'))::int as heuristic_written,
      count(*) filter (where status = 'done' and exists (select 1 from mentions m where m.response_id = (payload->>'responseId')::uuid and m.created_at > locked_at - interval '5 minutes' and m.parser_version = ${PARSER_VERSION_LLM}))::int as classifier_written,
      min(locked_at) as first_started, max(locked_at) as last_started
    from jobs where type = 'parse_response' and last_error like ${RELEASE_MARK + "%"}
  `;
  const [q] = await sql`select count(*)::int as depth from jobs where status = 'queued' and run_after <= now()`;
  const [hb] = await sql`select worker_id, version, last_seen_at, jobs_processed from worker_heartbeats order by last_seen_at desc limit 1`;
  const wall = j?.firstStarted && j?.lastStarted ? (new Date(j.lastStarted as string).getTime() - new Date(j.firstStarted as string).getTime()) / 1000 : null;
  console.log(JSON.stringify({ released: j, queueDepthNow: q?.depth, wallSecondsFirstToLastStart: wall, worker: hb }, null, 1));
}

async function main(): Promise<void> {
  const cat = arg("--release") as PausedCategory | null;
  if (process.argv.includes("--report")) { await report(); return; }
  await classify();
  if (cat) {
    if (!PAUSED_CATEGORIES.includes(cat)) throw new Error(`unknown category ${cat}`);
    await release(cat, Number(arg("--limit") ?? "5"));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end());
