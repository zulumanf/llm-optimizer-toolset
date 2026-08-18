/**
 * Market citation intelligence (spec 086): which domains and pages
 * repeatedly appear as sources in AI answers across a market launch's
 * benchmark runs, and which prospects those sources do or don't represent.
 *
 * Derived on read from the immutable response_citations ledger — no second
 * copy of counts. Everything here is co-occurrence over stored evidence;
 * nothing claims a citation caused a recommendation.
 */
import { sql } from "@/db/client";
import {
  marketDomainAggregates,
  marketCitationTotals,
  marketCitationUrls,
  marketDomainMentions,
} from "@/db/market-citations";
import { classifySource, type SourceType } from "@/lib/sources/classify";

export const MARKET_CITATIONS_VERSION = "market-citations-v1";

/** Below this many total citations the market source graph is reported as
 * insufficient evidence rather than a confident-looking tiny ranking. */
export const MIN_MARKET_CITATIONS = 10;

const TOP_DOMAIN_LIMIT = 25;
const TOP_URLS_PER_DOMAIN = 3;
const TOP_COMPANIES_PER_DOMAIN = 5;

export interface MarketSourceDomain {
  domain: string;
  sourceType: SourceType;
  citations: number;
  responsesCiting: number;
  /** responsesCiting / total successful responses in scope. */
  responseShare: number;
  runsCiting: number;
  providers: string[];
  topUrls: { url: string; citations: number }[];
  /** Companies mentioned in answers that cite this domain (co-occurrence). */
  companiesInCitingAnswers: {
    companyId: string;
    name: string;
    mentions: number;
    recommendations: number;
    isLaunchProspect: boolean;
  }[];
  /** Launch prospects whose own site is this domain (their content is the
   * cited source), matched by canonical-company domain. */
  prospectOwnerIds: string[];
}

export interface MarketProspectPresence {
  prospectId: string;
  businessName: string;
  /** Own-domain citations across the scope (their content cited as source). */
  ownDomainCitations: number;
  /** Domains among the top set whose citing answers mention this prospect. */
  presentInDomains: string[];
}

export interface MarketSourceGraph {
  version: typeof MARKET_CITATIONS_VERSION;
  launchId: string;
  sufficient: boolean;
  totals: { responses: number; citations: number; runs: number; projects: number };
  domains: MarketSourceDomain[];
  prospects: MarketProspectPresence[];
}

interface LaunchProspectRow {
  id: string;
  businessName: string;
  companyId: string | null;
  benchmarkProjectId: string | null;
  companyDomain: string | null;
}

async function launchProspects(launchId: string): Promise<LaunchProspectRow[]> {
  return sql<LaunchProspectRow[]>`
    select p.id, p.business_name, p.company_id, p.benchmark_project_id,
      lower(c.domain) as company_domain
    from prospects p
    left join companies c on c.id = p.company_id
    where p.launch_id = ${launchId} and p.archived_at is null
  `;
}

const domainMatches = (citedDomain: string, ownDomain: string): boolean =>
  citedDomain === ownDomain || citedDomain.endsWith(`.${ownDomain}`);

export async function marketSourceGraph(
  launchId: string
): Promise<MarketSourceGraph> {
  const prospects = await launchProspects(launchId);
  const projectIds = [
    ...new Set(
      prospects
        .map((p) => p.benchmarkProjectId)
        .filter((id): id is string => id !== null)
    ),
  ];
  const empty: MarketSourceGraph = {
    version: MARKET_CITATIONS_VERSION,
    launchId,
    sufficient: false,
    totals: { responses: 0, citations: 0, runs: 0, projects: projectIds.length },
    domains: [],
    prospects: [],
  };
  if (projectIds.length === 0) return empty;

  const [aggregates, totals] = await Promise.all([
    marketDomainAggregates(projectIds),
    marketCitationTotals(projectIds),
  ]);
  if (totals.citations === 0) {
    return { ...empty, totals: { ...totals, projects: projectIds.length } };
  }

  const top = aggregates.slice(0, TOP_DOMAIN_LIMIT);
  const topDomains = top.map((a) => a.domain);
  const [urls, mentionRows] = await Promise.all([
    marketCitationUrls(projectIds, topDomains),
    marketDomainMentions(projectIds, topDomains),
  ]);

  const prospectCompanyIds = new Set(
    prospects.map((p) => p.companyId).filter((id): id is string => id !== null)
  );
  const withDomain = prospects.filter(
    (p): p is LaunchProspectRow & { companyDomain: string } =>
      p.companyDomain !== null
  );

  const domains: MarketSourceDomain[] = top.map((agg) => {
    // Market-level classification carries no subject/competitor context —
    // only the global sourceType axis is meaningful here.
    const { sourceType } = classifySource(agg.domain, {
      subjectDomain: null,
      competitorDomains: [],
    });
    return {
      domain: agg.domain,
      sourceType,
      citations: agg.citations,
      responsesCiting: agg.responsesCiting,
      responseShare:
        totals.responses > 0 ? agg.responsesCiting / totals.responses : 0,
      runsCiting: agg.runsCiting,
      providers: [...agg.providers].sort(),
      topUrls: urls
        .filter((u) => u.domain === agg.domain)
        .slice(0, TOP_URLS_PER_DOMAIN)
        .map((u) => ({ url: u.url, citations: u.citations })),
      companiesInCitingAnswers: mentionRows
        .filter((m) => m.domain === agg.domain)
        .slice(0, TOP_COMPANIES_PER_DOMAIN)
        .map((m) => ({
          companyId: m.companyId,
          name: m.companyName,
          mentions: m.mentions,
          recommendations: m.recommendations,
          isLaunchProspect: prospectCompanyIds.has(m.companyId),
        })),
      prospectOwnerIds: withDomain
        .filter((p) => domainMatches(agg.domain, p.companyDomain))
        .map((p) => p.id),
    };
  });

  const prospectPresence: MarketProspectPresence[] = prospects.map((p) => {
    const ownDomainCitations =
      p.companyDomain === null
        ? 0
        : aggregates
            .filter((a) => domainMatches(a.domain, p.companyDomain as string))
            .reduce((sum, a) => sum + a.citations, 0);
    const presentInDomains =
      p.companyId === null
        ? []
        : mentionRows
            .filter((m) => m.companyId === p.companyId && m.mentions > 0)
            .map((m) => m.domain);
    return {
      prospectId: p.id,
      businessName: p.businessName,
      ownDomainCitations,
      presentInDomains,
    };
  });

  return {
    version: MARKET_CITATIONS_VERSION,
    launchId,
    sufficient: totals.citations >= MIN_MARKET_CITATIONS,
    totals: { ...totals, projects: projectIds.length },
    domains,
    prospects: prospectPresence,
  };
}
