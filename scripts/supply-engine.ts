/**
 * Touch 1 supply engine (2026-09-13): FULL REALTRENDS UNIVERSE → market
 * policy → market supply view → prequalified pools → contactability →
 * benchmark waves (just-in-time) → dispatch plan over the frozen cohort.
 *
 * READ-ONLY against the database. Nothing here creates prospects, starts a
 * benchmark run, drafts, schedules or sends. Outputs go to gitignored
 * .local-data/supply/<date>/ (market view, per-market candidate pools, the
 * contact-research queue, the wave plan, the dispatch plan).
 *
 * Qualification (spec 124 + 136 through lib/prospects/t1-cohort.ts) stays
 * in scripts/t1-cohort-build.ts; this script consumes its latest dry-run /
 * snapshot JSON for the QUALIFIED_T1 → DISPATCHABLE_NOW / DEFERRED split.
 *
 * Run:  DATABASE_URL=<direct db url> npx tsx scripts/supply-engine.ts
 *       [--min-volume 20000000] [--research-markets 15]
 */
import "dotenv/config";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import { checkSuppression } from "@/lib/outreach/suppression";
import { BROKERAGE_CUT_COMMA, BROKERAGE_CUT_SUFFIX, BROKERAGE_SEND_CAP_30D, MISMATCH_THRESHOLDS, normalizeBrokerage } from "@/lib/prospects/constants";
import { EVIDENCE_RELEASE_VERSION } from "@/lib/prospects/evidence-release";
import { MARKET_POLICY_VERSION, resolveMarketPolicy, type MarketPolicy } from "@/lib/prospects/market-policy";
import { launchGeographies } from "@/lib/prospects/realtrends-dataset";
import {
  SUPPLY_ENGINE_VERSION,
  benchmarkFreshness,
  brokerageCapFreeAt,
  contactability,
  dispatchPlan,
  marketExpansionClass,
  marketKey,
  normalizeSourceRecords,
  planWaves,
  prequalify,
  rankMarkets,
  supplyMetrics,
  waveSizing,
  type CanonicalCandidate,
  type Contactability,
  type ExistingProspectState,
  type MarketSupplyFeatures,
  type PrequalBlocker,
  type SourceRecord,
} from "@/lib/prospects/supply-engine";
import { T1_COHORT_POLICY_VERSION, T1_COHORT_TARGET } from "@/lib/prospects/t1-cohort";

const POSITIVE_REPLIES = ["positive_interest", "question", "proof_request", "referral"];
const DECLINE_REPLIES = ["decline", "not_interested", "unsubscribe"];
const SANDBOX_MARKET_PREFIX = "QA134";
/** Supply-efficiency production floor used ONLY to rank wave depth and to
 * order the contact-research queue — never to exclude an entity (t1-cohort-002
 * qualified a $15.4M team). Same floor the fresh-prospect-discovery pass
 * (2026-08-31) used for market ranking. */
const DEFAULT_MIN_VOLUME_USD = 20_000_000;
const HIGH_PRODUCTION_USD = 50_000_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

interface GeoAgg { city: string; state: string; entities: number; teams: number; individuals: number; high: number; aboveFloor: number; linked: number; teams100m: number; brokeragesHigh: number; namedLeadsHigh: number }

async function universeProfile(minVolume: number): Promise<Record<string, unknown>> {
  const [t] = await sql`
    select count(*)::int as total,
      count(*) filter (where entity_type = 'team')::int as teams,
      count(*) filter (where entity_type = 'individual')::int as individuals,
      count(distinct production_year)::int as years, min(production_year) as year,
      count(*) filter (where volume_usd is not null)::int as with_volume,
      count(*) filter (where sides is not null)::int as with_sides,
      count(distinct (state, city))::int as geographies,
      count(*) filter (where company_id is not null)::int as linked_company,
      count(*) filter (where team_lead is not null and team_lead <> '')::int as with_team_lead,
      count(*) filter (where brokerage is not null and brokerage <> '')::int as with_brokerage,
      count(*) filter (where volume_usd >= ${minVolume})::int as above_floor
    from realtrends_records`;
  const [p] = await sql`
    select count(distinct r.id)::int as as_prospect from realtrends_records r
    join prospects p on p.company_id = r.company_id and p.archived_at is null`;
  const [d] = await sql`
    select count(*)::int as groups from (select 1 from realtrends_records group by lower(entity_name), city, state, entity_type having count(*) > 1) g`;
  const match = await sql`select match_status, count(*)::int as n from realtrends_records group by match_status`;
  return { ...t, asProspect: p!.asProspect, neverProspect: Number(t!.total) - Number(p!.asProspect), duplicateIdentityGroups: d!.groups, matchStatus: Object.fromEntries(match.map((m) => [m.matchStatus as string, m.n])) };
}

