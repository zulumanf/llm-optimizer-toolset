/**
 * Scoring v1.1 (docs/06): per-company metrics computed per provider then as
 * an unweighted cross-provider mean ('all'). Scores are
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
import {
  computeProviderMetrics,
  authorityScore,
  aggregateAcrossProviders,
  type ScoredMetric,
  type MetricValues,
} from "@/lib/scoring/metrics";

export async function computeScores(runId: string): Promise<void> {
  const [run] = await sql`
    select id, status, project_id, prompt_set_version_id
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
        and not exists (
          select 1 from mentions newer
          where newer.response_id = m.response_id
            and newer.company_id = m.company_id
            and newer.revision > m.revision
        )
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
    select id, provider, prompt_id, response_text, raw_payload from responses
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

  const byProvider = new Map<string, Set<string>>();
  const responsesWithCitation = new Set<string>();
  for (const row of included) {
    const provider = row.provider as string;
    if (!byProvider.has(provider)) byProvider.set(provider, new Set());
    byProvider.get(provider)!.add(row.id as string);
    // Cited = in-text URLs or search citations in the payload (lib/ai/citations)
    if (
      extractUrls((row.responseText as string) ?? "").length > 0 ||
      extractCitations(provider, row.rawPayload).length > 0
    ) {
      responsesWithCitation.add(row.id as string);
    }
  }

  const mentions = (await currentMentionsForRun(runId)).filter(
    (m) => !excludedResponseIds.has(m.responseId) && m.mentioned
  );
  // Project-scoped: other clients' subjects never enter this run's scores
  const companies = await listCompaniesForProject(run.projectId as string);

  interface ScoreInsert {
    companyId: string;
    metric: string;
    provider: string;
    value: number;
    sampleSize: number;
  }
  const rows: ScoreInsert[] = [];

  for (const company of companies) {
    const perProviderValues: Record<string, MetricValues> = {};
    const perProviderAuthority: (number | null)[] = [];

    for (const [provider, responseIds] of byProvider) {
      const providerMentions = mentions.filter((m) => responseIds.has(m.responseId));
      const companyMentions = providerMentions.filter(
        (m) => m.companyId === company.id
      );
      const mentionedResponses = new Set(companyMentions.map((m) => m.responseId));

      const values = computeProviderMetrics({
        n: responseIds.size,
        mentionedResponses: mentionedResponses.size,
        recommendedResponses: new Set(
          companyMentions.filter((m) => m.recommended).map((m) => m.responseId)
        ).size,
        companyMentions: mentionedResponses.size,
        totalTrackedMentions: new Set(
          providerMentions.map((m) => `${m.companyId}|${m.responseId}`)
        ).size,
        listPositions: companyMentions
          .map((m) => m.listPosition)
          .filter((p): p is number => p !== null),
        // Distinct responses, not mention rows — a rate's numerator must
        // count in the same unit as its denominator N.
        firstPositionResponses: new Set(
          companyMentions
            .filter((m) => m.listPosition === 1)
            .map((m) => m.responseId)
        ).size,
        topThreeResponses: new Set(
          companyMentions
            .filter((m) => m.listPosition !== null && m.listPosition <= 3)
            .map((m) => m.responseId)
        ).size,
        sentiments: companyMentions.map((m) => m.sentiment),
        citedResponses: new Set(
          companyMentions.filter((m) => m.citedUrls.length > 0).map((m) => m.responseId)
        ).size,
        responsesWithAnyCitation: [...responseIds].filter((id) =>
          responsesWithCitation.has(id)
        ).length,
      });
      perProviderValues[provider] = values;

      for (const [metric, value] of Object.entries(values)) {
        if (value === null || value === undefined) continue;
        rows.push({
          companyId: company.id,
          metric,
          provider,
          value,
          sampleSize: responseIds.size,
        });
      }
      const authority = authorityScore(values);
      perProviderAuthority.push(authority);
      if (authority !== null) {
        rows.push({
          companyId: company.id,
          metric: "authority_score",
          provider,
          value: authority,
          sampleSize: responseIds.size,
        });
      }
    }

    // Cross-provider aggregates: unweighted mean per metric (docs/06)
    const metricKeys = new Set<string>(
      Object.values(perProviderValues).flatMap((v) => Object.keys(v))
    );
    for (const metric of metricKeys) {
      const aggregate = aggregateAcrossProviders(
        Object.values(perProviderValues).map(
          (v) => v[metric as ScoredMetric]
        )
      );
      if (aggregate === null) continue;
      rows.push({
        companyId: company.id,
        metric,
        provider: "all",
        value: aggregate,
        sampleSize: included.length,
      });
    }
    const aggregateAuthority = aggregateAcrossProviders(perProviderAuthority);
    if (aggregateAuthority !== null) {
      rows.push({
        companyId: company.id,
        metric: "authority_score",
        provider: "all",
        value: aggregateAuthority,
        sampleSize: included.length,
      });
    }
  }

  await sql.begin(async (tx) => {
    for (const row of rows) {
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
  });
  log("info", "scoring.computed", { runId, rows: rows.length });

  // Movement events (spec 030 / roadmap 2.6): a material decline is
  // published exactly once per (run, metric) — the dedupe key, not the
  // caller, guarantees a re-score cannot double-fire the automation layer.
  // Catalogue type visibility.materially_declined existed producer-less
  // since migration 020.
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
