/**
 * Source presence per client (spec 151 B2). For the domains AI answers cite
 * in this client's measurement, what do we actually know?
 *
 *  - answersCiting: answers that cited the domain (citation FREQUENCY);
 *  - withCompetitor / withClient: of those answers, how many also named a
 *    cohort competitor / the client — co-occurrence in the ANSWER, not proof
 *    the page names them;
 *  - pagePresence: what a fetched page check (source_presence_checks)
 *    recorded about the page itself, or "not checked".
 *
 * Nothing here estimates influence. A domain cited often is a place worth
 * being; whether being there changes a recommendation is what interventions
 * measure.
 */
import { sql } from "@/db/client";
import { CURRENT_REVISION } from "@/db/mentions";
import { latestCohort } from "@/db/measurement";
import { domainBelongsTo } from "@/lib/parsing/prepass";

export interface SourcePresenceRow {
  domain: string;
  answersCiting: number;
  withCompetitor: number;
  withClient: number;
  ownedByClient: boolean;
  pagePresence: "client_present" | "client_absent" | "not_checked" | "check_failed";
  competitorsOnPage: string[];
  checkedAt: Date | null;
  /** Cited alongside competitors, not owned by the client, and the client is
   * not known to be present: the candidate list for outreach research. */
  candidate: boolean;
}

export const SOURCE_PRESENCE_LIMIT = 50;

export async function sourcePresence(projectId: string, runId?: string): Promise<{ runId: string | null; rows: SourcePresenceRow[] }> {
  const [run] = runId
    ? await sql`select id from runs where id = ${runId} and project_id = ${projectId}`
    : await sql`
        select id from runs where project_id = ${projectId} and status in ('completed', 'partial')
        order by started_at desc limit 1
      `;
  if (!run) return { runId: null, rows: [] };
  const [project] = await sql`
    select p.subject_company_id, c.domain from projects p
    left join companies c on c.id = p.subject_company_id where p.id = ${projectId}
  `;
  const subjectId = (project?.subjectCompanyId as string | null) ?? null;
  const subjectDomain = (project?.domain as string | null) ?? null;
  const cohort = await latestCohort(projectId);
  const competitorIds = cohort
    ? cohort.companyIds.filter((id) => id !== subjectId)
    : (await sql`select company_id from competitors where project_id = ${projectId} and archived_at is null`).map(
        (r) => r.companyId as string
      );

  const rows = await sql`
    with cited as (
      select rc.domain, rc.response_id from response_citations rc
      join responses r on r.id = rc.response_id
      where r.run_id = ${run.id} and r.error is null
      group by rc.domain, rc.response_id
    ),
    named as (
      select m.response_id, m.company_id from mentions m
      join responses r on r.id = m.response_id
      where r.run_id = ${run.id} and m.mentioned and ${CURRENT_REVISION}
    )
    select c.domain,
      count(*)::int as answers_citing,
      count(*) filter (where exists (select 1 from named n where n.response_id = c.response_id
        and n.company_id = any(${competitorIds}::uuid[])))::int as with_competitor,
      count(*) filter (where exists (select 1 from named n where n.response_id = c.response_id
        and n.company_id = ${subjectId}))::int as with_client
    from cited c
    group by c.domain
    order by answers_citing desc, c.domain
    limit ${SOURCE_PRESENCE_LIMIT}
  `;
  const checks = await sql`
    select distinct on (domain) domain, ok, client_present, competitor_hits, checked_at
    from source_presence_checks where project_id = ${projectId}
    order by domain, checked_at desc
  `;
  const byDomain = new Map(checks.map((c) => [c.domain as string, c]));
  return {
    runId: run.id as string,
    rows: rows.map((r) => {
      const domain = r.domain as string;
      const check = byDomain.get(domain);
      const pagePresence: SourcePresenceRow["pagePresence"] = !check
        ? "not_checked"
        : !check.ok
          ? "check_failed"
          : check.clientPresent
            ? "client_present"
            : "client_absent";
      const ownedByClient = domainBelongsTo(domain, subjectDomain);
      const withCompetitor = r.withCompetitor as number;
      return {
        domain,
        answersCiting: r.answersCiting as number,
        withCompetitor,
        withClient: r.withClient as number,
        ownedByClient,
        pagePresence,
        competitorsOnPage: Array.isArray(check?.competitorHits)
          ? (check!.competitorHits as unknown[]).map((h) =>
              typeof h === "string" ? h : String((h as Record<string, unknown>).name ?? "")
            ).filter(Boolean)
          : [],
        checkedAt: (check?.checkedAt as Date | undefined) ?? null,
        candidate: !ownedByClient && withCompetitor > 0 && pagePresence !== "client_present",
      };
    }),
  };
}
