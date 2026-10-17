/**
 * Scoring v1.2 (docs/06, spec 151): per-company metrics computed per
 * INSTRUMENT (lib/scoring/estimates.ts) with statistical intervals in
 * score_estimates; the legacy `scores` rows are a compatibility projection
 * (provider rows only for single-instrument providers, 'all' = unweighted
 * mean across instruments). Scores are
 * written as new rows stamped with SCORING_VERSION — never recomputed in
 * place. The review gate blocks scoring until the run's queue is clear;
 * after REVIEW_TIMEOUT_HOURS, still-pending responses are excluded from N
 * and the exclusion is logged (docs/06).
 */
import { sql } from "@/db/client";
import { listCompaniesForProject } from "@/db/companies";
import { currentMentionsForRun, pendingReviewCount } from "@/db/mentions";
import { SCORING_VERSION, REVIEW_TIMEOUT_HOURS } from "@/lib/constants";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { extractUrls } from "@/lib/parsing/prepass";
import { extractCitations } from "@/lib/ai/citations";
import { CURRENT_REVISION } from "@/db/mentions";
import { computeEstimates } from "@/lib/scoring/estimates";
import { cohortForRun } from "@/db/measurement";
import { SCORING_WRITE_LOCK_KEY } from "@/db/scores";
import { computeLegacyV11, LEGACY_SCORING_VERSION } from "@/lib/scoring/legacy-v11";
import { extractServedModel } from "@/lib/ai/served-model";

export interface ComputeScoresOptions {
  /** Historical rescoring (scripts/rescore.ts) must not fire movement
   * events for weeks-old runs. Default true: live scoring publishes. */
  publishMovement?: boolean;
  /** Historical rescoring writes v1.2 only (false): adding v1.1 rows to an
   * old run would change what pre-cutover dashboards show. Live scoring
   * follows scoring_state.write_legacy. */
  writeLegacy?: boolean;
}

