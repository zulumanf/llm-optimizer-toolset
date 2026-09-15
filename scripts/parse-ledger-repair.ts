/**
 * Parse-ledger repair (pipeline hardening 2026-09-14). Deterministic, from
 * immutable history only — no classifier output is recreated.
 *
 * What the legacy delete-and-reparse backfill did: deleted response_parses
 * rows (the ledger) and re-classified; when the provider was blocked, the
 * re-classification appended heuristic revisions on top of LLM judgments.
 * The mentions table is insert-only, so every LLM judgment still exists.
 *
 * What this script does:
 *   audit   — per project/run: responses whose newest revision is heuristic
 *             while an older LLM revision exists (the downgrade blast radius),
 *             and whether the class-first CURRENT_REVISION rule now selects
 *             the LLM row for every such pair (it must: NO_PARSE_DOWNGRADE).
 *   repair  — reinsert the missing v2 ledger row for every response that has
 *             v2 mention revisions but no v2 response_parses row, stamped
 *             reconstructed_from_mentions = true, so the queue stops asking
 *             to re-classify answers that were already classified.
 *
 *   npx tsx scripts/parse-ledger-repair.ts                 # audit (read-only)
 *   npx tsx scripts/parse-ledger-repair.ts --apply         # audit + repair
 *   npx tsx scripts/parse-ledger-repair.ts --project <id>  # scope to one project
 *
 * Nothing in mentions is ever touched. In response_parses the writes are the
 * ledger insert (on conflict do nothing) and, for rows THIS repair
 * reconstructed with a null stamp, copying the classifier stamp from the
 * stamped revisions — a fact about existing rows, never new evidence.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM } from "@/lib/constants";
import { CURRENT_REVISION } from "@/db/mentions";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function audit(projectId: string | null): Promise<void> {
  const scope = projectId ? sql`and ru.project_id = ${projectId}` : sql``;
  const downgraded = await sql`
    with newest as (
      select m.response_id, m.company_id, m.parser_version, m.revision
      from mentions m
      where not exists (select 1 from mentions n where n.response_id = m.response_id and n.company_id = m.company_id and n.revision > m.revision)
    )
    select p.id as project_id, p.name, count(distinct newest.response_id)::int as responses, count(*)::int as pairs, count(distinct ru.id)::int as runs,
      min(cur.created_at)::date as first_at, max(cur.created_at)::date as last_at
    from newest
    join mentions cur on cur.response_id = newest.response_id and cur.company_id = newest.company_id and cur.revision = newest.revision
    join responses r on r.id = newest.response_id join runs ru on ru.id = r.run_id join projects p on p.id = ru.project_id
    where newest.parser_version = ${PARSER_VERSION_HEURISTIC}
      and exists (select 1 from mentions o where o.response_id = newest.response_id and o.company_id = newest.company_id and o.revision < newest.revision and o.parser_version = ${PARSER_VERSION_LLM})
      ${scope}
    group by 1, 2 order by 3 desc
  `;
  // NO_PARSE_DOWNGRADE: the selected (current) row of any pair that holds a
  // classifier-class row must itself be classifier-class.
  const [selected] = await sql`
    select count(*)::int as n from mentions m
    join responses r on r.id = m.response_id join runs ru on ru.id = r.run_id
    where ${CURRENT_REVISION} and m.parser_version = ${PARSER_VERSION_HEURISTIC} and m.reviewed_by is null
      and exists (select 1 from mentions o where o.response_id = m.response_id and o.company_id = m.company_id
        and (o.parser_version = ${PARSER_VERSION_LLM} or o.reviewed_by is not null))
      ${scope}
  `;
  const missingLedger = await sql`
    select p.id as project_id, p.name, count(distinct r.id)::int as responses
    from responses r join runs ru on ru.id = r.run_id join projects p on p.id = ru.project_id
    where exists (select 1 from mentions m where m.response_id = r.id and m.parser_version = ${PARSER_VERSION_LLM})
      and not exists (select 1 from response_parses rp where rp.response_id = r.id and rp.parser_version = ${PARSER_VERSION_LLM})
      ${scope}
    group by 1, 2 order by 3 desc
  `;
  console.log(JSON.stringify({
    downgradedHistory: downgraded.map((d) => ({ projectId: d.projectId, name: d.name, responses: d.responses, pairs: d.pairs, runs: d.runs, firstAt: d.firstAt, lastAt: d.lastAt })),
    NO_PARSE_DOWNGRADE: { selectedHeuristicOverClassifier: selected?.n ?? 0, verdict: Number(selected?.n ?? 0) === 0 ? "PASS" : "BLOCK" },
    missingLlmLedger: missingLedger.map((m) => ({ projectId: m.projectId, name: m.name, responses: m.responses })),
  }, null, 1));
}

async function repair(projectId: string | null): Promise<void> {
  const scope = projectId ? sql`and ru.project_id = ${projectId}` : sql``;
  const rows = await sql`
    insert into response_parses (response_id, run_id, parser_version, classifier_model, classifier_prompt_version, reconstructed_from_mentions)
    select r.id, r.run_id, ${PARSER_VERSION_LLM},
      (select m.classifier_model from mentions m where m.response_id = r.id and m.parser_version = ${PARSER_VERSION_LLM} order by (m.classifier_model is not null) desc, m.created_at desc limit 1),
      (select m.classifier_prompt_version from mentions m where m.response_id = r.id and m.parser_version = ${PARSER_VERSION_LLM} order by (m.classifier_prompt_version is not null) desc, m.created_at desc limit 1),
      true
    from responses r join runs ru on ru.id = r.run_id
    where exists (select 1 from mentions m where m.response_id = r.id and m.parser_version = ${PARSER_VERSION_LLM})
      and not exists (select 1 from response_parses rp where rp.response_id = r.id and rp.parser_version = ${PARSER_VERSION_LLM})
      ${scope}
    on conflict do nothing
    returning response_id
  `;
  // A reconstructed row that copied a null stamp while a stamped revision
  // exists gets the stamp — the stamp is a fact about the revisions, not new
  // evidence. Only reconstructed rows are ever touched.
  const restamped = await sql`
    update response_parses rp set
      classifier_model = s.model, classifier_prompt_version = s.prompt
    from (
      select m.response_id,
        max(m.classifier_model) filter (where m.classifier_model is not null) as model,
        max(m.classifier_prompt_version) filter (where m.classifier_prompt_version is not null) as prompt
      from mentions m where m.parser_version = ${PARSER_VERSION_LLM} group by m.response_id
    ) s
    where rp.response_id = s.response_id and rp.parser_version = ${PARSER_VERSION_LLM}
      and rp.reconstructed_from_mentions and (rp.classifier_model is null or rp.classifier_prompt_version is null)
      and s.model is not null and s.prompt is not null
      ${projectId ? sql`and rp.run_id in (select id from runs where project_id = ${projectId})` : sql``}
    returning rp.response_id
  `;
  console.log(JSON.stringify({ repaired: { ledgerRowsReconstructed: rows.length, reconstructedRowsRestamped: restamped.length } }, null, 1));
}

async function main(): Promise<void> {
  const projectId = arg("--project");
  await audit(projectId);
  if (process.argv.includes("--apply")) {
    await repair(projectId);
    await audit(projectId);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end());
