/**
 * City prospecting pipeline (spec 097): "run prospecting in X city, A→Z"
 * as a durable state machine the worker's tick advances. Every step
 * composes an existing, tested service — this module owns ordering, state,
 * and the log, never business logic.
 *
 * Human-gate ledger: kickoff is confirm-gated in the assistant and
 * authorizes internal artifacts plus ONE benchmark run within the stated
 * budget. High-confidence discovery candidates (≥ AUTO_APPROVE_CONFIDENCE)
 * auto-approve into prospects — internal, reversible, provenance-stamped;
 * ambiguous or low-confidence ones stay staged for the human. Findings
 * approval, audit publishing, and outreach keep their own gates untouched.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { log as logLine } from "@/lib/logger";
import { draftMarketPack, installMarketPackDraft } from "@/lib/markets/research";
import { bootstrapMarketBenchmark } from "@/lib/markets/bootstrap";
import { runProspectDiscovery, reviewDiscoveryCandidate } from "@/lib/prospects/discovery";
import { addCompetitor } from "@/lib/competitors/service";
import { estimateRunForVersion, startRun } from "@/lib/runs/service";
import * as svc from "@/lib/prospects/service";

/** Candidates at or above this confidence auto-approve into prospects
 * (DECISIONS 2026-08-20): internal, reversible, provenance-stamped — the
 * external gates are untouched. Below it, humans review. */
export const AUTO_APPROVE_CONFIDENCE = 0.7;

export interface PipelineRow {
  id: string;
  cityName: string;
  stateName: string;
  status: string;
  params: { targetProspects: number; budgetUsd: number; segment: string };
  launchId: string | null;
  projectId: string | null;
  promptSetVersionId: string | null;
  runId: string | null;
  log: { at: string; step: string; detail: string }[];
  error: string | null;
  requestedBy: string;
}

const startSchema = z.object({
  cityName: z.string().trim().min(2).max(120),
  state: z.string().trim().min(2).max(60),
  targetProspects: z.number().int().min(1).max(50).default(15),
  budgetUsd: z.number().positive().max(100),
  segment: z
    .string()
    .trim()
    .max(160)
    .default("highest-performing and RealTrends-ranked teams"),
});

function toRow(r: Record<string, unknown>): PipelineRow {
  return {
    id: r.id as string,
    cityName: r.cityName as string,
    stateName: r.stateName as string,
    status: r.status as string,
    params: (r.params as PipelineRow["params"]) ?? {
      targetProspects: 15,
      budgetUsd: 0,
      segment: "",
    },
    launchId: (r.launchId as string | null) ?? null,
    projectId: (r.projectId as string | null) ?? null,
    promptSetVersionId: (r.promptSetVersionId as string | null) ?? null,
    runId: (r.runId as string | null) ?? null,
    log: (r.log as PipelineRow["log"]) ?? [],
    error: (r.error as string | null) ?? null,
    requestedBy: r.requestedBy as string,
  };
}

async function appendLog(id: string, step: string, detail: string): Promise<void> {
  await sql`
    update city_prospecting_pipelines
    set log = log || ${sql.json([
      { at: new Date().toISOString(), step, detail },
    ] as never)}, updated_at = now()
    where id = ${id}
  `;
}

async function setStatus(
  id: string,
  status: string,
  fields: Record<string, string | null> = {}
): Promise<void> {
  await sql`
    update city_prospecting_pipelines
    set status = ${status},
      launch_id = coalesce(${fields.launchId ?? null}, launch_id),
      project_id = coalesce(${fields.projectId ?? null}, project_id),
      prompt_set_version_id = coalesce(${fields.promptSetVersionId ?? null}, prompt_set_version_id),
      run_id = coalesce(${fields.runId ?? null}, run_id),
      error = ${fields.error ?? null},
      updated_at = now()
    where id = ${id}
  `;
}

/** Kick off a pipeline. Called ONLY through the assistant's confirm gate
 * (or a deliberate operator script) — the confirmation is the human
 * authorization for the budgeted run. */
export async function startCityProspecting(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ pipelineId: string }>> {
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "City, state, and a budget are required."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [active] = await sql`
      select id from city_prospecting_pipelines
      where lower(city_name) = ${input.cityName.toLowerCase()}
        and status not in ('completed','failed')
    `;
    if (active) {
      throw new ClassifiedError(
        "conflict",
        `A pipeline for ${input.cityName} is already active (${active.id}) — check get_city_prospecting.`
      );
    }
    const [row] = await sql`
      insert into city_prospecting_pipelines
        (city_name, state_name, params, requested_by)
      values (${input.cityName}, ${input.state}, ${sql.json({
        targetProspects: input.targetProspects,
        budgetUsd: input.budgetUsd,
        segment: input.segment,
      } as never)}, ${user.id})
      returning id
    `;
    const pipelineId = row!.id as string;
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "prospect.city_pipeline_started",
        entity: "city_prospecting_pipeline",
        entityId: pipelineId,
        detail: { ...input },
      })
    );
    await appendLog(
      pipelineId,
      "started",
      `A→Z prospecting for ${input.cityName}, ${input.state}: target ${input.targetProspects} prospects, run budget ≤ $${input.budgetUsd}. The worker advances it every tick.`
    );
    return ok({ pipelineId });
  } catch (err) {
    return fail(err);
  }
}

