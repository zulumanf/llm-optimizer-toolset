/**
 * Scoring v1.0 (docs/06): mention_rate and recommendation_rate, computed per
 * provider then as an unweighted cross-provider mean ('all'). Scores are
 * written as new rows stamped with SCORING_VERSION — never recomputed in
 * place. The review gate blocks scoring until the run's queue is clear;
 * after REVIEW_TIMEOUT_HOURS, still-pending responses are excluded from N
 * and the exclusion is logged (docs/06).
 */
import { sql } from "@/db/client";
import { listActiveCompanies } from "@/db/companies";
import { currentMentionsForRun, pendingReviewCount } from "@/db/mentions";
import { SCORING_VERSION, REVIEW_TIMEOUT_HOURS } from "@/lib/constants";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { extractUrls } from "@/lib/parsing/prepass";
import {
  computeProviderMetrics,
  authorityScore,
  aggregateAcrossProviders,
  type ComponentMetric,
  type MetricValues,
} from "@/lib/scoring/metrics";

export async function computeScores(runId: string): Promise<void> {
  const [run] = await sql`select id, status from runs where id = ${runId}`;
  if (!run) throw new ClassifiedError("not_found", `Run ${runId} not found.`);

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
  const validResponses = await sql`
    select id, provider, response_text from responses
    where run_id = ${runId} and error is null
  `;
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
    if (extractUrls((row.responseText as string) ?? "").length > 0) {
      responsesWithCitation.add(row.id as string);
    }
  }

  const mentions = (await currentMentionsForRun(runId)).filter(
    (m) => !excludedResponseIds.has(m.responseId) && m.mentioned
  );
  const companies = await listActiveCompanies();

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
          (v) => v[metric as ComponentMetric]
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
}
