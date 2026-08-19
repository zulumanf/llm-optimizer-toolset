/**
 * Prompt coverage by segment (spec 063, coverage-v1). Turns "how visible are
 * we?" into "in WHICH questions are we present?" — per category, intent band,
 * audience, and price tier, using the attributes frozen into the version.
 *
 * Derived on read, never stored (the spec-036 precedent): re-reviews and
 * parser re-runs are always reflected. Counts, never bare percentages —
 * 3/4 and 30/40 are different claims.
 *
 * The compute functions are pure (known-answer tests, docs/09); only
 * runCoverage touches the database, via lazy imports so the pure part stays
 * importable without env.
 */
import type { FrozenPrompt } from "@/lib/prompts/types";
import { commercialIntentWeight } from "@/lib/scoring/intent";
import { HIGH_INTENT_THRESHOLD } from "@/lib/scoring/valuable";

// v2 (spec 087): adds the structured real-estate dimensions frozen since
// migration 082. Same math; only the segment key space widened.
export const COVERAGE_VERSION = "coverage-v2";

export const COVERAGE_DIMENSIONS = [
  "category",
  "intent",
  "audience",
  "price_tier",
  "neighborhood",
  "property_type",
  "building",
] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

/** Bucket label for prompts a dimension does not tag. */
export const UNSPECIFIED_SEGMENT = "unspecified";

export interface PromptPresence {
  /** ≥1 latest-revision mention of the subject in the prompt's responses. */
  mentioned: boolean;
  /** ≥1 of those mentions carries recommended = true. */
  recommended: boolean;
}

export interface CoverageRow {
  dimension: CoverageDimension;
  segment: string;
  promptCount: number;
  mentionedPrompts: number;
  recommendedPrompts: number;
}

/** The one high-intent definition (lib/scoring/valuable.ts), restated as a
 * band label — never a second threshold. */
export function intentBand(prompt: {
  tier?: number | null;
  category?: string | null;
}): "high intent" | "standard intent" {
  return commercialIntentWeight(prompt) >= HIGH_INTENT_THRESHOLD
    ? "high intent"
    : "standard intent";
}

function segmentOf(prompt: FrozenPrompt, dimension: CoverageDimension): string | null {
  switch (dimension) {
    case "category":
      return prompt.category;
    case "intent":
      return intentBand(prompt);
    case "audience":
      return prompt.audience ?? null;
    case "price_tier":
      return prompt.priceTier ?? null;
    case "neighborhood":
      return prompt.neighborhood ?? null;
    case "property_type":
      return prompt.propertyType ?? null;
    case "building":
      return prompt.building ?? null;
  }
}

/**
 * Coverage rows for one run's frozen prompts against the subject's presence.
 * Holdout prompts stay out of denominators (the scoring rule). A dimension
 * with zero tagged prompts is omitted entirely — "unspecified: 100%" is
 * noise, not honesty; where some prompts are tagged, untagged ones bucket
 * as "unspecified".
 */
export function computeCoverage(
  frozenPrompts: FrozenPrompt[],
  presence: Map<string, PromptPresence>
): CoverageRow[] {
  const eligible = frozenPrompts.filter((p) => !p.isHoldout);
  const rows: CoverageRow[] = [];

  for (const dimension of COVERAGE_DIMENSIONS) {
    const tagged = eligible.some((p) => segmentOf(p, dimension) != null);
    // category and intent always tag every prompt; the guard only ever
    // omits audience/price_tier on untagged (incl. pre-063) versions.
    if (!tagged) continue;

    const bySegment = new Map<string, CoverageRow>();
    for (const prompt of eligible) {
      const segment = segmentOf(prompt, dimension) ?? UNSPECIFIED_SEGMENT;
      const row =
        bySegment.get(segment) ??
        {
          dimension,
          segment,
          promptCount: 0,
          mentionedPrompts: 0,
          recommendedPrompts: 0,
        };
      const p = presence.get(prompt.promptId);
      row.promptCount += 1;
      if (p?.mentioned) row.mentionedPrompts += 1;
      if (p?.recommended) row.recommendedPrompts += 1;
      bySegment.set(segment, row);
    }
    rows.push(
      ...[...bySegment.values()].sort(
        (a, b) => b.promptCount - a.promptCount || a.segment.localeCompare(b.segment)
      )
    );
  }
  return rows;
}

/**
 * Subject coverage for one run, from the frozen snapshot and latest-revision
 * mentions (the computeScores revision rule). Null when the run, its frozen
 * version, or a subject company is missing — absence, not zeros.
 */
export async function runCoverage(runId: string): Promise<CoverageRow[] | null> {
  const { sql } = await import("@/db/client");
  const { getSubjectCompany } = await import("@/db/companies");

  const [run] = await sql`
    select r.project_id, v.frozen_prompts
    from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id = ${runId}
  `;
  if (!run?.frozenPrompts) return null;
  const subject = await getSubjectCompany(run.projectId as string);
  if (!subject) return null;

  const presenceRows = await sql`
    select res.prompt_id,
      bool_or(m.mentioned) as mentioned,
      bool_or(m.mentioned and m.recommended) as recommended
    from mentions m
    join responses res on res.id = m.response_id
    where res.run_id = ${runId}
      and res.error is null
      and m.company_id = ${subject.id}
      -- current-revision predicate: keep in sync with db/mentions.ts
      -- CURRENT_REVISION (inlined here so this module's db imports stay lazy)
      and not exists (
        select 1 from mentions newer
        where newer.response_id = m.response_id
          and newer.company_id = m.company_id
          and newer.revision > m.revision
      )
    group by res.prompt_id
  `;
  const presence = new Map<string, PromptPresence>(
    presenceRows.map((r) => [
      r.promptId as string,
      {
        mentioned: Boolean(r.mentioned),
        recommended: Boolean(r.recommended),
      },
    ])
  );
  return computeCoverage(run.frozenPrompts as FrozenPrompt[], presence);
}
