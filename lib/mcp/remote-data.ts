/**
 * Read-only data access for the remote MCP tools (spec 126).
 *
 * Grok vocabulary → schema: market = market_launches (+ markets metro),
 * team = prospects, capture = a runs row linked via prospect_benchmarks.
 * Classification is current-revision `mentions` (the exported CURRENT
 * idiom); citations are `response_citations`. Nothing here recomputes what
 * the scoring engine stored — counts are read the same way the audit and
 * mismatch surfaces read them.
 *
 * Every function returns plain snake_case objects shaped exactly like the
 * tool contract, or a structured `{ error }` code — never a fabricated zero.
 */
import { sql } from "@/db/client";
import { CURRENT, runSummary } from "@/lib/prospects/benchmark";
import {
  buildEmailBrief,
  type EmailBrief,
  type EmailBriefCapture,
} from "@/lib/mcp/email-brief";

export const TEAMS_LIMIT_DEFAULT = 25;
export const TEAMS_LIMIT_MAX = 50;
export const ANSWERS_LIMIT_DEFAULT = 10;
export const ANSWERS_LIMIT_MAX = 20;
export const SOURCES_LIMIT_DEFAULT = 15;
export const SOURCES_LIMIT_MAX = 50;
export const SENDS_LIMIT_DEFAULT = 25;
export const SENDS_LIMIT_MAX = 100;
export const EXCERPT_MAX_CHARS = 500;
const TOP_RECOMMENDED_LIMIT = 5;
const TOP_DOMAINS_LIMIT = 10;

/** Launch statuses that mean the market is exclusively taken. */
const LOCKED_STATUSES = ["protected", "partner_selected"];
const ENGAGED_STAGE = "contracted";
const CLOSED_STAGE = "closed_lost";

export type RemoteDataError = {
  error: "not_found" | "no_capture" | "not_configured";
  [key: string]: string;
};

const isError = (v: unknown): v is RemoteDataError =>
  typeof v === "object" && v !== null && "error" in v;

// ---------------------------------------------------------------- markets

export interface MarketRow {
  market_id: string;
  name: string;
  metro: string | null;
  exclusive_status: "locked" | "open" | "paused" | "closed";
  pipeline_status: string;
  engaged_team_id: string | null;
  last_capture_at: string | null;
}

function exclusiveStatus(status: string): MarketRow["exclusive_status"] {
  if (LOCKED_STATUSES.includes(status)) return "locked";
  if (status === "paused") return "paused";
  if (status === "closed") return "closed";
  return "open";
}

export async function listMarkets(includeLocked: boolean): Promise<MarketRow[]> {
  const rows = await sql`
    select ml.id, ml.name, ml.status, m.name as metro,
      (select p.id from prospects p
        where p.launch_id = ml.id and p.stage = ${ENGAGED_STAGE}
          and p.archived_at is null
        order by p.updated_at desc limit 1) as engaged_team_id,
      (select max(r.completed_at)
        from prospect_benchmarks pb
        join prospects p2 on p2.id = pb.prospect_id
        join runs r on r.id = pb.run_id
        where p2.launch_id = ml.id) as last_capture_at
    from market_launches ml
    left join markets m on m.id = ml.market_id
    where ml.archived_at is null
    order by ml.name
  `;
  return rows
    .map((row) => ({
      market_id: row.id as string,
      name: row.name as string,
      metro: (row.metro as string | null) ?? null,
      exclusive_status: exclusiveStatus(row.status as string),
      pipeline_status: row.status as string,
      engaged_team_id: (row.engagedTeamId as string | null) ?? null,
      last_capture_at: row.lastCaptureAt
        ? new Date(row.lastCaptureAt as Date).toISOString()
        : null,
    }))
    .filter((m) => includeLocked || m.exclusive_status !== "locked");
}

// ------------------------------------------------------------------ teams

export type TeamStatus = "prospect" | "engaged" | "closed";

export interface TeamRow {
  team_id: string;
  name: string;
  lead_name: string | null;
  market_id: string;
  market_name: string;
  status: TeamStatus;
  stage: string;
  website: string | null;
  last_capture_at: string | null;
}

