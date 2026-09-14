import { sql } from "@/db/client";
import type { Sentiment } from "@/lib/constants";

export interface Mention {
  id: string;
  responseId: string;
  companyId: string;
  revision: number;
  mentioned: boolean;
  recommended: boolean;
  listPosition: number | null;
  sentiment: Sentiment;
  excerpt: string | null;
  citedUrls: string[];
  parserVersion: string;
  confidence: string;
  needsReview: boolean;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface ReviewQueueItem extends Mention {
  companyName: string;
  runId: string;
  runLabel: string;
  provider: string;
  model: string;
  responseText: string | null;
  projectId: string;
}

const COLUMNS = sql`m.id, m.response_id, m.company_id, m.revision, m.mentioned,
  m.recommended, m.list_position, m.sentiment, m.excerpt, m.cited_urls,
  m.parser_version, m.confidence, m.needs_review, m.reviewed_by, m.reviewed_at,
  m.created_at`;

/**
 * Current revision = highest revision per (response, company), for queries
 * whose mentions alias is `m`. Exported (cleanup 2026-08-18): the audit
 * found 26 hand-copied variants of this predicate across 21 files — one
 * fragment, embedded everywhere the alias allows.
 */
export const CURRENT_REVISION = sql`not exists (
  select 1 from mentions newer
  where newer.response_id = m.response_id
    and newer.company_id = m.company_id
    and newer.revision > m.revision
)`;
const CURRENT = CURRENT_REVISION;

/**
 * Public precedence (spec 141, lib/parsing/precedence.ts): the row `m` is the
 * highest VERIFIED revision of its (response, company) pair. Verified =
 * a human-reviewed row (reviewed_by set: human > machine), an explicit
 * verification_status 'verified', or a legacy classifier row
 * (mention-parser-v2+llm) with confidence >= 0.7 and no review flag.
 * Heuristic rows never qualify. Use only together with PUBLIC_BLOCKED_PAIR.
 */
const VERIFIED_ROW = sql`(
  x.verification_status = 'verified'
  or x.reviewed_by is not null
  or (x.verification_status is null and not x.needs_review
      and x.parser_version = 'mention-parser-v2+llm' and x.confidence >= 0.7)
)`;
export const PUBLIC_REVISION = sql`(
  (m.verification_status = 'verified'
   or m.reviewed_by is not null
   or (m.verification_status is null and not m.needs_review
       and m.parser_version = 'mention-parser-v2+llm' and m.confidence >= 0.7))
  and not exists (
    select 1 from mentions x
    where x.response_id = m.response_id and x.company_id = m.company_id
      and x.revision > m.revision and ${VERIFIED_ROW}
  )
)`;

/** A pair is blocked when a needs-manual-review row is newer than every
 * verified row (or no verified row exists). Correlates on `m`. */
export const PUBLIC_BLOCKED_PAIR = sql`(
  (m.reviewed_by is null and (m.verification_status = 'needs_manual_review'
   or (m.verification_status is null and (m.needs_review
       or (m.parser_version in ('mention-parser-v2+llm', 'mention-parser-v3+adjudication') and m.confidence < 0.7)))))
  and not exists (
    select 1 from mentions x
    where x.response_id = m.response_id and x.company_id = m.company_id
      and x.revision > m.revision and ${VERIFIED_ROW}
  )
)`;

export async function listReviewQueue(projectId: string): Promise<ReviewQueueItem[]> {
  return sql<ReviewQueueItem[]>`
    select ${COLUMNS}, c.name as company_name, r.run_id, runs.label as run_label,
      r.provider, r.model, r.response_text, runs.project_id
    from mentions m
    join companies c on c.id = m.company_id
    join responses r on r.id = m.response_id
    join runs on runs.id = r.run_id
    where m.needs_review and ${CURRENT} and runs.project_id = ${projectId}
    order by m.created_at asc
  `;
}

/** Pending review count for a run (current revisions only). */
export async function pendingReviewCount(runId: string): Promise<number> {
  const rows = await sql`
    select count(*)::int as n
    from mentions m
    join responses r on r.id = m.response_id
    where r.run_id = ${runId} and m.needs_review and ${CURRENT}
  `;
  return (rows[0]?.n as number) ?? 0;
}

/** Current-revision mentions for a run, joined to their response metadata. */
export async function currentMentionsForRun(runId: string): Promise<
  (Mention & { provider: string; responseId: string })[]
> {
  return sql<(Mention & { provider: string })[]>`
    select ${COLUMNS}, r.provider
    from mentions m
    join responses r on r.id = m.response_id
    where r.run_id = ${runId} and ${CURRENT}
  `;
}
