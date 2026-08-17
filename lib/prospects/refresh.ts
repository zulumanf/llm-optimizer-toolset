/**
 * Audit refresh queue (spec 075).
 *
 * After a scheduled benchmark run on a prospect-kind project, the platform
 * prepares one refresh candidate per published audit fed by that project:
 * new run linked, findings generated, week-over-week delta computed,
 * preflight pre-run. The operator's remaining work is one reviewed click —
 * `approveAuditRefresh` — which goes through the existing `reviewFinding`
 * and `publishAudit` gates unchanged. No code path here publishes anything
 * without that click (PRINCIPLES #8).
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, systemUser, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { log } from "@/lib/logger";
import { checkNoMockResponses } from "@/lib/qa/preflight";
import { mockScoringAllowed } from "@/lib/ai/registry";
import { FRESHNESS_WINDOWS_DAYS, staleness } from "@/lib/prospects/constants";
import { scoredEntities, runSummary } from "@/lib/prospects/benchmark";
import type { BenchmarkEntityMetrics } from "@/lib/prospects/findings";
import {
  generateFindings,
  linkBenchmark,
  publishAudit,
  reviewFinding,
} from "@/lib/prospects/service";

// ---------------------------------------------------------------- delta

export interface MetricDelta {
  old: number | null;
  new: number | null;
}

export interface AuditRefreshDelta {
  recommendationRate: MetricDelta;
  mentionRate: MetricDelta;
  /** Top rival by NEW recommendation rate among non-prospect entities. */
  topRival: { companyId: string; name: string } & { rate: MetricDelta } | null;
  /** The underrepresentation pitch: the prospect still trails the top rival.
   * False means the published claim direction flipped — flagged loudly in
   * the queue so outreach language gets rechecked before approval. */
  claimStillTrue: boolean;
}

/** Pure: diff two runs' scored entities for one prospect company. */
export function computeAuditDelta(
  prospectCompanyId: string,
  oldEntities: BenchmarkEntityMetrics[],
  newEntities: BenchmarkEntityMetrics[]
): AuditRefreshDelta {
  const oldSelf = oldEntities.find((e) => e.companyId === prospectCompanyId);
  const newSelf = newEntities.find((e) => e.companyId === prospectCompanyId);
  const rivals = newEntities
    .filter((e) => e.companyId !== prospectCompanyId)
    .sort((a, b) => (b.recommendationRate ?? -1) - (a.recommendationRate ?? -1));
  const top = rivals[0] ?? null;
  const oldTop = top
    ? oldEntities.find((e) => e.companyId === top.companyId)
    : undefined;

  const selfRate = newSelf?.recommendationRate ?? null;
  const topRate = top?.recommendationRate ?? null;
  return {
    recommendationRate: {
      old: oldSelf?.recommendationRate ?? null,
      new: selfRate,
    },
    mentionRate: {
      old: oldSelf?.mentionRate ?? null,
      new: newSelf?.mentionRate ?? null,
    },
    topRival: top
      ? {
          companyId: top.companyId,
          name: top.name,
          rate: { old: oldTop?.recommendationRate ?? null, new: topRate },
        }
      : null,
    // Null-safe: with either side unmeasured the claim is not shown as
    // flipped — an absent number is not evidence of a reversal.
    claimStillTrue:
      selfRate === null || topRate === null ? true : selfRate <= topRate,
  };
}

// ------------------------------------------------------------- preflight

interface StoredCheck {
  id: string;
  level: "block" | "warn";
  ok: boolean;
  detail: string;
}

/** The publish-blocking/warning facts knowable at preparation time. The
 * operator-typed blocks (humanFinding, adoptionStat) arrive at the click,
 * so their checks stay where they always ran — inside publishAudit. */
