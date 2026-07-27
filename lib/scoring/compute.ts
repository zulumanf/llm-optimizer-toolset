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
    select id, provider from responses
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
  for (const row of included) {
    const provider = row.provider as string;
    if (!byProvider.has(provider)) byProvider.set(provider, new Set());
    byProvider.get(provider)!.add(row.id as string);
  }

  const mentions = (await currentMentionsForRun(runId)).filter(
    (m) => !excludedResponseIds.has(m.responseId)
  );
  const companies = await listActiveCompanies();

  interface Rate {
    metric: "mention_rate" | "recommendation_rate";
    provider: string;
    value: number;
    sampleSize: number;
  }

  const rows: (Rate & { companyId: string })[] = [];
  for (const company of companies) {
    const perProvider: Record<"mention_rate" | "recommendation_rate", number[]> = {
      mention_rate: [],
      recommendation_rate: [],
    };
    for (const [provider, responseIds] of byProvider) {
      const n = responseIds.size;
      const companyMentions = mentions.filter(
        (m) =>
          m.companyId === company.id &&
          m.mentioned &&
          responseIds.has(m.responseId)
      );
      const mentionedResponses = new Set(companyMentions.map((m) => m.responseId));
      const recommendedResponses = new Set(
        companyMentions.filter((m) => m.recommended).map((m) => m.responseId)
      );
      const mentionRate = mentionedResponses.size / n;
      const recommendationRate = recommendedResponses.size / n;
      rows.push(
        { companyId: company.id, metric: "mention_rate", provider, value: mentionRate, sampleSize: n },
        { companyId: company.id, metric: "recommendation_rate", provider, value: recommendationRate, sampleSize: n }
      );
      perProvider.mention_rate.push(mentionRate);
      perProvider.recommendation_rate.push(recommendationRate);
    }
    // Cross-provider aggregate: unweighted mean (docs/06)
    for (const metric of ["mention_rate", "recommendation_rate"] as const) {
      const values = perProvider[metric];
      if (values.length === 0) continue;
      rows.push({
        companyId: company.id,
        metric,
        provider: "all",
        value: values.reduce((a, b) => a + b, 0) / values.length,
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
