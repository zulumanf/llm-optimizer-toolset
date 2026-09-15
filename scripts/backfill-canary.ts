/**
 * Backfill canary (Layer D, pipeline hardening 2026-09-14). Runs ONE
 * company-scoped backfill inline — enqueue, then execute the job in this
 * process exactly as the worker would — and reports its cost against what
 * the legacy delete-and-reparse path would have enqueued for the same
 * attach. Non-sending: it appends mention revisions for the one company
 * where the run's answers name it, and nothing else.
 *
 *   npx tsx scripts/backfill-canary.ts --project <id> [--company <id>]
 *
 * Without --company, the most recently attached competitor of the project
 * is used. A blocked classifier provider is an honest outcome
 * (provider_blocked, zero heuristic writes), not an error of the canary.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { BACKFILL_RUN_LIMIT, enqueueCompanyBackfill, runCompanyBackfill } from "@/lib/parsing/backfill";
import { PARSER_VERSION_HEURISTIC } from "@/lib/constants";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const projectId = arg("--project");
  if (!projectId) throw new Error("--project <id> is required");
  let companyId = arg("--company");
  if (!companyId) {
    const [c] = await sql`select company_id from competitors where project_id = ${projectId} and archived_at is null order by added_at desc limit 1`;
    companyId = (c?.companyId as string | undefined) ?? null;
  }
  if (!companyId) throw new Error("no competitor attached to this project");
  const [company] = await sql`select name, aliases from companies where id = ${companyId}`;
  const heuristicBefore = await sql`select count(*)::int as n from mentions where company_id = ${companyId} and parser_version = ${PARSER_VERSION_HEURISTIC}`;
  const mentionsBefore = await sql`select count(*)::int as n from mentions where company_id = ${companyId}`;
  const ledgerBefore = await sql`select count(*)::int as n from response_parses rp join runs r on r.id = rp.run_id where r.project_id = ${projectId}`;

  const started = Date.now();
  const queued = await enqueueCompanyBackfill(projectId, companyId, "operator");
  const [job] = await sql`update jobs set status = 'running', attempts = attempts + 1, locked_by = 'canary', locked_at = now() where id = ${queued.jobId} and status = 'queued' returning id, payload`;
  let outcome: "completed" | "threw" = "completed";
  let error: string | null = null;
  if (job) {
    try {
      await runCompanyBackfill(job.payload as unknown as import("@/lib/parsing/backfill").BackfillPayload);
      await sql`update jobs set status = 'done', locked_by = null where id = ${queued.jobId}`;
    } catch (e) {
      outcome = "threw";
      error = e instanceof Error ? e.message : "unknown";
      await sql`update jobs set status = 'failed', last_error = ${error}, locked_by = null where id = ${queued.jobId}`;
    }
  }
  const wallMs = Date.now() - started;
  const [fill] = await sql`select * from company_backfills where id = ${queued.backfillId}`;
  const heuristicAfter = await sql`select count(*)::int as n from mentions where company_id = ${companyId} and parser_version = ${PARSER_VERSION_HEURISTIC}`;
  const mentionsAfter = await sql`select count(*)::int as n from mentions where company_id = ${companyId}`;
  const ledgerAfter = await sql`select count(*)::int as n from response_parses rp join runs r on r.id = rp.run_id where r.project_id = ${projectId}`;
  const [sends] = await sql`select count(*)::int as n from prospect_outreach_sends where sent_at >= now() - make_interval(secs => ${Math.ceil(wallMs / 1000) + 5})`;

  console.log(JSON.stringify({
    canary: { projectId, companyId, company: company?.name, aliases: company?.aliases, jobDeduplicated: queued.deduplicated, jobsEnqueued: queued.deduplicated ? 0 : 1, outcome, error },
    legacyCost: { parseJobsThatWouldHaveBeenEnqueued: queued.estimate.responses, runsThatWouldHaveLostTheirLedger: queued.estimate.runs, runLimit: BACKFILL_RUN_LIMIT },
    newCost: {
      status: fill?.status, runsConsidered: fill?.runsConsidered, runsTouched: fill?.runsTouched, responsesConsidered: fill?.responsesConsidered,
      parsesReused: fill?.parsesReused, classifierCalls: fill?.classifierCalls, mentionsInserted: fill?.mentionsInserted,
      providerState: fill?.providerState, durationMs: fill?.durationMs, wallMs, detail: fill?.detail,
    },
    invariants: {
      semanticLedgerUntouched: Number(ledgerBefore[0]?.n) === Number(ledgerAfter[0]?.n),
      noHeuristicWritten: Number(heuristicBefore[0]?.n) === Number(heuristicAfter[0]?.n),
      mentionsAppended: Number(mentionsAfter[0]?.n) - Number(mentionsBefore[0]?.n),
      sendsDuringCanary: sends?.n,
    },
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end());