async function candidatePreflight(runId: string): Promise<StoredCheck[]> {
  const run = await runSummary(runId);
  const checks: StoredCheck[] = [];
  if (!run) return [{ id: "run_exists", level: "block", ok: false, detail: "Run not found." }];

  const providerRows = await sql`
    select distinct provider from responses where run_id = ${runId}
  `;
  const mock = checkNoMockResponses(
    providerRows.map((r) => r.provider as string),
    mockScoringAllowed()
  );
  checks.push({
    id: "no_mock_responses",
    level: "block",
    ok: mock.ok,
    detail: mock.ok ? "No mock-provider responses." : mock.detail,
  });

  const age = staleness(run.startedAt, FRESHNESS_WINDOWS_DAYS.benchmark);
  checks.push({
    id: "benchmark_fresh",
    level: "warn",
    ok: !age.stale,
    detail: age.stale
      ? `Run is ${age.ageDays} days old — past the ${FRESHNESS_WINDOWS_DAYS.benchmark}-day window; publish will need acknowledgeStale.`
      : `Run is ${age.ageDays} days old.`,
  });

  checks.push({
    id: "run_health",
    level: "warn",
    ok: run.status === "completed" && run.failedCount === 0,
    detail:
      run.status === "partial"
        ? `Partial run: ${run.failedCount} cells errored — coverage is incomplete; publish will need an acknowledged reason.`
        : run.failedCount > 0
          ? `${run.failedCount} cells errored.`
          : "All cells captured.",
  });
  return checks;
}

// ----------------------------------------------------------- preparation

export interface PrepareResult {
  runId: string;
  prepared: number;
  needsAttention: number;
  skipped: Array<{ prospectId: string; reason: string }>;
  /** Not-applicable runs (wrong project kind / manual trigger) report why. */
  notApplicable?: string;
}

/**
 * Prepare refresh candidates for every published audit fed by this run's
 * project. Called by the automation workflow as the system principal;
 * idempotent per (prospect, run). Nothing here is prospect-visible.
 */
