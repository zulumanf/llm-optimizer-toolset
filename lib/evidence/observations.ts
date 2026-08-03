/**
 * Metric drill-down (evidence spec): re-derive, from the immutable
 * observation data, the exact rows behind a reported metric. The row list
 * IS the metric — numerator and denominator are counted from it, and any
 * divergence from the stored score row is surfaced, never hidden.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { extractCitations } from "@/lib/ai/citations";
import { extractUrls } from "@/lib/parsing/prepass";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { stabilityLabel, type Stability } from "@/lib/evidence/stability";

// Metric names here MUST match the names scoring writes to `scores`
// (lib/scoring/metrics.ts). This list previously said "citation_rate" while
// scoring stored "citation_score", so the stored-score lookup below found
// nothing and `matchesStored` was vacuously true for citations — the one
// metric whose re-derivation check could never fail was the one that
// silently didn't run.
export const DRILLDOWN_METRICS = [
  "mention_rate",
  "recommendation_rate",
  "citation_score",
  "first_position_rate",
  "top_three_rate",
] as const;
export type DrilldownMetric = (typeof DRILLDOWN_METRICS)[number];

export interface ObservationRow {
  responseId: string;
  promptId: string;
  promptText: string;
  promptCategory: string;
  isHoldout: boolean;
  provider: string;
  model: string;
  repetition: number;
  createdAt: Date;
  refusal: boolean;
  errored: boolean;
  responseHash: string | null;
  mentioned: boolean;
  recommended: boolean;
  listPosition: number | null;
  topThree: boolean;
  cited: boolean;
  confidence: number | null;
  needsReview: boolean;
  parserVersion: string | null;
  positive: boolean; // per the selected metric
  eligible: boolean; // in the metric's denominator
}

export interface DrilldownResult {
  metric: DrilldownMetric;
  companyId: string;
  companyName: string;
  provider: string; // 'all' or a provider id
  numerator: number;
  denominator: number;
  value: number | null;
  storedValue: number | null;
  storedSampleSize: number | null;
  matchesStored: boolean;
  rows: ObservationRow[];
  holdoutRows: ObservationRow[];
  perPrompt: {
    promptId: string;
    promptText: string;
    isHoldout: boolean;
    stability: Stability;
  }[];
}

function positiveFor(metric: DrilldownMetric, row: {
  mentioned: boolean;
  recommended: boolean;
  cited: boolean;
  listPosition: number | null;
}): boolean {
  if (metric === "mention_rate") return row.mentioned;
  if (metric === "recommendation_rate") return row.recommended;
  // Position rates share mention_rate's denominator (all valid cells, docs/06
  // v1.1); a response with no list placement is simply not positive. The
  // per-response shape here already counts distinct responses, matching
  // scoring's firstPositionResponses/topThreeResponses sets.
  if (metric === "first_position_rate") return row.listPosition === 1;
  if (metric === "top_three_rate") {
    return row.listPosition !== null && row.listPosition <= 3;
  }
  // citation_score: this company's mention carries an owned citation
  return row.cited;
}

export async function drilldown(args: {
  runId: string;
  companyId?: string; // defaults to the project subject
  metric: DrilldownMetric;
  provider?: string; // 'all' (default) or provider id
  scoringVersion: string;
}): Promise<DrilldownResult | null> {
  const { runId, metric } = args;
  const provider = args.provider ?? "all";

  const [run] = await sql`
    select id, project_id, prompt_set_version_id from runs where id = ${runId}
  `;
  if (!run) return null;
  let companyId = args.companyId ?? null;
  if (!companyId) {
    const subject = await getSubjectCompany(run.projectId as string);
    if (!subject) return null;
    companyId = subject.id;
  }
  const [company] = await sql`select name from companies where id = ${companyId}`;
  if (!company) return null;

  const [version] = await sql`
    select frozen_prompts from prompt_set_versions
    where id = ${run.promptSetVersionId}
  `;
  const holdoutIds = new Set(
    ((version?.frozenPrompts as FrozenPrompt[] | null) ?? [])
      .filter((p) => p.isHoldout)
      .map((p) => p.promptId)
  );

  const rowsRaw = await sql`
    select r.id as response_id, r.prompt_id, r.prompt_text, r.provider,
      r.model, r.repetition, r.requested_at, r.refusal, r.response_hash,
      r.response_text, r.raw_payload,
      (r.error is not null) as errored,
      coalesce(
        (select p.category from prompt_set_versions v,
           jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, category text)
         where v.id = ${run.promptSetVersionId} and p."promptId" = r.prompt_id),
        'recommendation') as category,
      m.mentioned, m.recommended, m.list_position, m.cited_urls,
      m.confidence, m.needs_review, m.parser_version
    from responses r
    left join mentions m on m.response_id = r.id and m.company_id = ${companyId}
      and not exists (select 1 from mentions n
        where n.response_id = m.response_id and n.company_id = m.company_id
          and n.revision > m.revision)
    where r.run_id = ${runId}
    order by r.requested_at asc
  `;

  const all: ObservationRow[] = rowsRaw.map((r) => {
    const mentioned = Boolean(r.mentioned);
    const recommended = Boolean(r.recommended);
    const cited = Array.isArray(r.citedUrls) && r.citedUrls.length > 0;
    const listPosition = r.listPosition == null ? null : Number(r.listPosition);
    const errored = Boolean(r.errored);
    const inProvider = provider === "all" || r.provider === provider;
    // citation_score's denominator is "responses with any citation at all",
    // re-derived exactly as scoring derives it (lib/scoring/compute.ts):
    // in-text URLs or provider search citations in the immutable payload.
    const anyCitation =
      !errored &&
      metric === "citation_score" &&
      (extractUrls((r.responseText as string) ?? "").length > 0 ||
        extractCitations(r.provider as string, r.rawPayload).length > 0);
    return {
      responseId: r.responseId as string,
      promptId: r.promptId as string,
      promptText: r.promptText as string,
      promptCategory: r.category as string,
      isHoldout: holdoutIds.has(r.promptId as string),
      provider: r.provider as string,
      model: r.model as string,
      repetition: Number(r.repetition),
      createdAt: r.requestedAt as Date,
      refusal: Boolean(r.refusal),
      errored,
      responseHash: (r.responseHash as string | null) ?? null,
      mentioned,
      recommended,
      listPosition,
      topThree: listPosition != null && listPosition <= 3,
      cited,
      confidence: r.confidence == null ? null : Number(r.confidence),
      needsReview: Boolean(r.needsReview),
      parserVersion: (r.parserVersion as string | null) ?? null,
      positive: positiveFor(metric, { mentioned, recommended, cited, listPosition }),
      // Eligible = successful capture in provider scope, non-holdout
      // (errors excluded per docs/06; refusals count). For citation_score
      // the denominator additionally requires the response to carry any
      // citation — matching the stored metric's formula (docs/06).
      eligible:
        !errored &&
        inProvider &&
        !holdoutIds.has(r.promptId as string) &&
        (metric !== "citation_score" || anyCitation),
    };
  });

  const rows = all.filter((r) => r.eligible);
  const holdoutRows = all.filter(
    (r) => !r.errored && r.isHoldout && (provider === "all" || r.provider === provider)
  );
  const numerator = rows.filter((r) => r.positive).length;
  const denominator = rows.length;
  // Scoring stores sample_size as ALL valid in-scope responses, even for
  // citation_score, whose rate denominator is the with-citation subset.
  // Compare against the same basis or the check would fail while the value
  // matched.
  const sampleBasis = all.filter(
    (r) => !r.errored && !r.isHoldout && (provider === "all" || r.provider === provider)
  ).length;

  const [stored] = await sql`
    select value, sample_size from scores
    where run_id = ${runId} and company_id = ${companyId}
      and metric = ${metric} and provider = ${provider}
      and scoring_version = ${args.scoringVersion}
  `;
  const storedValue = stored ? Number(stored.value) : null;
  const value = denominator > 0 ? numerator / denominator : null;

  // Per-exact-prompt stability (repetitions of the same frozen prompt)
  const byPrompt = new Map<string, ObservationRow[]>();
  for (const r of [...rows, ...holdoutRows]) {
    const list = byPrompt.get(r.promptId) ?? [];
    list.push(r);
    byPrompt.set(r.promptId, list);
  }
  const perPrompt = [...byPrompt.entries()].map(([promptId, list]) => ({
    promptId,
    promptText: list[0]!.promptText,
    isHoldout: list[0]!.isHoldout,
    stability: stabilityLabel(
      list.filter((r) => r.positive).length,
      list.length
    ),
  }));

  return {
    metric,
    companyId,
    companyName: company.name as string,
    provider,
    numerator,
    denominator,
    value,
    storedValue,
    storedSampleSize: stored ? Number(stored.sampleSize) : null,
    matchesStored:
      storedValue == null ||
      (value != null && Math.abs(value - storedValue) < 1e-6 &&
        Number(stored?.sampleSize) === sampleBasis),
    rows,
    holdoutRows,
    perPrompt,
  };
}