function teamStatus(stage: string): TeamStatus {
  if (stage === ENGAGED_STAGE) return "engaged";
  if (stage === CLOSED_STAGE) return "closed";
  return "prospect";
}

export async function listTeams(options: {
  marketId?: string;
  status?: TeamStatus | "all";
  query?: string;
  limit?: number;
}): Promise<TeamRow[]> {
  const limit = Math.min(options.limit ?? TEAMS_LIMIT_DEFAULT, TEAMS_LIMIT_MAX);
  const rows = await sql`
    select p.id, p.business_name, p.team_leader, p.website, p.stage,
      p.launch_id, ml.name as market_name,
      (select max(r.completed_at)
        from prospect_benchmarks pb join runs r on r.id = pb.run_id
        where pb.prospect_id = p.id) as last_capture_at
    from prospects p
    join market_launches ml on ml.id = p.launch_id
    where p.archived_at is null
      ${options.marketId ? sql`and p.launch_id = ${options.marketId}` : sql``}
      ${options.query ? sql`and p.business_name ilike ${"%" + options.query + "%"}` : sql``}
      ${
        options.status === "engaged"
          ? sql`and p.stage = ${ENGAGED_STAGE}`
          : options.status === "closed"
            ? sql`and p.stage = ${CLOSED_STAGE}`
            : options.status === "prospect"
              ? sql`and p.stage not in (${ENGAGED_STAGE}, ${CLOSED_STAGE})`
              : sql``
      }
    order by p.business_name
    limit ${limit}
  `;
  return rows.map((row) => ({
    team_id: row.id as string,
    name: row.businessName as string,
    lead_name: (row.teamLeader as string | null) ?? null,
    market_id: row.launchId as string,
    market_name: row.marketName as string,
    status: teamStatus(row.stage as string),
    stage: row.stage as string,
    website: (row.website as string | null) ?? null,
    last_capture_at: row.lastCaptureAt
      ? new Date(row.lastCaptureAt as Date).toISOString()
      : null,
  }));
}

// --------------------------------------------------------------- captures

interface ProspectMeta {
  prospectId: string;
  businessName: string;
  companyId: string | null;
  website: string | null;
  launchId: string;
  marketName: string;
}

interface ResolvedCapture {
  prospect: ProspectMeta;
  runId: string;
  completedAt: Date | null;
}