export async function prepareAuditRefreshCandidates(input: {
  runId: string;
  /** Manual backfill may target a manually-triggered run. */
  force?: boolean;
}): Promise<PrepareResult> {
  const system = await systemUser();
  const empty: PrepareResult = {
    runId: input.runId,
    prepared: 0,
    needsAttention: 0,
    skipped: [],
  };

  const [run] = await sql`
    select r.id, r.status, r.trigger, r.project_id, p.kind
    from runs r join projects p on p.id = r.project_id
    where r.id = ${input.runId}
  `;
  if (!run) return { ...empty, notApplicable: "run not found" };
  if (run.kind !== "prospect") {
    return { ...empty, notApplicable: `project kind is ${run.kind}, not prospect` };
  }
  if (run.trigger !== "scheduled" && !input.force) {
    return { ...empty, notApplicable: "manual run — the queue consumes the weekly cadence" };
  }
  if (run.status !== "completed" && run.status !== "partial") {
    return { ...empty, notApplicable: `run is ${run.status} — not finished` };
  }

  // Prospects whose CURRENT published audit is fed by an earlier run of this
  // same project, still in a refreshable lifecycle.
  const affected = await sql`
    select distinct p.id, p.business_name, p.company_id,
      a.id as audit_id, ob.run_id as old_run_id
    from prospects p
    join prospect_audits a on a.prospect_id = p.id and a.status = 'published'
    join prospect_findings f on f.id = a.finding_id
    join prospect_benchmarks ob on ob.id = f.benchmark_id
    join runs orun on orun.id = ob.run_id
    where orun.project_id = ${run.projectId}
      and p.archived_at is null
      and p.promoted_project_id is null
      and ob.run_id <> ${input.runId}
  `;

  const result: PrepareResult = { ...empty };
  const newEntities = await scoredEntities(input.runId);
  const preflight = await candidatePreflight(input.runId);

  for (const prospect of affected) {
    const prospectId = prospect.id as string;
    try {
      const [existing] = await sql`
        select id from audit_refresh_candidates
        where prospect_id = ${prospectId} and run_id = ${input.runId}
      `;
      if (existing) {
        result.skipped.push({ prospectId, reason: "already_prepared" });
        continue;
      }

      // A newer run makes older undecided candidates moot — one open card
      // per prospect, always the freshest.
      await sql`
        update audit_refresh_candidates
        set status = 'superseded', decided_at = now()
        where prospect_id = ${prospectId}
          and status in ('pending', 'needs_attention')
      `;

      let findingId: string | null = null;
      let error: string | null = null;

      // Link the new run (idempotent per (prospect, run) at the DB level).
      const [alreadyLinked] = await sql`
        select id from prospect_benchmarks
        where prospect_id = ${prospectId} and run_id = ${input.runId}
      `;
      let benchmarkId = alreadyLinked?.id as string | undefined;
      if (!benchmarkId) {
        const linked = await linkBenchmark(system, {
          prospectId,
          runId: input.runId,
          note: "Weekly baseline refresh (spec 075)",
        });
        if (linked.ok) benchmarkId = linked.data.benchmarkId;
        else error = `link failed: ${linked.error.message}`;
      }

      if (benchmarkId) {
        const generated = await generateFindings(system, { benchmarkId });
        if (!generated.ok) {
          error = `findings generation failed: ${generated.error.message}`;
        } else {
          const [top] = await sql`
            select id from prospect_findings
            where benchmark_id = ${benchmarkId} and status = 'candidate'
            order by rank_score desc nulls last, created_at asc
            limit 1
          `;
          if (top) findingId = top.id as string;
          else error = "no finding candidates were generated for this run";
        }
      }

      const oldEntities = await scoredEntities(prospect.oldRunId as string);
      const delta = computeAuditDelta(
        prospect.companyId as string,
        oldEntities,
        newEntities
      );

      const status = findingId ? "pending" : "needs_attention";
      await sql.begin(async (tx) => {
        const [row] = await tx`
          insert into audit_refresh_candidates
            (prospect_id, run_id, finding_id, delta, preflight, status, error)
          values (${prospectId}, ${input.runId}, ${findingId},
            ${tx.json(delta as never)}, ${tx.json(preflight as never)},
            ${status}, ${error})
          returning id
        `;
        await writeAudit(tx, {
          userId: system.id,
          action: "prospect.audit_refresh_prepared",
          entity: "audit_refresh_candidate",
          entityId: row?.id as string,
          detail: { prospectId, runId: input.runId, status, error },
        });
      });
      if (findingId) result.prepared += 1;
      else result.needsAttention += 1;
    } catch (err) {
      // A silent skip would read as "nothing changed" — record the failure
      // as a needs_attention card when possible, else at least a log line.
      const message = err instanceof Error ? err.message : String(err);
      log("error", "prospect.audit_refresh_prepare_failed", {
        prospectId,
        runId: input.runId,
        error: message,
      });
      try {
        await sql`
          insert into audit_refresh_candidates
            (prospect_id, run_id, status, error)
          values (${prospectId}, ${input.runId}, 'needs_attention', ${message})
          on conflict (prospect_id, run_id) do nothing
        `;
        result.needsAttention += 1;
      } catch {
        result.skipped.push({ prospectId, reason: message });
      }
    }
  }
  return result;
}

// ------------------------------------------------------------- decisions

