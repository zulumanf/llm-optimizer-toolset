/**
 * Company backfill (pipeline hardening 2026-09-14).
 *
 * Attaching a company to a project used to delete every response_parses row
 * of the project's recent runs and re-classify every answer (1,238 classifier
 * jobs for one attach; heuristic rows written over LLM judgments whenever the
 * provider blinked). The layered model this module enforces instead:
 *
 *   immutable response → semantic parse (response_parses: response × parser
 *   version) → per-company resolution (run_company_parses: run × company ×
 *   alias-graph hash) → counts (CURRENT_REVISION) → evidence release.
 *
 * Attaching a company touches only the resolution layer: the whole-word
 * alias prepass finds the answers that name the company, and the classifier
 * judges the company in those answers only. Existing classifier judgments are
 * reused; nothing is deleted. Invalidation is dependency-driven — the ledger
 * key includes the company's alias-graph hash, so an alias change re-resolves
 * that company (new hits only), a parser-version change is enqueueParseJobs'
 * concern (semantic layer), and "another company was attached" invalidates
 * nothing at all.
 *
 * One job per (project, company); duplicate requests are deduplicated against
 * the queue; each execution is recorded in company_backfills with its scope,
 * reuse, classifier calls, provider state and result.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import { listCompaniesForProject } from "@/db/companies";
import { identityFactsFor } from "@/lib/prospects/entity-aliases";
import { maybeEnqueueScoring, parseCompanyIntoRun, type CompanyParseResult } from "@/lib/parsing/service";
import { isClassifierUnavailable } from "@/lib/parsing/errors";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";

/** Recent runs a backfill considers (unchanged from the legacy path). */
export const BACKFILL_RUN_LIMIT = 12;
/** Classifier calls above which one backfill stops and asks for review:
 * a company named in this many answers across ≤12 runs is either a
 * brokerage-level alias collision or a wrong entity, never routine. */
export const BACKFILL_CLASSIFIER_CALL_REVIEW_THRESHOLD = 400;
export const BACKFILL_JOB_TYPE = "backfill_company";

export type BackfillTrigger = "competitor_attach" | "alias_change" | "operator" | "repair";

export interface BackfillPayload {
  projectId: string;
  companyId: string;
  backfillId: string;
}

export interface BackfillEstimate {
  runs: number;
  responses: number;
}