export async function computeScores(
  runId: string,
  options: ComputeScoresOptions = {}
): Promise<void> {
  const [run] = await sql`
    select id, status, project_id, prompt_set_version_id, started_at
    from runs where id = ${runId}
  `;
  if (!run) throw new ClassifiedError("not_found", `Run ${runId} not found.`);

  // Holdout prompts run but never enter standard metric denominators
  // (evidence spec). With zero holdout prompts the eligible set — and every
  // historical value — is unchanged (DECISIONS: no scoring-version bump).
  const [frozenVersion] = await sql`
    select frozen_prompts from prompt_set_versions
    where id = ${run.promptSetVersionId}
  `;
  const holdoutPromptIds = new Set(
    ((frozenVersion?.frozenPrompts as { promptId: string; isHoldout?: boolean }[] | null) ?? [])
      .filter((p) => p.isHoldout)
      .map((p) => p.promptId)
  );

  const pending = await pendingReviewCount(runId);
  let excludedResponseIds = new Set<string>();
  if (pending > 0) {
    const stale = await sql`
      select distinct m.response_id
      from mentions m
      join responses r on r.id = m.response_id
      where r.run_id = ${runId} and m.needs_review
        and m.created_at < now() - make_interval(hours => ${REVIEW_TIMEOUT_HOURS})
        and ${CURRENT_REVISION}
    `;
    const staleIds = new Set(stale.map((r) => r.responseId as string));
    const freshPending = pending - staleIds.size;
    if (freshPending > 0 || staleIds.size === 0) {
      throw new ClassifiedError(
        "conflict",
        `Run has ${pending} mentions awaiting review — scoring is blocked (docs/06).`
      );
    }
    excludedResponseIds = staleIds;
    log("warn", "scoring.excluded_pending_review", {
      runId,
      excluded: staleIds.size,
    });
  }

  // Valid cells: successful captures (refusals count; errors don't — docs/06)
  const allValidResponses = await sql`
    select id, provider, model, prompt_id, prompt_text, response_text,
      raw_payload, request_params, served_model
    from responses
    where run_id = ${runId} and error is null
  `;
  // The registry gate stops mock at the door, but a database that once ran
  // with ALLOW_MOCK_PROVIDER can hold mock captures; they must never fold
  // into real metrics or the cross-provider mean (plan 2.3). Scoring asks
  // the stricter question — mockScoringAllowed, not mockProviderAllowed —
  // because permission to RUN the mock (seeds, demos) is not permission to
  // count fabrications as measurements (spec 050).
  const { mockScoringAllowed } = await import("@/lib/ai/registry");
  const validResponses = mockScoringAllowed()
    ? allValidResponses
    : allValidResponses.filter((r) => r.provider !== "mock");
  if (validResponses.length < allValidResponses.length) {
    log("error", "scoring.mock_responses_excluded", {
      runId,
      excluded: allValidResponses.length - validResponses.length,
    });
  }
  for (const row of validResponses) {
    if (holdoutPromptIds.has(row.promptId as string)) {
      excludedResponseIds.add(row.id as string);
    }
  }
  const included = validResponses.filter(
    (r) => !excludedResponseIds.has(r.id as string)
  );
  if (included.length === 0) {
    log("warn", "scoring.no_valid_responses", { runId });
    return;
  }

  const responsesWithCitation = new Set<string>();
  for (const row of included) {
    // Cited = in-text URLs or search citations in the payload (lib/ai/citations)
    if (
      extractUrls((row.responseText as string) ?? "").length > 0 ||
      extractCitations(row.provider as string, row.rawPayload).length > 0
    ) {
      responsesWithCitation.add(row.id as string);
    }
  }

  const mentions = (await currentMentionsForRun(runId)).filter(
    (m) => !excludedResponseIds.has(m.responseId) && m.mentioned
  );
  // Project-scoped: other clients' subjects never enter this run's scores.
  // v1.2 (spec 151 A5): a frozen cohort, when the project has one, is the
  // scored universe and the share-of-voice denominator — the global registry
  // growing through prospect discovery can no longer move it.
  const projectCompanies = await listCompaniesForProject(run.projectId as string);
  const cohort = await cohortForRun(run.projectId as string, run.startedAt as Date);
  const cohortIds = cohort ? new Set(cohort.companyIds) : null;
  const companies = cohortIds
    ? projectCompanies.filter((c) => cohortIds.has(c.id))
    : projectCompanies;

  const { estimates, compat, instruments } = computeEstimates({
    runId,
    responses: included.map((r) => ({
      id: r.id as string,
      provider: r.provider as string,
      model: r.model as string,
      promptId: r.promptId as string,
      promptText: r.promptText as string,
      requestParams: r.requestParams,
      servedModel:
        (r.servedModel as string | null) ??
        extractServedModel(r.provider as string, r.rawPayload),
      hasAnyCitation: responsesWithCitation.has(r.id as string),
    })),
    mentions,
    companies,
  });
  const blendedProviders = [
    ...new Set(
      instruments
        .map((g) => g.provider)
        .filter((p, _, all) => all.filter((x) => x === p).length > 1)
    ),
  ];
  if (blendedProviders.length > 0) {
    // Not an error: the per-instrument estimates carry the numbers; only the
    // provider-level compatibility row is refused (spec 151 A3).
    log("info", "scoring.provider_row_refused_multi_instrument", { runId, providers: blendedProviders });
  }
  const rows = compat;
  // Release 151 cutover window. Inside ONE transaction holding the shared
  // scoring lock (the cutover takes it exclusively), so a flip can never land
  // between reading the switch and writing:
  //  - v1.1 rows (the original algorithm) go to `scores` while the legacy
  //    writer is on — dashboards stay complete for new runs;
  //  - v1.2 compatibility rows always go to `scores_staging`, and ALSO to
  //    `scores` once readers are on v1.2. Before the cutover `scores` holds
  //    v1.1 only, so a pre-151 application image can be redeployed safely.
  const legacyInput = {
    responses: included.map((r) => ({
      id: r.id as string,
      provider: r.provider as string,
      hasAnyCitation: responsesWithCitation.has(r.id as string),
    })),
    mentions,
    companyIds: projectCompanies.map((c) => c.id),
  };
  let legacyCount = 0;

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(${SCORING_WRITE_LOCK_KEY})`;
    const [state] = await tx`select read_version, write_legacy from scoring_state where id = 1`;
    const readVersion = (state?.readVersion as string | undefined) ?? "v1.1";
    const writeLegacy = ((state?.writeLegacy as boolean | undefined) ?? true) && options.writeLegacy !== false;
    const legacyRows = writeLegacy ? computeLegacyV11(legacyInput) : [];
    legacyCount = legacyRows.length;
    for (const row of rows) {
      await tx`
        insert into scores_staging
          (run_id, company_id, metric, provider, value, sample_size, scoring_version)
        values
          (${runId}, ${row.companyId}, ${row.metric}, ${row.provider},
           ${Number(row.value.toFixed(6))}, ${row.sampleSize}, ${SCORING_VERSION})
        on conflict (run_id, company_id, metric, provider, scoring_version)
        do nothing
      `;
      if (readVersion === SCORING_VERSION) {
        await tx`
          insert into scores
            (run_id, company_id, metric, provider, value, sample_size, scoring_version)
          values
            (${runId}, ${row.companyId}, ${row.metric}, ${row.provider},
             ${Number(row.value.toFixed(6))}, ${row.sampleSize}, ${SCORING_VERSION})
          on conflict (run_id, company_id, metric, provider, scoring_version)
          do nothing
        `;
      }
    }
    for (const row of legacyRows) {
      await tx`
        insert into scores
          (run_id, company_id, metric, provider, value, sample_size, scoring_version)
        values
          (${runId}, ${row.companyId}, ${row.metric}, ${row.provider},
           ${Number(row.value.toFixed(6))}, ${row.sampleSize}, ${LEGACY_SCORING_VERSION})
        on conflict (run_id, company_id, metric, provider, scoring_version)
        do nothing
      `;
    }
    for (const e of estimates) {
      const round = (v: number | null | undefined) =>
        v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(6));
      await tx`
        insert into score_estimates
          (run_id, company_id, metric, provider, model, instrument_key, served_models,
           numerator, denominator, distinct_prompts, excluded_echo, rate,
           wilson_low, wilson_high, clustered_low, clustered_high, icc,
           cohort_id, scoring_version)
        values
          (${runId}, ${e.companyId}, ${e.metric}, ${e.provider}, ${e.model},
           ${e.instrumentKey}, ${e.servedModels}, ${e.numerator}, ${e.denominator},
           ${e.distinctPrompts}, ${e.excludedEcho}, ${round(e.rate)},
           ${round(e.wilson?.[0])}, ${round(e.wilson?.[1])},
           ${round(e.clustered?.[0])}, ${round(e.clustered?.[1])}, ${round(e.icc)},
           ${cohort?.id ?? null}, ${SCORING_VERSION})
        on conflict (run_id, company_id, metric, instrument_key, scoring_version)
        do nothing
      `;
    }
  });
  log("info", "scoring.computed", { runId, rows: rows.length, legacyRows: legacyCount, estimates: estimates.length });

  // Movement events (spec 030 / roadmap 2.6): a material decline is
  // published exactly once per (run, metric) — the dedupe key, not the
  // caller, guarantees a re-score cannot double-fire the automation layer.
  // Catalogue type visibility.materially_declined existed producer-less
  // since migration 020.
  if (options.publishMovement === false) return;
  try {
    const { movementForProject } = await import("@/lib/competitors/movement");
    const { publishEvent } = await import("@/lib/events/bus");
    const drops = (await movementForProject(run.projectId as string)).filter(
      (event) => event.kind === "visibility_drop"
    );
    for (const drop of drops) {
      await publishEvent(sql, {
        type: "visibility.materially_declined",
        projectId: run.projectId as string,
        payload: {
          metric: drop.metric,
          previous: drop.previous,
          current: drop.current,
          deltaPct: Number(((drop.current - drop.previous) * 100).toFixed(2)),
          sampleSize: drop.sampleSize,
          periodStart: drop.periodStart ?? "",
          periodEnd: drop.periodEnd ?? "",
          material: true,
        },
        dedupeKey: `visibility-drop:${runId}:${drop.metric}`,
      });
    }
  } catch (err) {
    // Scores are committed; an event hiccup must not fail the job.
    log("warn", "scoring.movement_events_failed", {
      runId,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}
