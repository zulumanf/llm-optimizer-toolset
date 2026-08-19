/**
 * AI Recommendation Share (spec 087): of the answers that recommended any
 * tracked company, how many recommended the subject — overall and per
 * provider, cluster, and real-estate dimension, so one healthy aggregate can
 * never hide a high-intent blind spot.
 *
 * Distinct from share_of_voice (mention share, lib/scoring/metrics.ts): the
 * unit here is a recommendation moment — a valid response where at least one
 * tracked company was recommended (echo-excluded, the organic rule). Raw
 * counts always travel with the rate; small segments return
 * insufficient_data, never 0%.
 *
 * Derived on read, never stored. Pure core; runRecommendationShare touches
 * the database via lazy imports.
 */
import type { FrozenPrompt } from "@/lib/prompts/types";
import type { RunMentionRow, ValidResponseRow } from "@/db/displacement";
import {
  DISPLACEMENT_DIMENSIONS,
  dimensionSegment,
  promptContexts,
  type DisplacementDimension,
  type PromptContext,
} from "@/lib/competitors/displacement";

export const REC_SHARE_VERSION = "recommendation-share-v1";

/** Below this many recommendation moments a share is noise (mirrors
 * MIN_STABLE_SAMPLE, lib/prospects/diagnose.ts). */
export const MIN_RECOMMENDATION_MOMENTS = 6;

export interface ShareRow {
  segment: string;
  /** Moments recommending the subject. */
  subjectMoments: number;
  /** Moments recommending any tracked company. */
  totalMoments: number;
  /** subjectMoments / totalMoments, or null when insufficient. */
  share: number | null;
  status: "ok" | "insufficient_data";
}

export interface RecommendationShareResult {
  version: string;
  runId: string;
  subjectCompanyId: string;
  overall: ShareRow;
  byProvider: ShareRow[];
  byCluster: ShareRow[];
  byDimension: Partial<Record<DisplacementDimension, ShareRow[]>>;
}

function finishRow(
  segment: string,
  subjectMoments: number,
  totalMoments: number
): ShareRow {
  const sufficient = totalMoments >= MIN_RECOMMENDATION_MOMENTS;
  return {
    segment,
    subjectMoments,
    totalMoments,
    share: sufficient ? subjectMoments / totalMoments : null,
    status: sufficient ? "ok" : "insufficient_data",
  };
}

/**
 * Pure computation. Callers guarantee valid responses (error is null, mock
 * filtered) and current-revision mentions belonging to those responses.
 */
export function computeRecommendationShare(input: {
  runId: string;
  subjectCompanyId: string;
  responses: ValidResponseRow[];
  mentions: RunMentionRow[];
  contexts: Map<string, PromptContext>;
}): RecommendationShareResult {
  const { runId, subjectCompanyId, contexts } = input;
  const responses = input.responses.filter(
    (r) => !(contexts.get(r.promptId)?.isHoldout ?? false)
  );
  const responseById = new Map(responses.map((r) => [r.id, r]));

  // A moment = a response with ≥1 organic (non-echoed) recommendation of a
  // tracked company. The subject's own echoed recommendations are excluded
  // by the same rule — no asymmetry.
  const momentResponses = new Set<string>();
  const subjectResponses = new Set<string>();
  for (const m of input.mentions) {
    if (!responseById.has(m.responseId)) continue;
    if (!m.mentioned || !m.recommended || m.promptEchoed) continue;
    momentResponses.add(m.responseId);
    if (m.companyId === subjectCompanyId) subjectResponses.add(m.responseId);
  }

  const overall = finishRow("overall", subjectResponses.size, momentResponses.size);

  const tally = (segmentOf: (responseId: string) => string | null): ShareRow[] => {
    const totals = new Map<string, { subject: number; total: number }>();
    for (const id of momentResponses) {
      const segment = segmentOf(id);
      if (segment == null) continue;
      const t = totals.get(segment) ?? { subject: 0, total: 0 };
      t.total += 1;
      if (subjectResponses.has(id)) t.subject += 1;
      totals.set(segment, t);
    }
    return [...totals.entries()]
      .map(([segment, t]) => finishRow(segment, t.subject, t.total))
      .sort(
        (a, b) => b.totalMoments - a.totalMoments || a.segment.localeCompare(b.segment)
      );
  };

  const ctxOf = (id: string): PromptContext | undefined => {
    const r = responseById.get(id);
    return r ? contexts.get(r.promptId) : undefined;
  };

  const byDimension: Partial<Record<DisplacementDimension, ShareRow[]>> = {};
  for (const dim of DISPLACEMENT_DIMENSIONS) {
    const rows = tally((id) => {
      const ctx = ctxOf(id);
      return ctx ? dimensionSegment(ctx, dim) : null;
    });
    if (rows.length > 0) byDimension[dim] = rows;
  }

  return {
    version: REC_SHARE_VERSION,
    runId,
    subjectCompanyId,
    overall,
    byProvider: tally((id) => responseById.get(id)?.provider ?? null),
    byCluster: tally((id) => ctxOf(id)?.clusterLabel ?? null),
    byDimension,
  };
}

/** Recommendation share for one run. Null when the run, frozen version, or
 * subject is missing — absence, not zeros. */
export async function runRecommendationShare(
  runId: string,
  options: { subjectCompanyId?: string } = {}
): Promise<RecommendationShareResult | null> {
  const { sql } = await import("@/db/client");
  const { getSubjectCompany } = await import("@/db/companies");
  const { validResponsesForRun, currentMentionsWithEcho } = await import(
    "@/db/displacement"
  );
  const { mockScoringAllowed } = await import("@/lib/ai/registry");

  const [run] = await sql`
    select r.project_id, v.frozen_prompts
    from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id = ${runId}
  `;
  if (!run?.frozenPrompts) return null;

  let subjectCompanyId = options.subjectCompanyId;
  if (!subjectCompanyId) {
    const subject = await getSubjectCompany(run.projectId as string);
    if (!subject) return null;
    subjectCompanyId = subject.id;
  }

  const allResponses = await validResponsesForRun(runId);
  const responses = mockScoringAllowed()
    ? allResponses
    : allResponses.filter((r) => r.provider !== "mock");
  const responseIds = new Set(responses.map((r) => r.id));
  const mentions = (await currentMentionsWithEcho(runId)).filter((m) =>
    responseIds.has(m.responseId)
  );

  return computeRecommendationShare({
    runId,
    subjectCompanyId,
    responses,
    mentions,
    contexts: promptContexts(run.frozenPrompts as FrozenPrompt[]),
  });
}