async function geoAggregates(minVolume: number): Promise<GeoAgg[]> {
  const rows = await sql`
    select city, state, count(*)::int as entities,
      count(*) filter (where entity_type = 'team')::int as teams,
      count(*) filter (where entity_type = 'individual')::int as individuals,
      count(*) filter (where volume_usd >= ${HIGH_PRODUCTION_USD})::int as high,
      count(*) filter (where volume_usd >= ${minVolume})::int as above_floor,
      count(*) filter (where company_id is not null)::int as linked,
      count(*) filter (where entity_type = 'team' and volume_usd >= 100000000)::int as teams100m,
      count(distinct brokerage) filter (where volume_usd >= ${HIGH_PRODUCTION_USD})::int as brokerages_high,
      count(*) filter (where volume_usd >= ${HIGH_PRODUCTION_USD} and (entity_type = 'individual' or (team_lead is not null and team_lead <> '')))::int as named_leads_high
    from realtrends_records group by city, state`;
  return rows as unknown as GeoAgg[];
}

interface LaunchInfo { launchId: string; marketId: string; status: string; names: string[]; stateCode: string | null; city: string; state: string | null; exclusiveScope: boolean; benchmark: { runId: string | null; capturedAt: Date | null }; positive: number; clients: number }

async function launches(): Promise<LaunchInfo[]> {
  const geos = await launchGeographies(sql);
  const rows = await sql`
    with recursive up as (
      select l.id as launch_id, m.id, m.name, m.parent_id, 0 as depth from market_launches l join markets m on m.id = l.market_id where l.archived_at is null
      union all select up.launch_id, m.id, m.name, m.parent_id, up.depth + 1 from markets m join up on m.id = up.parent_id
    )
    select l.id as launch_id, l.market_id, l.status, m.state_code,
      (select array_agg(name order by depth) from up where up.launch_id = l.id) as names,
      exists (select 1 from exclusivity_scopes s join exclusivity_agreements a on a.id = s.agreement_id
        where a.status in ('active','reserved') and a.terminated_at is null and s.market_id in (select id from up where up.launch_id = l.id)) as exclusive_scope,
      (select count(distinct r.prospect_id)::int from prospect_replies r join prospects p on p.id = r.prospect_id where p.launch_id = l.id and r.classification = any(${POSITIVE_REPLIES}::text[])) as positive,
      (select count(*)::int from client_engagements e join prospects p on p.id = e.prospect_id where p.launch_id = l.id) as clients
    from market_launches l join markets m on m.id = l.market_id
    where l.archived_at is null and m.name not like ${SANDBOX_MARKET_PREFIX + "%"}`;
  // Freshest completed run with valid OpenAI answers per launch (query shape
  // from scripts/fresh-prospect-discovery.ts).
  const runs = await sql`
    select distinct on (p.launch_id) p.launch_id, r.id as run_id, r.completed_at
    from prospects p join prospect_benchmarks pb on pb.prospect_id = p.id join runs r on r.id = pb.run_id
    where p.archived_at is null and r.completed_at is not null
      and exists (select 1 from responses x where x.run_id = r.id and x.provider = 'openai' and x.error is null)
    order by p.launch_id, r.completed_at desc`;
  const runBy = new Map(runs.map((r) => [r.launchId as string, { runId: r.runId as string, capturedAt: new Date(r.completedAt as Date) }]));
  return rows.map((r) => {
    const geo = geos.find((g) => g.launchId === r.launchId);
    return {
      launchId: r.launchId as string, marketId: r.marketId as string, status: r.status as string, names: (r.names as string[]) ?? [],
      stateCode: (r.stateCode as string | null) ?? geo?.state ?? null, city: geo?.city ?? (r.names as string[])[0]!, state: geo?.state ?? null,
      exclusiveScope: Boolean(r.exclusiveScope), benchmark: runBy.get(r.launchId as string) ?? { runId: null, capturedAt: null },
      positive: Number(r.positive), clients: Number(r.clients),
    };
  });
}