async function prospectMeta(teamId: string): Promise<ProspectMeta | null> {
  const [row] = await sql`
    select p.id, p.business_name, p.company_id, p.website, p.launch_id,
      ml.name as market_name
    from prospects p
    join market_launches ml on ml.id = p.launch_id
    where p.id = ${teamId} and p.archived_at is null
  `;
  if (!row) return null;
  return {
    prospectId: row.id as string,
    businessName: row.businessName as string,
    companyId: (row.companyId as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    launchId: row.launchId as string,
    marketName: row.marketName as string,
  };
}

/** Latest linked completed/partial run, or a specific one if the caller
 * pins capture_id — which must be linked to this team (no cross-prospect
 * reads through a guessed run id). */
async function resolveCapture(
  teamId: string,
  captureId?: string
): Promise<ResolvedCapture | RemoteDataError> {
  const prospect = await prospectMeta(teamId);
  if (!prospect) return { error: "not_found", team_id: teamId };
  const rows = await sql`
    select r.id, r.completed_at
    from prospect_benchmarks pb
    join runs r on r.id = pb.run_id
    where pb.prospect_id = ${teamId}
      and r.status in ('completed', 'partial')
      ${captureId ? sql`and r.id = ${captureId}` : sql``}
    order by r.completed_at desc nulls last
    limit 1
  `;
  const row = rows[0];
  if (!row) {
    return captureId
      ? { error: "not_found", team_id: teamId, capture_id: captureId }
      : { error: "no_capture", team_id: teamId };
  }
  return {
    prospect,
    runId: row.id as string,
    completedAt: (row.completedAt as Date) ?? null,
  };
}

// --------------------------------------------------------------- snapshot

export interface VisibilitySnapshot {
  team_id: string;
  team_name: string;
  market_id: string;
  market_name: string;
  capture_id: string;
  captured_at: string | null;
  provider_labels: string[];
  questions_count: number;
  repetitions: number;
  valid_answers: number;
  mentioned_count: number;
  recommended_count: number;
  mention_share: number | null;
  recommend_share: number | null;
  gap_label: string;
  top_recommended: { name: string; recommended_count: number }[];
  top_cited_domains: { domain: string; count: number }[];
  notes: string | null;
  as_of: string;
}

async function mentionCounts(
  runId: string,
  companyId: string | null
): Promise<{ mentioned: number; recommended: number }> {
  if (!companyId) return { mentioned: 0, recommended: 0 };
  const [row] = await sql`
    select
      count(distinct m.response_id) filter (where m.mentioned)::int as mentioned,
      count(distinct m.response_id) filter (where m.recommended)::int as recommended
    from mentions m
    join responses r on r.id = m.response_id
    where r.run_id = ${runId} and r.error is null
      and m.company_id = ${companyId} and ${CURRENT}
  `;
  return {
    mentioned: Number(row?.mentioned ?? 0),
    recommended: Number(row?.recommended ?? 0),
  };
}

async function topRecommended(
  runId: string,
  limit: number
): Promise<{ name: string; company_id: string; recommended_count: number }[]> {
  const rows = await sql`
    select c.id, c.name, count(distinct m.response_id)::int as recommended
    from mentions m
    join responses r on r.id = m.response_id
    join companies c on c.id = m.company_id
    where r.run_id = ${runId} and r.error is null
      and m.recommended and ${CURRENT}
    group by c.id, c.name
    order by recommended desc, c.name
    limit ${limit}
  `;
  return rows.map((row) => ({
    name: row.name as string,
    company_id: row.id as string,
    recommended_count: Number(row.recommended),
  }));
}

export interface DomainTally {
  domain: string;
  count: number;
  example_urls: string[];
}

async function domainTallies(runId: string, limit: number): Promise<DomainTally[]> {
  const rows = await sql`
    select rc.domain, count(*)::int as citations,
      (array_agg(distinct rc.url))[1:3] as examples
    from response_citations rc
    join responses r on r.id = rc.response_id
    where r.run_id = ${runId} and r.error is null
    group by rc.domain
    order by citations desc, rc.domain
    limit ${limit}
  `;
  return rows.map((row) => ({
    domain: row.domain as string,
    count: Number(row.citations),
    example_urls: (row.examples as string[]) ?? [],
  }));
}

function websiteDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const host = new URL(website.includes("://") ? website : `https://${website}`)
      .hostname;
    return host.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

const stripWww = (domain: string): string =>
  domain.toLowerCase().replace(/^www\./, "");

function gapLabel(input: {
  mentioned: number;
  recommended: number;
  validAnswers: number;
}): string {
  if (input.recommended === 0 && input.mentioned === 0) return "absent";
  if (input.recommended === 0) return "mentioned_never_recommended";
  if (input.recommended * 2 < input.validAnswers) return "recommended_minority";
  return "recommended_majority";
}

export async function getVisibilitySnapshot(
  teamId: string,
  captureId?: string
): Promise<VisibilitySnapshot | RemoteDataError> {
  const capture = await resolveCapture(teamId, captureId);
  if (isError(capture)) return capture;
  const summary = await runSummary(capture.runId);
  if (!summary) return { error: "no_capture", team_id: teamId };
  const [repRow] = await sql`
    select count(distinct repetition)::int as reps
    from responses where run_id = ${capture.runId} and error is null
  `;
  const counts = await mentionCounts(capture.runId, capture.prospect.companyId);
  const top = await topRecommended(capture.runId, TOP_RECOMMENDED_LIMIT);
  const domains = await domainTallies(capture.runId, TOP_DOMAINS_LIMIT);
  const valid = summary.responseCount;
  return {
    team_id: capture.prospect.prospectId,
    team_name: capture.prospect.businessName,
    market_id: capture.prospect.launchId,
    market_name: capture.prospect.marketName,
    capture_id: capture.runId,
    captured_at: capture.completedAt?.toISOString() ?? null,
    provider_labels: summary.providers,
    questions_count: summary.promptCount,
    repetitions: Number(repRow?.reps ?? 0),
    valid_answers: valid,
    mentioned_count: counts.mentioned,
    recommended_count: counts.recommended,
    mention_share: valid > 0 ? counts.mentioned / valid : null,
    recommend_share: valid > 0 ? counts.recommended / valid : null,
    gap_label: gapLabel({
      mentioned: counts.mentioned,
      recommended: counts.recommended,
      validAnswers: valid,
    }),
    top_recommended: top.map(({ name, recommended_count }) => ({
      name,
      recommended_count,
    })),
    top_cited_domains: domains.map(({ domain, count }) => ({ domain, count })),
    notes: summary.statusDetail,
    as_of: new Date().toISOString(),
  };
}

// ---------------------------------------------------------- cited sources

export async function listCitedSources(
  teamId: string,
  captureId: string | undefined,
  limit: number | undefined
): Promise<
  | { team_id: string; capture_id: string; sources: DomainTally[]; as_of: string }
  | RemoteDataError
> {
  const capture = await resolveCapture(teamId, captureId);
  if (isError(capture)) return capture;
  const capped = Math.min(limit ?? SOURCES_LIMIT_DEFAULT, SOURCES_LIMIT_MAX);
  return {
    team_id: teamId,
    capture_id: capture.runId,
    sources: await domainTallies(capture.runId, capped),
    as_of: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- answers

export type AnswerFilter =
  | "team_recommended"
  | "team_named"
  | "team_absent"
  | "competitor_named"
  | "all";

export interface AnswerItem {
  answer_id: string;
  question_text: string;
  provider: string;
  repetition: number;
  classification: "recommended" | "named" | "absent";
  excerpt: string;
  cited_domains: string[];
}

export async function searchAnswers(options: {
  teamId: string;
  captureId?: string;
  filter: AnswerFilter;
  competitorName?: string;
  limit?: number;
  cursor?: string;
}): Promise<
  | { team_id: string; capture_id: string; items: AnswerItem[]; next_cursor: string | null; as_of: string }
  | RemoteDataError
> {
  const capture = await resolveCapture(options.teamId, options.captureId);
  if (isError(capture)) return capture;
  const limit = Math.min(options.limit ?? ANSWERS_LIMIT_DEFAULT, ANSWERS_LIMIT_MAX);
  const teamCompanyId = capture.prospect.companyId;

  let competitorId: string | null = null;
  if (options.filter === "competitor_named") {
    if (!options.competitorName) {
      return { error: "not_found", detail: "competitor_name is required for competitor_named" };
    }
    const [row] = await sql`
      select id from companies
      where lower(name) = lower(${options.competitorName})
        or exists (select 1 from unnest(aliases) a
                   where lower(a) = lower(${options.competitorName}))
      limit 1
    `;
    if (!row) {
      return { error: "not_found", competitor_name: options.competitorName };
    }
    competitorId = row.id as string;
  }

  // Current-revision mention of the TEAM on the aliased row `m`.
  const teamMention = sql`
    select 1 from mentions m
    where m.response_id = r.id and m.company_id = ${teamCompanyId} and ${CURRENT}
  `;
  const filterClause =
    options.filter === "team_recommended"
      ? sql`and exists (${teamMention} and m.recommended)`
      : options.filter === "team_named"
        ? sql`and exists (${teamMention} and m.mentioned and not m.recommended)`
        : options.filter === "team_absent"
          ? sql`and not exists (${teamMention} and m.mentioned)`
          : options.filter === "competitor_named"
            ? sql`and exists (
                select 1 from mentions m
                where m.response_id = r.id and m.company_id = ${competitorId}
                  and m.mentioned and ${CURRENT})`
            : sql``;

  const rows = await sql`
    select r.id, r.prompt_text, r.provider, r.repetition,
      tm.mentioned as team_mentioned, tm.recommended as team_recommended,
      tm.excerpt as team_excerpt,
      left(r.response_text, ${EXCERPT_MAX_CHARS}) as head,
      (select coalesce(array_agg(distinct rc.domain), '{}')
        from response_citations rc where rc.response_id = r.id) as domains
    from responses r
    left join lateral (
      select m.mentioned, m.recommended, m.excerpt
      from mentions m
      where m.response_id = r.id and m.company_id = ${teamCompanyId} and ${CURRENT}
      limit 1
    ) tm on true
    where r.run_id = ${capture.runId} and r.error is null
      ${options.cursor ? sql`and r.id > ${options.cursor}` : sql``}
      ${filterClause}
    order by r.id
    limit ${limit}
  `;
  const items: AnswerItem[] = rows.map((row) => {
    const excerpt =
      ((row.teamExcerpt as string | null) ?? (row.head as string | null) ?? "")
        .slice(0, EXCERPT_MAX_CHARS);
    return {
      answer_id: row.id as string,
      question_text: row.promptText as string,
      provider: row.provider as string,
      repetition: Number(row.repetition),
      classification: row.teamRecommended
        ? "recommended"
        : row.teamMentioned
          ? "named"
          : "absent",
      excerpt,
      cited_domains: (row.domains as string[]) ?? [],
    };
  });
  return {
    team_id: options.teamId,
    capture_id: capture.runId,
    items,
    next_cursor: items.length === limit ? (items[items.length - 1]?.answer_id ?? null) : null,
    as_of: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ email brief

export async function getEmailBrief(
  teamId: string
): Promise<(EmailBrief & { team_id: string; as_of: string }) | RemoteDataError> {
  const prospect = await prospectMeta(teamId);
  if (!prospect) return { error: "not_found", team_id: teamId };
  const capture = await resolveCapture(teamId);
  let captureFacts: EmailBriefCapture | null = null;
  if (!isError(capture)) {
    const summary = await runSummary(capture.runId);
    if (summary && summary.responseCount > 0) {
      const counts = await mentionCounts(capture.runId, prospect.companyId);
      const top = await topRecommended(capture.runId, TOP_RECOMMENDED_LIMIT);
      const domains = await domainTallies(capture.runId, TOP_DOMAINS_LIMIT);
      const siteDomain = websiteDomain(prospect.website);
      const teamDomainCitations = siteDomain
        ? domains
            .filter((d) => stripWww(d.domain) === siteDomain)
            .reduce((sum, d) => sum + d.count, 0)
        : 0;
      captureFacts = {
        validAnswers: summary.responseCount,
        mentionedCount: counts.mentioned,
        recommendedCount: counts.recommended,
        competitorsNamed: top
          .filter((t) => t.company_id !== prospect.companyId)
          .map((t) => t.name),
        topDomain: domains[0]
          ? { domain: domains[0].domain, citations: domains[0].count }
          : null,
        teamDomainCitations,
        teamWebsiteDomain: siteDomain,
      };
    }
  }
  const brief = buildEmailBrief({
    teamName: prospect.businessName,
    marketName: prospect.marketName,
    capture: captureFacts,
  });
  return { team_id: teamId, ...brief, as_of: new Date().toISOString() };
}

// ---------------------------------------------------------------- sends

export interface SendRow {
  send_id: string;
  team_id: string;
  team_name: string;
  channel: string;
  recipient_email: string;
  subject: string | null;
  allowed: boolean;
  sent_at: string;
}

export async function listOutreachSends(options: {
  since?: string;
  marketId?: string;
  limit?: number;
}): Promise<{ sends: SendRow[]; as_of: string }> {
  const limit = Math.min(options.limit ?? SENDS_LIMIT_DEFAULT, SENDS_LIMIT_MAX);
  const rows = await sql`
    select s.id, s.prospect_id, p.business_name, s.channel, s.recipient_email,
      s.allowed, s.sent_at, d.subject
    from prospect_outreach_sends s
    join prospects p on p.id = s.prospect_id
    left join outreach_drafts d on d.id = s.draft_id
    where true
      ${options.since ? sql`and s.sent_at >= ${options.since}` : sql``}
      ${options.marketId ? sql`and p.launch_id = ${options.marketId}` : sql``}
    order by s.sent_at desc
    limit ${limit}
  `;
  return {
    sends: rows.map((row) => ({
      send_id: row.id as string,
      team_id: row.prospectId as string,
      team_name: row.businessName as string,
      channel: row.channel as string,
      recipient_email: row.recipientEmail as string,
      subject: (row.subject as string | null) ?? null,
      allowed: Boolean(row.allowed),
      sent_at: new Date(row.sentAt as Date).toISOString(),
    })),
    as_of: new Date().toISOString(),
  };
}