/** Identity of the alias graph the resolution depends on. */
export function aliasHashFor(company: { name: string; aliases: string[]; domain: string | null }, identityFacts: string[]): string {
  const canonical = JSON.stringify({
    name: company.name.trim().toLowerCase(),
    aliases: [...new Set(company.aliases.map((a) => a.trim().toLowerCase()))].sort(),
    domain: company.domain?.trim().toLowerCase() ?? null,
    facts: [...new Set(identityFacts.map((f) => f.trim().toLowerCase()))].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

async function recentRuns(projectId: string): Promise<string[]> {
  const rows = await sql`
    select id from runs
    where project_id = ${projectId} and status in ('completed', 'partial')
    order by started_at desc
    limit ${BACKFILL_RUN_LIMIT}
  `;
  return rows.map((r) => r.id as string);
}

/** Scope a backfill would touch — recorded before anything is enqueued. */
export async function estimateBackfill(projectId: string): Promise<BackfillEstimate> {
  const runs = await recentRuns(projectId);
  if (runs.length === 0) return { runs: 0, responses: 0 };
  const [row] = await sql`
    select count(*)::int as n from responses where run_id = any(${runs}::uuid[]) and error is null
  `;
  return { runs: runs.length, responses: Number(row?.n ?? 0) };
}

/**
 * Enqueue ONE backfill job for (project, company). Idempotent against the
 * queue: a queued or running job for the same pair is returned instead of
 * duplicated.
 */
export async function enqueueCompanyBackfill(
  projectId: string,
  companyId: string,
  trigger: BackfillTrigger
): Promise<{ jobId: string; backfillId: string; deduplicated: boolean; estimate: BackfillEstimate }> {
  const estimate = await estimateBackfill(projectId);
  const [existing] = await sql`
    select id, payload->>'backfillId' as backfill_id from jobs
    where type = ${BACKFILL_JOB_TYPE}
      and payload->>'projectId' = ${projectId} and payload->>'companyId' = ${companyId}
      and status in ('queued', 'running')
    limit 1
  `;
  if (existing) {
    return { jobId: existing.id as string, backfillId: existing.backfillId as string, deduplicated: true, estimate };
  }
  const [row] = await sql`
    insert into company_backfills (project_id, company_id, trigger, status, runs_considered, responses_considered)
    values (${projectId}, ${companyId}, ${trigger}, 'queued', ${estimate.runs}, ${estimate.responses})
    returning id
  `;
  const backfillId = row?.id as string;
  const payload: BackfillPayload = { projectId, companyId, backfillId };
  const jobId = await enqueueJob(sql, BACKFILL_JOB_TYPE, payload as unknown as Record<string, unknown>);
  log("info", "backfill.enqueued", { projectId, companyId, trigger, ...estimate });
  return { jobId, backfillId, deduplicated: false, estimate };
}

/** Alias graph changed: re-resolve the company in every project tracking it. */
export async function enqueueAliasBackfills(companyId: string): Promise<number> {
  const projects = await sql`
    select distinct project_id from competitors where company_id = ${companyId} and archived_at is null
    union
    select id as project_id from projects where subject_company_id = ${companyId} and archived_at is null
  `;
  for (const p of projects) await enqueueCompanyBackfill(p.projectId as string, companyId, "alias_change");
  return projects.length;
}

interface RunOutcome {
  runId: string;
  reusedLedger: boolean;
  result: CompanyParseResult | null;
}

/** One run: reuse the ledger row for this alias graph, or resolve under a
 * per-(run, company) transactional advisory lock so two workers can never
 * append the same judgment twice. */
async function backfillRun(runId: string, companyId: string, aliasHash: string, backfillId: string): Promise<RunOutcome> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`${runId}:${companyId}`}))`;
    const [done] = await tx`
      select 1 from run_company_parses where run_id = ${runId} and company_id = ${companyId} and alias_hash = ${aliasHash}
    `;
    if (done) return { runId, reusedLedger: true, result: null };
    const result = await parseCompanyIntoRun(runId, companyId, tx);
    await tx`
      insert into run_company_parses (run_id, company_id, alias_hash, parser_version, scanned, hits, inserted, backfill_id)
      values (${runId}, ${companyId}, ${aliasHash}, ${result.parserVersion}, ${result.scanned}, ${result.hits}, ${result.inserted}, ${backfillId})
      on conflict (run_id, company_id, alias_hash) do nothing
    `;
    return { runId, reusedLedger: false, result };
  });
}

async function finishBackfill(backfillId: string, patch: {
  status: "completed" | "provider_blocked" | "review_required" | "failed";
  outcomes: RunOutcome[]; startedAt: number; providerState: string | null; detail: string | null;
}): Promise<void> {
  const results = patch.outcomes.map((o) => o.result).filter((r): r is CompanyParseResult => r !== null);
  const sum = (f: (r: CompanyParseResult) => number) => results.reduce((n, r) => n + f(r), 0);
  const reusedLedger = patch.outcomes.filter((o) => o.reusedLedger).length;
  await sql`
    update company_backfills set
      status = ${patch.status},
      runs_touched = ${results.length},
      responses_considered = ${sum((r) => r.scanned)},
      parses_reused = ${reusedLedger + sum((r) => r.reused)},
      classifier_calls = ${sum((r) => r.classifierCalls)},
      mentions_inserted = ${sum((r) => r.inserted)},
      provider_state = ${patch.providerState},
      duration_ms = ${Date.now() - patch.startedAt},
      detail = ${patch.detail},
      completed_at = now()
    where id = ${backfillId}
  `;
}

/**
 * Job handler. Idempotent and crash-safe: every run is a ledger check or a
 * locked resolution whose pair-level skip makes a retry converge instead of
 * duplicating. A classifier outage records provider_blocked and rethrows so
 * the queue retries with backoff; a re-enqueue later reuses everything done.
 */
export async function runCompanyBackfill(payload: BackfillPayload): Promise<void> {
  const startedAt = Date.now();
  const { projectId, companyId, backfillId } = payload;
  await sql`update company_backfills set status = 'running' where id = ${backfillId}`;
  const company = (await listCompaniesForProject(projectId)).find((c) => c.id === companyId);
  if (!company) {
    await finishBackfill(backfillId, { status: "failed", outcomes: [], startedAt, providerState: null, detail: "company is not tracked in the project" });
    throw new ClassifiedError("validation", `Company ${companyId} is not tracked in project ${projectId}.`);
  }
  const facts = (await identityFactsFor([companyId]))[companyId] ?? [];
  const aliasHash = aliasHashFor(company, facts);
  const outcomes: RunOutcome[] = [];
  let calls = 0;
  try {
    for (const runId of await recentRuns(projectId)) {
      const outcome = await backfillRun(runId, companyId, aliasHash, backfillId);
      outcomes.push(outcome);
      calls += outcome.result?.classifierCalls ?? 0;
      if (calls > BACKFILL_CLASSIFIER_CALL_REVIEW_THRESHOLD) {
        await finishBackfill(backfillId, { status: "review_required", outcomes, startedAt, providerState: "AVAILABLE", detail: `${calls} classifier calls exceed the ${BACKFILL_CLASSIFIER_CALL_REVIEW_THRESHOLD} review threshold — alias collision or wrong entity?` });
        log("warn", "backfill.review_required", { projectId, companyId, calls });
        return;
      }
    }
  } catch (err) {
    if (isClassifierUnavailable(err)) {
      await finishBackfill(backfillId, { status: "provider_blocked", outcomes, startedAt, providerState: err.providerState, detail: err.message });
    } else {
      await finishBackfill(backfillId, { status: "failed", outcomes, startedAt, providerState: null, detail: err instanceof Error ? err.message : "unknown" });
    }
    throw err;
  }
  for (const o of outcomes) if (o.result && o.result.inserted > 0) await maybeEnqueueScoring(o.runId);
  await finishBackfill(backfillId, { status: "completed", outcomes, startedAt, providerState: calls > 0 ? "AVAILABLE" : null, detail: null });
  log("info", "backfill.completed", { projectId, companyId, runs: outcomes.length, classifierCalls: calls });
}