async function sourceRecords(city: string, state: string): Promise<SourceRecord[]> {
  const rows = await sql`
    select id, fingerprint, entity_type, entity_name, team_lead, brokerage, city, state, volume_usd, sides, production_year, company_id, match_status
    from realtrends_records where lower(city) = ${city.toLowerCase()} and state = ${state}`;
  return rows.map((r) => ({
    id: r.id as string, fingerprint: r.fingerprint as string, entityType: r.entityType as SourceRecord["entityType"], entityName: r.entityName as string,
    teamLead: (r.teamLead as string | null) ?? null, brokerage: (r.brokerage as string | null) ?? null, city: r.city as string, state: r.state as string,
    volumeUsd: r.volumeUsd === null ? null : Number(r.volumeUsd), sides: r.sides === null ? null : Number(r.sides), productionYear: Number(r.productionYear),
    companyId: (r.companyId as string | null) ?? null, matchStatus: r.matchStatus as string,
  }));
}

interface ProspectRow { id: string; businessName: string; companyId: string | null; stage: string; doNotContact: boolean; contacted: boolean; activeSequence: boolean; positiveReply: boolean; engagement: boolean; declined: boolean; email: string | null; provenance: string | null; researched: boolean }

/** Existing prospects in the launch, keyed by company id AND by exact
 * lowered business name — exclusion only ever widens on a name match. */
async function existingProspects(launchId: string): Promise<{ byCompany: Map<string, ProspectRow>; byName: Map<string, ProspectRow> }> {
  const rows = await sql`
    select p.id, p.business_name, p.company_id, p.stage, p.do_not_contact,
      exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as contacted,
      exists (select 1 from outreach_followup_sequences q where q.prospect_id = p.id and q.status in ('active','paused')) as active_sequence,
      exists (select 1 from prospect_replies r where r.prospect_id = p.id and r.classification = any(${POSITIVE_REPLIES}::text[])) as positive_reply,
      exists (select 1 from client_engagements e where e.prospect_id = p.id) as engagement,
      exists (select 1 from prospect_replies r where r.prospect_id = p.id and r.classification = any(${DECLINE_REPLIES}::text[])) as declined,
      c.email, c.provenance,
      (c.id is not null or exists (select 1 from enrichment_proposals e where e.prospect_id = p.id and e.kind = 'contact_email')) as researched
    from prospects p
    left join prospect_contacts c on c.prospect_id = p.id and c.is_primary and not c.do_not_contact and c.archived_at is null
    where p.launch_id = ${launchId} and p.archived_at is null`;
  const byCompany = new Map<string, ProspectRow>();
  const byName = new Map<string, ProspectRow>();
  for (const r of rows as unknown as ProspectRow[]) {
    if (r.companyId) byCompany.set(r.companyId, r);
    byName.set(r.businessName.toLowerCase().trim(), r);
  }
  return { byCompany, byName };
}

interface PoolEntry { candidate: CanonicalCandidate; prospectId: string | null; blockers: PrequalBlocker[]; contactability: Contactability | null }

async function prequalifyMarket(l: LaunchInfo, policy: MarketPolicy): Promise<PoolEntry[]> {
  if (!l.state) return [];
  const candidates = normalizeSourceRecords(await sourceRecords(l.city, l.state));
  const { byCompany, byName } = await existingProspects(l.launchId);
  const out: PoolEntry[] = [];
  for (const c of candidates) {
    const row = (c.companyId ? byCompany.get(c.companyId) : undefined) ?? byName.get(c.displayName.toLowerCase().trim()) ?? null;
    let existing: ExistingProspectState | null = null;
    if (row) {
      const suppressed = row.email ? (await checkSuppression({ email: row.email, projectId: null })).suppressed : false;
      existing = { prospectId: row.id, stage: row.stage, contacted: row.contacted, activeSequence: row.activeSequence, positiveReply: row.positiveReply, engagement: row.engagement, declined: row.declined, doNotContact: row.doNotContact, suppressed };
    }
    const blockers = prequalify({ candidate: c, policy, exclusiveConflict: l.exclusiveScope, existing });
    const contact = blockers.length === 0 ? contactability(row ? { email: row.email, provenance: row.provenance, researched: row.researched } : null) : null;
    out.push({ candidate: c, prospectId: row?.id ?? null, blockers, contactability: contact });
  }
  return out;
}

