import { sql } from "@/db/client";
import type { PromptCategory } from "@/lib/constants";
import type { FrozenPrompt } from "@/lib/prompts/types";

export interface PromptSet {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface Prompt {
  id: string;
  promptSetId: string;
  text: string;
  category: PromptCategory;
  language: string;
  position: number;
  isHoldout: boolean;
  /** Intent tier 1–4 (migration 030); null = untiered (all historical prompts). */
  tier: number | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface PromptSetListItem extends PromptSet {
  promptCount: number;
  latestVersion: number | null;
  latestFrozenAt: Date | null;
}

export interface VersionSummary {
  id: string;
  version: number;
  frozenAt: Date;
  promptCount: number;
}

export interface PromptSetVersion {
  id: string;
  promptSetId: string;
  version: number;
  frozenPrompts: FrozenPrompt[];
  frozenBy: string | null;
  frozenAt: Date;
}

export async function listPromptSets(
  projectId: string
): Promise<PromptSetListItem[]> {
  return sql<PromptSetListItem[]>`
    select
      s.id, s.project_id, s.name, s.description, s.created_at, s.archived_at,
      (select count(*)::int from prompts p
        where p.prompt_set_id = s.id and p.archived_at is null) as prompt_count,
      v.version as latest_version,
      v.frozen_at as latest_frozen_at
    from prompt_sets s
    left join lateral (
      select version, frozen_at from prompt_set_versions
      where prompt_set_id = s.id
      order by version desc limit 1
    ) v on true
    where s.project_id = ${projectId} and s.archived_at is null
    order by s.created_at desc
  `;
}

export async function getPromptSet(setId: string): Promise<PromptSet | null> {
  const rows = await sql<PromptSet[]>`
    select id, project_id, name, description, created_at, archived_at
    from prompt_sets where id = ${setId}
  `;
  return rows[0] ?? null;
}

export async function listActivePrompts(setId: string): Promise<Prompt[]> {
  return sql<Prompt[]>`
    select id, prompt_set_id, text, category, language, position,
           is_holdout, tier, created_at, archived_at
    from prompts
    where prompt_set_id = ${setId} and archived_at is null
    order by position asc, created_at asc
  `;
}

export async function listVersionSummaries(
  setId: string
): Promise<VersionSummary[]> {
  return sql<VersionSummary[]>`
    select id, version, frozen_at,
           jsonb_array_length(frozen_prompts)::int as prompt_count
    from prompt_set_versions
    where prompt_set_id = ${setId}
    order by version desc
  `;
}

export async function getVersion(
  setId: string,
  version: number
): Promise<PromptSetVersion | null> {
  const rows = await sql<PromptSetVersion[]>`
    select id, prompt_set_id, version, frozen_prompts, frozen_by, frozen_at
    from prompt_set_versions
    where prompt_set_id = ${setId} and version = ${version}
  `;
  return rows[0] ?? null;
}

export async function getVersionById(
  versionId: string
): Promise<PromptSetVersion | null> {
  const rows = await sql<PromptSetVersion[]>`
    select id, prompt_set_id, version, frozen_prompts, frozen_by, frozen_at
    from prompt_set_versions
    where id = ${versionId}
  `;
  return rows[0] ?? null;
}
