/**
 * Head-to-head win rates (spec 036). Derived on read, never stored — same
 * stance as movement (spec 030): storing would demand scoring-version
 * ceremony for a number that is cheap to re-derive. One verdict per
 * response per (self, competitor): mentioned-only beats absent; between
 * two mentions a lower list position wins; an unranked co-mention is a
 * tie, not a loss. Errored cells and holdout prompts are excluded — the
 * same eligibility scoring uses.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { listCompetitorsIncludingArchived } from "@/db/competitors";
import { latestScoredRunId } from "@/db/dashboard";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { CURRENT_REVISION } from "@/db/mentions";

export const HEAD_TO_HEAD_VERSION = "head-to-head-v1";

export interface ResponseSide {
  responseId: string;
  promptId: string;
  promptText: string;
  mentioned: boolean;
  listPosition: number | null;
}

export type ContestOutcome = "self_win" | "competitor_win" | "tie" | "uncontested";

/** The verdict table from the spec — pure, one response at a time. */
export function contestOutcome(
  self: { mentioned: boolean; listPosition: number | null },
  competitor: { mentioned: boolean; listPosition: number | null }
): ContestOutcome {
  if (!self.mentioned && !competitor.mentioned) return "uncontested";
  if (self.mentioned && !competitor.mentioned) return "self_win";
  if (!self.mentioned && competitor.mentioned) return "competitor_win";
  if (self.listPosition !== null && competitor.listPosition !== null) {
    if (self.listPosition < competitor.listPosition) return "self_win";
    if (self.listPosition > competitor.listPosition) return "competitor_win";
    return "tie";
  }
  return "tie"; // both mentioned, unranked — a co-mention is not a loss
}

export interface HeadToHeadRow {
  companyId: string;
  companyName: string;
  archived: boolean;
  contested: number;
  selfWins: number;
  competitorWins: number;
  ties: number;
  /** null when nothing was contested — never a fabricated 0. */
  winRate: number | null;
  /** Prompts (deduped) where this competitor beat the subject. */
  losingPrompts: string[];
}

export interface HeadToHeadResult {
  version: string;
  runId: string | null;
  selfCompanyId: string | null;
  rows: HeadToHeadRow[];
}

interface MentionLite {
  responseId: string;
  companyId: string;
  mentioned: boolean;
  listPosition: number | null;
}

interface ResponseLite {
  responseId: string;
  promptId: string;
  promptText: string;
}

/** Pure core, fixture-testable: responses = eligible cells only. */
export function computeHeadToHead(args: {
  selfId: string;
  competitors: { companyId: string; companyName: string; archived?: boolean }[];
  responses: ResponseLite[];
  mentions: MentionLite[];
}): Omit<HeadToHeadResult, "runId" | "selfCompanyId"> & { selfCompanyId: string } {
  const byResponse = new Map<string, Map<string, MentionLite>>();
  for (const m of args.mentions) {
    const inner = byResponse.get(m.responseId) ?? new Map<string, MentionLite>();
    inner.set(m.companyId, m);
    byResponse.set(m.responseId, inner);
  }
  const absent = { mentioned: false, listPosition: null };

  const rows: HeadToHeadRow[] = args.competitors.map((competitor) => {
    let contested = 0;
    let selfWins = 0;
    let competitorWins = 0;
    let ties = 0;
    const losing = new Set<string>();

    for (const response of args.responses) {
      const inResponse = byResponse.get(response.responseId);
      const self = inResponse?.get(args.selfId) ?? absent;
      const comp = inResponse?.get(competitor.companyId) ?? absent;
      const outcome = contestOutcome(self, comp);
      if (outcome === "uncontested") continue;
      contested += 1;
      if (outcome === "self_win") selfWins += 1;
      else if (outcome === "competitor_win") {
        competitorWins += 1;
        losing.add(response.promptText);
      } else ties += 1;
    }

    return {
      companyId: competitor.companyId,
      companyName: competitor.companyName,
      archived: competitor.archived ?? false,
      contested,
      selfWins,
      competitorWins,
      ties,
      winRate: contested > 0 ? selfWins / contested : null,
      losingPrompts: [...losing],
    };
  });

  return { version: HEAD_TO_HEAD_VERSION, selfCompanyId: args.selfId, rows };
}

/** Eligible responses (non-errored, non-holdout) + current mentions for a run. */
async function loadRun(runId: string): Promise<{
  responses: ResponseLite[];
  mentions: MentionLite[];
}> {
  const [version] = await sql`
    select v.frozen_prompts from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id = ${runId}
  `;
  const holdouts = new Set(
    ((version?.frozenPrompts as FrozenPrompt[] | null) ?? [])
      .filter((p) => p.isHoldout)
      .map((p) => p.promptId)
  );
  const responseRows = await sql`
    select id as response_id, prompt_id, prompt_text from responses
    where run_id = ${runId} and error is null
  `;
  const responses = responseRows
    .map((r) => ({
      responseId: r.responseId as string,
      promptId: r.promptId as string,
      promptText: r.promptText as string,
    }))
    .filter((r) => !holdouts.has(r.promptId));

  const mentionRows = await sql`
    select m.response_id, m.company_id, m.mentioned, m.list_position
    from mentions m
    join responses r on r.id = m.response_id
    where r.run_id = ${runId}
      and ${CURRENT_REVISION}
  `;
  return {
    responses,
    mentions: mentionRows.map((m) => ({
      responseId: m.responseId as string,
      companyId: m.companyId as string,
      mentioned: Boolean(m.mentioned),
      listPosition: m.listPosition == null ? null : Number(m.listPosition),
    })),
  };
}

export async function headToHeadForProject(
  projectId: string,
  runId?: string
): Promise<HeadToHeadResult> {
  const targetRun = runId ?? (await latestScoredRunId(projectId));
  const subject = await getSubjectCompany(projectId);
  if (!targetRun || !subject) {
    return {
      version: HEAD_TO_HEAD_VERSION,
      runId: targetRun,
      selfCompanyId: subject?.id ?? null,
      rows: [],
    };
  }
  const competitors = await listCompetitorsIncludingArchived(projectId);
  const { responses, mentions } = await loadRun(targetRun);
  const computed = computeHeadToHead({
    selfId: subject.id,
    competitors,
    responses,
    mentions,
  });
  return { ...computed, runId: targetRun };
}