function features(g: GeoAgg, l: LaunchInfo | null, policy: MarketPolicy, pool: PoolEntry[], now: Date, contactedDensity: number, minVolume: number): MarketSupplyFeatures {
  const pre = pool.filter((p) => p.blockers.length === 0);
  const fresh = benchmarkFreshness(l?.benchmark.capturedAt ?? null, now);
  return {
    marketKey: marketKey(g.city, g.state), city: g.city, state: g.state, policy, launchId: l?.launchId ?? null,
    sourceEntities: g.entities, teams: g.teams, individuals: g.individuals, highProduction: g.high,
    prequalified: pre.length, prequalifiedAboveFloor: pre.filter((p) => (p.candidate.productionValue ?? 0) >= minVolume).length, prequalifiedBrokerages: new Set(pre.map((p) => normalizeBrokerage(p.candidate.brokerage ?? "") || p.candidate.brokerage)).size,
    contactVerified: pre.filter((p) => p.contactability === "CONTACT_VERIFIED").length,
    contactResearchRequired: pre.filter((p) => p.contactability === "CONTACT_RESEARCH_REQUIRED").length,
    contactedDensity, benchmark: { status: fresh.status, capturedAt: l?.benchmark.capturedAt ?? null, expiresAt: fresh.expiresAt, runId: l?.benchmark.runId ?? null },
    positiveHistory: l?.positive ?? 0, clientHistory: l?.clients ?? 0,
  };
}

interface CohortReport { members: { prospectId: string; name: string; market: { launchId: string; name: string }; band: string; recBucket: string; entityType: string; features: { runId: string; benchmarkCompletedAt: string; competitorName: string; prospectRecs: number; competitorRecs: number; denominator: number; absoluteGap: number; competitorProductionRatio: number | null; prospectProductionUsd?: number }; contact: { name: string; email: string; provenance: string }; brokerageKey?: string | null }[]; deferred: { prospectId: string; name: string; reason: string }[]; funnel: Record<string, number>; nonMembers: { prospectId: string; name: string; market: string; blockers: string[]; band: string }[] }

function latestCohortReport(): { file: string; report: CohortReport } | null {
  const dir = ".local-data/prospecting/t1-cohort-002";
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^(dry-run|snapshot)-/.test(f)).sort();
  const file = files[files.length - 1];
  return file ? { file: `${dir}/${file}`, report: JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as CohortReport } : null;
}

/** QUALIFIED_T1 members + cap-deferred qualified prospects → dispatch plan
 * with next eligible date and JIT-refresh flag. Uses real send history. */
async function dispatchLayer(now: Date): Promise<Record<string, unknown>> {
  const latest = latestCohortReport();
  if (!latest) return { source: null, qualified: 0, dispatchableNow: 0, deferredQualified: 0, plans: [] };
  const { report } = latest;
  const deferredIds = new Set(report.deferred.filter((d) => d.reason === "BROKERAGE_CAP_30D").map((d) => d.prospectId));
  const ids = [...report.members.map((m) => m.prospectId), ...deferredIds];
  const plans: Record<string, unknown>[] = [];
  for (const id of ids) {
    const [p] = await sql`select p.business_name, p.launch_id, p.brokerage_affiliation, m.name as market from prospects p join market_launches l on l.id = p.launch_id join markets m on m.id = l.market_id where p.id = ${id}`;
    if (!p) continue;
    const bk = normalizeBrokerage((p.brokerageAffiliation as string | null) ?? "");
    const sends = bk
      ? await sql`select s.sent_at from prospect_outreach_sends s join prospects q on q.id = s.prospect_id where s.allowed and q.launch_id = ${p.launchId}
          and trim(regexp_replace(regexp_replace(lower(trim(q.brokerage_affiliation)), ${BROKERAGE_CUT_COMMA}, ''), ${BROKERAGE_CUT_SUFFIX}, '')) = ${bk} and s.sent_at > now() - interval '30 days'`
      : [];
    const member = report.members.find((m) => m.prospectId === id);
    const capturedAt = (member?.features.benchmarkCompletedAt ? new Date(member.features.benchmarkCompletedAt) : null) ?? (await benchmarkCapturedFor(id)) ?? now;
    const band = member?.band ?? report.nonMembers.find((n) => n.prospectId === id)?.band ?? null;
    const capFreeAt = brokerageCapFreeAt(sends.map((s) => new Date(s.sentAt as Date)), now);
    const plan = dispatchPlan({ benchmarkCapturedAt: capturedAt, capFreeAt, now, blockingPolicy: `BROKERAGE_SEND_CAP_30D=${BROKERAGE_SEND_CAP_30D} per market (spec 120)` });
    plans.push({ prospectId: id, name: p.businessName, market: p.market, brokerage: bk, inCohortSnapshot: Boolean(member), band, ...plan });
  }
  const dispatchable = plans.filter((x) => x.status === "DISPATCHABLE_NOW").length;
  return { source: latest.file, cohortFunnel: report.funnel, qualified: plans.length, dispatchableNow: dispatchable, deferredQualified: plans.length - dispatchable, plans };
}