export async function getCityProspecting(cityOrId: string): Promise<PipelineRow | null> {
  const rows = await sql`
    select * from city_prospecting_pipelines
    where id::text = ${cityOrId} or lower(city_name) = ${cityOrId.toLowerCase()}
    order by created_at desc limit 1
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

const unwrapStep = <T>(r: ActionResult<T>, step: string): T => {
  if (!r.ok) throw new ClassifiedError(r.error.kind, `${step}: ${r.error.message}`);
  return r.data;
};

async function requester(p: PipelineRow): Promise<CurrentUser> {
  const [u] = await sql`
    select id, email, name, role from users where id = ${p.requestedBy} and active
  `;
  if (!u) throw new ClassifiedError("validation", "The requesting user is no longer active.");
  return {
    id: u.id as string,
    email: u.email as string,
    name: u.name as string,
    role: u.role as CurrentUser["role"],
  };
}

/** One state transition. Idempotent per state; throws → pipeline failed. */
async function step(p: PipelineRow): Promise<"advanced" | "waiting" | "done"> {
  const user = await requester(p);
  switch (p.status) {
    case "installing": {
      // An existing launch for the city short-circuits research entirely.
      const [existing] = await sql`
        select l.id from market_launches l
        join markets m on m.id = l.market_id
        where l.archived_at is null and m.name ilike ${p.cityName + "%"}
        order by l.created_at desc limit 1
      `;
      let launchId: string;
      if (existing) {
        launchId = existing.id as string;
        await appendLog(p.id, "installing", `Existing launch ${launchId} reused.`);
      } else {
        const draft = unwrapStep(
          await draftMarketPack(user, { cityName: p.cityName, state: p.stateName }),
          "research"
        );
        if (!draft.pack) {
          throw new ClassifiedError("internal", `research: ${draft.error ?? "empty pack"}`);
        }
        const installed = unwrapStep(
          await installMarketPackDraft(user, { draftId: draft.draftId }),
          "install"
        );
        launchId = installed.launchId;
        await appendLog(
          p.id,
          "installing",
          `Market pack researched and installed; launch ${launchId}.`
        );
      }
      await setStatus(p.id, "discovering", { launchId });
      return "advanced";
    }
    case "discovering": {
      const result = unwrapStep(
        await runProspectDiscovery(user, {
          launchId: p.launchId!,
          provider: "perplexity",
          segment: p.params.segment,
          limit: Math.min(p.params.targetProspects * 2, 50),
        }),
        "discovery"
      );
      await appendLog(
        p.id,
        "discovering",
        `Perplexity discovery staged ${result.candidateCount} candidates (segment: ${p.params.segment}).`
      );
      await setStatus(p.id, "seeding");
      return "advanced";
    }
    case "seeding": {
      const candidates = await sql`
        select id, business_name, confidence from prospect_discovery_candidates
        where launch_id = ${p.launchId} and status = 'pending'
        order by confidence desc
      `;
      let approved = 0;
      let leftStaged = 0;
      for (const c of candidates) {
        if (Number(c.confidence) < AUTO_APPROVE_CONFIDENCE || approved >= p.params.targetProspects) {
          leftStaged += 1;
          continue;
        }
        const reviewed = await reviewDiscoveryCandidate(user, {
          candidateId: c.id as string,
          decision: "approve",
        });
        if (reviewed.ok) approved += 1;
        else leftStaged += 1; // ambiguous resolution etc. — human review
      }
      await appendLog(
        p.id,
        "seeding",
        `${approved} prospects auto-created (confidence ≥ ${AUTO_APPROVE_CONFIDENCE}); ${leftStaged} candidates left for your review.`
      );
      await setStatus(p.id, "benchmarking");
      return "advanced";
    }
    case "benchmarking": {
      const boot = unwrapStep(
        await bootstrapMarketBenchmark(user, { launchId: p.launchId! }),
        "bootstrap"
      );
      // Track every seeded prospect's company so the run scores THEM.
      const companies = await sql`
        select distinct company_id from prospects
        where launch_id = ${p.launchId} and archived_at is null and company_id is not null
      `;
      for (const c of companies) {
        await addCompetitor(user, {
          projectId: boot.projectId,
          companyId: c.companyId as string,
          tier: "secondary",
        }); // duplicate-tracking errors are fine — already tracked
      }
      const providers =
        (boot.suggestedProviders as { provider: string; model: string; repetitions: number }[] | null) ??
        null;
      if (!providers || providers.length === 0) {
        throw new ClassifiedError(
          "validation",
          "benchmark: no prior run exists to copy a provider config from — start one benchmark run manually once, then pipelines can reuse its configuration."
        );
      }
      const estimate = unwrapStep(
        await estimateRunForVersion({
          promptSetVersionId: boot.promptSetVersionId,
          providers,
        }),
        "estimate"
      );
      const estimated = estimate.estimatedMicroUsd / 1_000_000;
      if (estimated > p.params.budgetUsd) {
        throw new ClassifiedError(
          "validation",
          `benchmark: estimated cost $${estimated.toFixed(2)} exceeds the confirmed budget $${p.params.budgetUsd} — re-run with a higher budget or fewer prompts.`
        );
      }
      const run = unwrapStep(
        await startRun(
          user,
          {
            projectId: boot.projectId,
            promptSetVersionId: boot.promptSetVersionId,
            providers,
            budgetUsd: p.params.budgetUsd,
            label: `City prospecting: ${p.cityName} (pipeline ${p.id.slice(0, 8)})`,
          },
          "manual"
        ),
        "run"
      );
      await appendLog(
        p.id,
        "benchmarking",
        `Benchmark started: run ${run.id}, ${boot.promptCount} prompts, estimated $${estimated.toFixed(2)}, cap $${p.params.budgetUsd}.`
      );
      await setStatus(p.id, "running", {
        projectId: boot.projectId,
        promptSetVersionId: boot.promptSetVersionId,
        runId: run.id,
      });
      return "advanced";
    }
    case "running": {
      const [run] = await sql`
        select status,
          (select count(*)::int from scores where run_id = ${p.runId}) as scores
        from runs where id = ${p.runId}
      `;
      if (!run) throw new ClassifiedError("internal", "running: the run row disappeared.");
      if (run.status === "failed" || run.status === "cancelled") {
        throw new ClassifiedError("internal", `running: the benchmark run ${String(run.status)}.`);
      }
      if (run.status !== "completed" || Number(run.scores) === 0) {
        return "waiting"; // next tick checks again
      }
      await appendLog(p.id, "running", "Benchmark completed and scored.");
      await setStatus(p.id, "scoring");
      return "advanced";
    }
    case "scoring": {
      const prospects = await sql`
        select id, business_name from prospects
        where launch_id = ${p.launchId} and archived_at is null
          and benchmark_project_id is null
      `;
      let linked = 0;
      let findings = 0;
      for (const prospect of prospects) {
        const link = await svc.linkBenchmark(user, {
          prospectId: prospect.id as string,
          runId: p.runId!,
        });
        if (!link.ok) continue; // e.g. not scored in the run — stays manual
        linked += 1;
        await svc.computeProspectScore(user, { prospectId: prospect.id as string });
        const generated = await svc.generateFindings(user, {
          benchmarkId: link.data.benchmarkId,
        });
        if (generated.ok) findings += generated.data.candidateCount;
      }
      await appendLog(
        p.id,
        "scoring",
        `${linked} prospects linked and scored; ${findings} finding candidates staged. Next (yours): review findings, publish audits, approve outreach.`
      );
      await setStatus(p.id, "completed");
      return "done";
    }
    default:
      return "done";
  }
}

export interface PipelineTickReport {
  advanced: number;
  waiting: number;
  failed: number;
}

/** The tick lane: advance every active pipeline until it waits, completes,
 * or fails. Isolated per pipeline — one failure never blocks another. */
export async function advanceCityPipelines(): Promise<PipelineTickReport> {
  const report: PipelineTickReport = { advanced: 0, waiting: 0, failed: 0 };
  const rows = await sql`
    select * from city_prospecting_pipelines
    where status not in ('completed','failed')
    order by created_at asc
    limit 5
  `;
  for (const raw of rows) {
    let p = toRow(raw);
    // Advance through cheap transitions in one tick; stop on wait/done.
    for (let hops = 0; hops < 6; hops += 1) {
      try {
        const outcome = await step(p);
        if (outcome === "advanced") {
          report.advanced += 1;
          const next = await getCityProspecting(p.id);
          if (!next) break;
          p = next;
          continue;
        }
        if (outcome === "waiting") report.waiting += 1;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        await appendLog(p.id, "failed", message);
        await setStatus(p.id, "failed", { error: message.slice(0, 500) });
        logLine("warn", "prospect.city_pipeline_failed", { pipelineId: p.id, message });
        report.failed += 1;
        break;
      }
    }
  }
  return report;
}
