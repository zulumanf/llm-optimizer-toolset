/** Persistence for citation map targets (spec 141). */
import { sql } from "@/db/client";
import {
  canTransitionCitationTarget,
  scoreCitationTarget,
  type CitationMapStatus,
  type CitationTargetInput,
  type PlacementMovement,
} from "@/lib/citations/citation-map";
import type { SourceType } from "@/lib/sources/classify";

export type CitationMapTargetInsert = {
  projectId: string;
  opportunityId?: string | null;
  targetPhrase: string;
  market: string;
  provider: string;
  modelLabel: string;
  promptId?: string | null;
  citedUrl: string;
  citedDomain: string;
  sourceClass: SourceType;
  pageType?: string;
  publicationDate?: Date | null;
  authorOrEditor?: string | null;
  contactUrl?: string | null;
  proposedContribution?: string | null;
  createdBy?: string | null;
  scoring: CitationTargetInput;
};

export async function insertCitationMapTarget(t: CitationMapTargetInsert): Promise<string> {
  const s = scoreCitationTarget(t.scoring);
  const [row] = await sql`
    insert into citation_map_targets (project_id, opportunity_id, target_phrase, market, provider, model_label, prompt_id,
      cited_url, cited_domain, source_class, citation_frequency, competitor_presence, page_type, publication_date,
      relevance_score, insertability_score, priority_score, priority_components, priority_version,
      author_or_editor, contact_url, proposed_contribution, created_by, last_checked_at)
    values (${t.projectId}, ${t.opportunityId ?? null}, ${t.targetPhrase}, ${t.market}, ${t.provider}, ${t.modelLabel}, ${t.promptId ?? null},
      ${t.citedUrl}, ${t.citedDomain}, ${t.sourceClass}, ${t.scoring.answersCiting}, ${t.scoring.competitorsPresent}, ${t.pageType ?? "other"},
      ${t.publicationDate ?? null}, ${t.scoring.topicRelevance}, ${t.scoring.insertability}, ${s.score}, ${sql.json(s.components)}, ${s.version},
      ${t.authorOrEditor ?? null}, ${t.contactUrl ?? null}, ${t.proposedContribution ?? null}, ${t.createdBy ?? null}, now())
    on conflict (project_id, cited_url, provider) do update set
      citation_frequency = excluded.citation_frequency, competitor_presence = excluded.competitor_presence,
      relevance_score = excluded.relevance_score, insertability_score = excluded.insertability_score,
      priority_score = excluded.priority_score, priority_components = excluded.priority_components,
      priority_version = excluded.priority_version, last_checked_at = now(), updated_at = now()
    returning id`;
  return row!.id as string;
}

export async function transitionCitationMapTarget(
  id: string,
  to: CitationMapStatus,
  patch: { livePlacementUrl?: string; recheckOn?: Date; contactUrl?: string; authorOrEditor?: string } = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await sql`select status from citation_map_targets where id = ${id}`;
  if (!row) return { ok: false, reason: "not_found" };
  const from = row.status as CitationMapStatus;
  if (!canTransitionCitationTarget(from, to)) return { ok: false, reason: `illegal_transition:${from}->${to}` };
  await sql`
    update citation_map_targets set status = ${to},
      live_placement_url = coalesce(${patch.livePlacementUrl ?? null}, live_placement_url),
      recheck_on = coalesce(${patch.recheckOn ?? null}, recheck_on),
      contact_url = coalesce(${patch.contactUrl ?? null}, contact_url),
      author_or_editor = coalesce(${patch.authorOrEditor ?? null}, author_or_editor),
      updated_at = now()
    where id = ${id}`;
  return { ok: true };
}

/** Records the before/after observation; the transition to `remeasured`
 * is the only way movement lands, so a movement always has both runs. */
export async function recordCitationMapRemeasurement(id: string, movement: PlacementMovement): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await transitionCitationMapTarget(id, "remeasured");
  if (!result.ok) return result;
  await sql`
    update citation_map_targets set baseline_run_id = ${movement.baselineRunId}, remeasure_run_id = ${movement.remeasureRunId},
      citation_change_after_placement = ${sql.json(movement)}, updated_at = now()
    where id = ${id}`;
  return { ok: true };
}

export async function listCitationMapTargets(projectId: string, status?: CitationMapStatus) {
  return sql`
    select id, target_phrase, market, provider, model_label, cited_url, cited_domain, source_class, citation_frequency,
      competitor_presence, page_type, publication_date, last_checked_at, priority_score, status, author_or_editor,
      contact_url, proposed_contribution, live_placement_url, recheck_on, citation_change_after_placement
    from citation_map_targets
    where project_id = ${projectId} ${status ? sql`and status = ${status}` : sql``}
    order by priority_score desc nulls last, cited_domain`;
}