async function benchmarkCapturedFor(prospectId: string): Promise<Date | null> {
  const [r] = await sql`select r.completed_at from prospect_benchmarks b join runs r on r.id = b.run_id where b.prospect_id = ${prospectId} and r.completed_at is not null order by r.completed_at desc limit 1`;
  return r ? new Date(r.completedAt as Date) : null;
}

async function main(): Promise<void> {
  const now = new Date();
  const minVolume = Number(arg("--min-volume", String(DEFAULT_MIN_VOLUME_USD)));
  const researchMarkets = Number(arg("--research-markets", "15"));
  const outDir = `.local-data/supply/${now.toISOString().slice(0, 10)}`;
  mkdirSync(outDir, { recursive: true });

  const profile = await universeProfile(minVolume);
  const geos = await geoAggregates(minVolume);
  const ls = await launches();
  const launchByGeo = new Map(ls.filter((l) => l.state).map((l) => [marketKey(l.city, l.state!), l]));

  const all: MarketSupplyFeatures[] = [];
  const pools = new Map<string, PoolEntry[]>();
  for (const g of geos) {
    const key = marketKey(g.city, g.state);
    const l = launchByGeo.get(key) ?? null;
    const policy = resolveMarketPolicy({ names: l ? l.names : [g.city], stateCode: l?.stateCode ?? g.state, launchStatus: l?.status ?? null, exclusiveScope: l?.exclusiveScope ?? false });
    let pool: PoolEntry[] = [];
    let contactedDensity = 0;
    if (l && policy.outboundAllowed) {
      pool = await prequalifyMarket(l, policy);
      pools.set(key, pool);
      const touched = pool.filter((p) => p.blockers.includes("ALREADY_CONTACTED")).length;
      contactedDensity = pool.length ? Math.round((touched / pool.length) * 100) / 100 : 0;
    }
    all.push(features(g, l, policy, pool, now, contactedDensity, minVolume));
  }
  // Launches whose geography could not be resolved to a RealTrends city+state.
  const unresolvedLaunches = ls.filter((l) => !l.state).map((l) => ({ launchId: l.launchId, market: l.names[0], reason: "no state on file — excluded from dataset matching (Wilmington lesson)" }));

  const ranked = rankMarkets(all);
  const sizing = waveSizing();
  const waves = planWaves(ranked, sizing);
  const byState = (s: string) => all.filter((m) => m.policy.state === s).length;
  const policySummary = Object.fromEntries(["PROOF_BUILDING", "TIER_1_RESERVED", "ACTIVE_CLIENT_EXCLUSIVE", "OPEN_FOR_SCALE", "PAUSED", "UNCLASSIFIED"].map((s) => [s, byState(s)]));
  const reserved = all.filter((m) => m.policy.state === "TIER_1_RESERVED").map((m) => `${m.city}, ${m.state} (${m.sourceEntities})`);

  // Contact pipeline over prequalified entities in outbound-allowed markets.
  const contactPipeline: Record<string, number> = {};
  const contactQueue: Record<string, unknown>[] = [];
  for (const [key, pool] of pools) {
    for (const p of pool.filter((x) => x.blockers.length === 0)) {
      contactPipeline[p.contactability!] = (contactPipeline[p.contactability!] ?? 0) + 1;
      if (p.contactability !== "CONTACT_VERIFIED") contactQueue.push({ market: key, entity: p.candidate.displayName, entityType: p.candidate.entityType, teamLead: p.candidate.teamLead, brokerage: p.candidate.brokerage, volumeUsd: p.candidate.productionValue, sourceRecordId: p.candidate.sourceRecordId, prospectId: p.prospectId, contactability: p.contactability });
    }
  }
  contactQueue.sort((a, b) => Number(b.volumeUsd) - Number(a.volumeUsd));

  const prequalBlockers: Record<string, number> = {};
  for (const pool of pools.values()) for (const p of pool) for (const b of p.blockers) prequalBlockers[b] = (prequalBlockers[b] ?? 0) + 1;
  const normalization: Record<string, number> = {};
  for (const pool of pools.values()) for (const p of pool) normalization[p.candidate.status] = (normalization[p.candidate.status] ?? 0) + 1;

  const dispatch = await dispatchLayer(now);
  const allowed = all.filter((m) => m.policy.outboundAllowed);
  const funnel = {
    sourceUniverse: Number(profile.total), entityNormalized: [...pools.values()].reduce((n, p) => n + p.length, 0),
    marketAllowed: allowed.reduce((n, m) => n + m.sourceEntities, 0), prequalified: allowed.reduce((n, m) => n + m.prequalified, 0),
    contactVerified: allowed.reduce((n, m) => n + m.contactVerified, 0), benchmarked: allowed.filter((m) => m.benchmark.status !== "NONE").reduce((n, m) => n + m.prequalified, 0),
    mismatch: Number((dispatch.cohortFunnel as Record<string, number> | undefined)?.mismatchEligible ?? 0), evidenceVerified: Number((dispatch.cohortFunnel as Record<string, number> | undefined)?.evidenceVerified ?? 0),
    qualified: Number(dispatch.qualified), dispatchableNow: Number(dispatch.dispatchableNow), deferredQualified: Number(dispatch.deferredQualified),
  };
  const report = {
    versions: { supplyEngine: SUPPLY_ENGINE_VERSION, marketPolicy: MARKET_POLICY_VERSION, cohortPolicy: T1_COHORT_POLICY_VERSION, evidenceRelease: EVIDENCE_RELEASE_VERSION, mismatchThresholds: MISMATCH_THRESHOLDS, brokerageCap30d: BROKERAGE_SEND_CAP_30D },
    generatedAt: now.toISOString(), minVolumeUsd: minVolume, universe: profile, policySummary, reservedMarkets: reserved, unresolvedLaunches, sizing,
    marketsRanked: ranked.filter((r) => r.band !== "HOLD").map((r) => ({ market: `${r.features.city}, ${r.features.state}`, band: r.band, policy: r.features.policy.state, source: r.features.sourceEntities, prequalified: r.features.prequalified, aboveFloor: r.features.prequalifiedAboveFloor, brokerages: r.features.prequalifiedBrokerages, contactVerified: r.features.contactVerified, researchRequired: r.features.contactResearchRequired, benchmark: r.features.benchmark.status, expires: r.features.benchmark.expiresAt?.toISOString().slice(0, 10) ?? null, positive: r.features.positiveHistory, reasons: r.reasons })),
    holdMarkets: ranked.filter((r) => r.band === "HOLD" && r.features.launchId).map((r) => ({ market: `${r.features.city}, ${r.features.state}`, policy: r.features.policy.state, reasons: r.reasons })),
    // Founder approval queue: transparent classes over slow-changing facts.
    // Nothing here opens a market.
    marketApprovalQueue: geos.filter((g) => g.high >= 10).map((g) => {
      const m = all.find((x) => x.marketKey === marketKey(g.city, g.state))!;
      const cls = marketExpansionClass({ policyState: m.policy.state, teams: g.teams, individuals: g.individuals, highProduction: g.high, teams100m: g.teams100m, brokerageDiversity: g.brokeragesHigh, namedLeads: g.namedLeadsHigh });
      return { market: `${g.city}, ${g.state}`, policy: m.policy.state, entities: g.entities, highProduction: g.high, teams100m: g.teams100m, brokerages: g.brokeragesHigh, namedLeads: g.namedLeadsHigh, klass: cls.klass, reasons: cls.reasons };
    }).filter((q) => q.policy === "UNCLASSIFIED" || q.policy === "TIER_1_RESERVED").sort((a, b) => b.highProduction - a.highProduction).slice(0, Math.max(researchMarkets, 25)),
    normalization, prequalBlockers, contactPipeline, waves, funnel, metrics: supplyMetrics(funnel, allowed.filter((m) => m.benchmark.status !== "NONE").length), target: { ...T1_COHORT_TARGET, qualified: funnel.qualified },
    dispatch,
  };
  writeFileSync(`${outDir}/market-supply-view.json`, JSON.stringify({ ...report, allMarkets: all.map((m) => ({ market: `${m.city}, ${m.state}`, policy: m.policy.state, entities: m.sourceEntities, high: m.highProduction })) }, null, 1));
  writeFileSync(`${outDir}/contact-research-queue.json`, JSON.stringify(contactQueue, null, 1));
  for (const [key, pool] of pools) writeFileSync(`${outDir}/pool-${key.replace(/[^a-z0-9]+/gi, "-")}.json`, JSON.stringify(pool, null, 1));
  console.log(JSON.stringify({ ...report, dispatch: { ...dispatch, plans: undefined }, waves: waves.slice(0, 20) }, null, 1));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