const sourcedObservation = z.object({
  text: z.string().trim().min(20).max(600),
  sourceLabel: z.string().trim().min(2).max(120),
  sourceUrl: z.string().trim().url().max(1000),
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const approveSchema = z.object({
  candidateId: z.string().uuid(),
  /** Required here even though publishAudit treats it as optional: the
   * attestation that a human looked is the point of the click. */
  humanFinding: sourcedObservation,
  adoptionStat: sourcedObservation.optional(),
  acknowledgeStale: z.boolean().optional(),
  acknowledgeWarnings: z
    .object({ reason: z.string().trim().min(10).max(500) })
    .optional(),
});

interface CandidateRow {
  id: string;
  prospectId: string;
  runId: string;
  findingId: string | null;
  status: string;
}

async function loadOpenCandidate(candidateId: string): Promise<CandidateRow> {
  const [row] = await sql`
    select id, prospect_id, run_id, finding_id, status
    from audit_refresh_candidates where id = ${candidateId}
  `;
  if (!row) throw new ClassifiedError("not_found", "Candidate not found.");
  const candidate = row as unknown as CandidateRow;
  if (candidate.status !== "pending" && candidate.status !== "needs_attention") {
    throw new ClassifiedError("conflict", `Candidate is already ${candidate.status}.`);
  }
  return candidate;
}

/** Refuse when the prospect's audit lifecycle ended between preparation and
 * the click; flips the candidate to dismissed with the reason. */
async function assertStillRefreshable(candidate: CandidateRow, user: CurrentUser): Promise<void> {
  const [prospect] = await sql`
    select p.archived_at, p.promoted_project_id,
      (select count(*)::int from prospect_audits a
        where a.prospect_id = p.id and a.status = 'published') as published_count
    from prospects p where p.id = ${candidate.prospectId}
  `;
  const reason = !prospect
    ? "prospect not found"
    : prospect.archivedAt
      ? "prospect archived"
      : prospect.promotedProjectId
        ? "promoted — audit lifecycle ended"
        : Number(prospect.publishedCount) === 0
          ? "no published audit — revoked or expired; first publication is the manual act"
          : null;
  if (reason) {
    await sql`
      update audit_refresh_candidates
      set status = 'dismissed', decided_at = now(), decided_by = ${user.id},
        error = ${reason}
      where id = ${candidate.id}
    `;
    throw new ClassifiedError("conflict", `Cannot refresh: ${reason}.`);
  }
}

export async function approveAuditRefresh(
  user: CurrentUser,
  raw: unknown
): Promise<
  ActionResult<{ candidateId: string; auditId: string; warnings: string[] }>
> {
  const parsed = approveSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const candidate = await loadOpenCandidate(input.candidateId);
    if (!candidate.findingId) {
      throw new ClassifiedError(
        "validation",
        "This candidate needs attention — resolve it from the prospect page."
      );
    }
    await assertStillRefreshable(candidate, user);

    // Approve-and-make-primary, unless a retry already did (publishAudit
    // failing after review must not wedge the candidate).
    const [finding] = await sql`
      select status, is_primary from prospect_findings
      where id = ${candidate.findingId}
    `;
    if (!finding) throw new ClassifiedError("not_found", "Finding not found.");
    if (finding.status === "candidate") {
      const reviewed = await reviewFinding(user, {
        findingId: candidate.findingId,
        decision: "approved",
        makePrimary: true,
      });
      if (!reviewed.ok) return fail(reviewed.error);
    } else if (finding.status !== "approved" || !finding.isPrimary) {
      throw new ClassifiedError(
        "conflict",
        `The candidate's finding is ${finding.status}${
          finding.isPrimary ? "" : " and not primary"
        } — review it from the prospect page.`
      );
    }

    const published = await publishAudit(user, {
      prospectId: candidate.prospectId,
      humanFinding: input.humanFinding,
      ...(input.adoptionStat ? { adoptionStat: input.adoptionStat } : {}),
      ...(input.acknowledgeStale ? { acknowledgeStale: true } : {}),
      ...(input.acknowledgeWarnings
        ? { acknowledgeWarnings: input.acknowledgeWarnings }
        : {}),
    });
    if (!published.ok) return fail(published.error);

    await sql.begin(async (tx) => {
      await tx`
        update audit_refresh_candidates
        set status = 'approved', decided_at = now(), decided_by = ${user.id}
        where id = ${candidate.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_refresh_approved",
        entity: "audit_refresh_candidate",
        entityId: candidate.id,
        detail: {
          prospectId: candidate.prospectId,
          runId: candidate.runId,
          auditId: published.data.auditId,
          replaced: published.data.replaced,
        },
      });
    });
    return ok({
      candidateId: candidate.id,
      auditId: published.data.auditId,
      warnings: published.data.warnings,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function dismissAuditRefresh(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ candidateId: string }>> {
  const parsed = z
    .object({
      candidateId: z.string().uuid(),
      reason: z.string().trim().max(500).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    assertCanWrite(user);
    const candidate = await loadOpenCandidate(parsed.data.candidateId);
    await sql.begin(async (tx) => {
      await tx`
        update audit_refresh_candidates
        set status = 'dismissed', decided_at = now(), decided_by = ${user.id}
        where id = ${candidate.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_refresh_dismissed",
        entity: "audit_refresh_candidate",
        entityId: candidate.id,
        detail: {
          prospectId: candidate.prospectId,
          reason: parsed.data.reason ?? null,
        },
      });
    });
    return ok({ candidateId: candidate.id });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------------ reads

export interface RefreshQueueItem {
  id: string;
  status: "pending" | "needs_attention";
  error: string | null;
  createdAt: Date;
  prospectId: string;
  businessName: string;
  launchName: string;
  runId: string;
  runLabel: string;
  runStatus: string;
  runStartedAt: Date;
  findingId: string | null;
  findingTitle: string | null;
  findingExplanation: string | null;
  delta: AuditRefreshDelta | null;
  preflight: StoredCheck[];
  publishedAt: Date | null;
  viewCount: number;
  /** Pre-fill for the required humanFinding — the last published one. */
  priorHumanFinding: {
    text: string;
    sourceLabel: string;
    sourceUrl: string;
    sourceDate: string;
  } | null;
}

export async function listAuditRefreshCandidates(): Promise<RefreshQueueItem[]> {
  const rows = await sql`
    select c.id, c.status, c.error, c.created_at, c.delta, c.preflight,
      p.id as prospect_id, p.business_name, l.name as launch_name,
      r.id as run_id, r.label as run_label, r.status as run_status,
      r.started_at as run_started_at,
      f.id as finding_id, f.title as finding_title,
      f.explanation as finding_explanation,
      a.published_at,
      a.snapshot->'humanFinding' as prior_human_finding,
      (select count(*)::int from prospect_audit_views v where v.audit_id = a.id)
        as view_count
    from audit_refresh_candidates c
    join prospects p on p.id = c.prospect_id
    join market_launches l on l.id = p.launch_id
    join runs r on r.id = c.run_id
    left join prospect_findings f on f.id = c.finding_id
    left join lateral (
      select id, published_at, snapshot from prospect_audits
      where prospect_id = p.id and status = 'published'
      order by published_at desc limit 1
    ) a on true
    where c.status in ('pending', 'needs_attention')
    order by c.created_at desc, p.business_name asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    status: row.status as "pending" | "needs_attention",
    error: (row.error as string | null) ?? null,
    createdAt: row.createdAt as Date,
    prospectId: row.prospectId as string,
    businessName: row.businessName as string,
    launchName: row.launchName as string,
    runId: row.runId as string,
    runLabel: row.runLabel as string,
    runStatus: row.runStatus as string,
    runStartedAt: row.runStartedAt as Date,
    findingId: (row.findingId as string | null) ?? null,
    findingTitle: (row.findingTitle as string | null) ?? null,
    findingExplanation: (row.findingExplanation as string | null) ?? null,
    delta: (row.delta as AuditRefreshDelta | null) ?? null,
    preflight: (row.preflight as StoredCheck[]) ?? [],
    publishedAt: (row.publishedAt as Date | null) ?? null,
    viewCount: Number(row.viewCount ?? 0),
    priorHumanFinding:
      (row.priorHumanFinding as RefreshQueueItem["priorHumanFinding"]) ?? null,
  }));
}

export async function openRefreshCount(): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from audit_refresh_candidates
    where status in ('pending', 'needs_attention')
  `;
  return Number(row?.n ?? 0);
}
