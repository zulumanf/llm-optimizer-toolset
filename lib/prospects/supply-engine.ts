/**
 * Touch 1 supply engine (2026-09-13): the pure layer that turns the FULL
 * RealTrends universe into market-level benchmark waves and, after a
 * benchmark, into QUALIFIED_T1 / DISPATCHABLE_NOW / DEFERRED_QUALIFIED.
 *
 * Upstream of spec 124 mismatch evaluation and spec 136 evidence release
 * (both unchanged, both reused through lib/prospects/t1-cohort.ts). This
 * module owns only what did not exist:
 *   - normalization + dedupe of RealTrends source records (provenanced only)
 *   - prequalification over slow-changing facts, BEFORE any benchmark spend
 *   - contactability states, so contact verification precedes benchmarking
 *   - market supply features and transparent bands (A+/A/B/HOLD + reasons)
 *   - wave sizing DERIVED from constants and the observed cohort funnel
 *   - dispatch planning: a send cap moves the dispatch date, never the grade
 *
 * No thresholds of spec 124/136 are restated here; the freshness window is
 * read from MISMATCH_THRESHOLDS, the cap from BROKERAGE_SEND_CAP_30D.
 */
import { BROKERAGE_SEND_CAP_30D, MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { type MarketPolicy, outboundWaveEligible } from "@/lib/prospects/market-policy";
import { isGenericEmail, SEND_READY_CONTACT_PROVENANCE } from "@/lib/prospects/t1-cohort";

export const SUPPLY_ENGINE_VERSION = "supply-engine-v1";

export const SUPPLY_STAGES = [
  "REAL_TRENDS_UNIVERSE",
  "ENTITY_NORMALIZED",
  "MARKET_ALLOWED",
  "PREQUALIFIED",
  "CONTACT_VERIFIED",
  "BENCHMARK_WAVE_READY",
  "BENCHMARKED",
  "EVIDENCE_VERIFIED",
  "QUALIFIED_T1",
  "DEFERRED_BY_DISPATCH_POLICY",
  "DISPATCHABLE",
  "SENT",
] as const;
export type SupplyStage = (typeof SUPPLY_STAGES)[number];

// ------------------------------------------------------------ normalization

export interface SourceRecord {
  id: string;
  fingerprint: string;
  entityType: "individual" | "team";
  entityName: string;
  teamLead: string | null;
  brokerage: string | null;
  city: string;
  state: string;
  volumeUsd: number | null;
  sides: number | null;
  productionYear: number;
  companyId: string | null;
  matchStatus: string;
}

export type CanonicalStatus = "CANONICAL" | "EXACT_DUPLICATE" | "AMBIGUOUS_DUPLICATE" | "SAME_BUYING_UNIT_AS_TEAM";

export interface CanonicalCandidate {
  sourceRecordId: string;
  fingerprint: string;
  /** Canonical entity id: the linked company when one exists, else the
   * source record itself — never a fuzzy merge. */
  canonicalEntityId: string;
  entityType: "individual" | "team";
  displayName: string;
  marketKey: string;
  city: string;
  state: string;
  productionYear: number;
  productionMetric: "volume_usd";
  productionValue: number | null;
  sides: number | null;
  teamLead: string | null;
  brokerage: string | null;
  companyId: string | null;
  status: CanonicalStatus;
  /** For SAME_BUYING_UNIT_AS_TEAM: the team record this person leads. */
  buyingUnitOf: string | null;
}

export const marketKey = (city: string, state: string): string => `${city.trim().toLowerCase()}|${state.trim().toUpperCase()}`;
const personKey = (s: string): string => s.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

/** Deterministic normalization. Identity is exact (name + type + city +
 * state). Two rows with the same identity and the same production are one
 * record; different production is AMBIGUOUS and fails closed. A person who
 * is the RealTrends-stated lead of a team in the same geography is not a
 * separate buyer — the relationship is provenanced by the team row. */
export function normalizeSourceRecords(records: SourceRecord[]): CanonicalCandidate[] {
  const groups = new Map<string, SourceRecord[]>();
  for (const r of records) {
    const k = `${personKey(r.entityName)}|${r.entityType}|${marketKey(r.city, r.state)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const leadsByGeo = new Map<string, string>();
  for (const r of records) {
    if (r.entityType === "team" && r.teamLead) leadsByGeo.set(`${personKey(r.teamLead)}|${marketKey(r.city, r.state)}`, r.id);
  }
  const out: CanonicalCandidate[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const volumes = new Set(sorted.map((r) => r.volumeUsd));
    for (let i = 0; i < sorted.length; i += 1) {
      const r = sorted[i]!;
      let status: CanonicalStatus = "CANONICAL";
      if (sorted.length > 1) status = volumes.size === 1 ? (i === 0 ? "CANONICAL" : "EXACT_DUPLICATE") : "AMBIGUOUS_DUPLICATE";
      const teamId = r.entityType === "individual" ? (leadsByGeo.get(`${personKey(r.entityName)}|${marketKey(r.city, r.state)}`) ?? null) : null;
      if (status === "CANONICAL" && teamId) status = "SAME_BUYING_UNIT_AS_TEAM";
      out.push({
        sourceRecordId: r.id, fingerprint: r.fingerprint, canonicalEntityId: r.companyId ?? r.id,
        entityType: r.entityType, displayName: r.entityName, marketKey: marketKey(r.city, r.state), city: r.city, state: r.state,
        productionYear: r.productionYear, productionMetric: "volume_usd", productionValue: r.volumeUsd, sides: r.sides,
        teamLead: r.teamLead, brokerage: r.brokerage, companyId: r.companyId, status, buyingUnitOf: teamId,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------- prequalification

export const PREQUAL_BLOCKERS = [
  "SOURCE_NOT_CANONICAL",
  "ENTITY_TYPE_UNKNOWN",
  "PRODUCTION_MISSING",
  "MARKET_OUTBOUND_BLOCKED",
  "EXCLUSIVITY_CONFLICT",
  "ALREADY_CONTACTED",
  "ACTIVE_SEQUENCE",
  "POSITIVE_RESPONDER",
  "CLIENT_OR_ENGAGEMENT",
  "DECLINED",
  "DO_NOT_CONTACT",
  "SUPPRESSED",
  "STAGE_NOT_FIRST_TOUCH",
] as const;
export type PrequalBlocker = (typeof PREQUAL_BLOCKERS)[number];

/** Prospect stages that are still first-touch (spec 098 PRE_CONTACT_STAGES). */
export const FIRST_TOUCH_STAGES = new Set(["identified", "researching", "benchmarking", "qualified", "outreach_ready"]);

export interface ExistingProspectState {
  prospectId: string;
  stage: string;
  contacted: boolean;
  activeSequence: boolean;
  positiveReply: boolean;
  engagement: boolean;
  declined: boolean;
  doNotContact: boolean;
  suppressed: boolean;
}

export interface PrequalFacts {
  candidate: CanonicalCandidate;
  policy: MarketPolicy;
  exclusiveConflict: boolean;
  existing: ExistingProspectState | null;
}

/** Slow-changing hard gates only. No production floor, no benchmark, no AI
 * mismatch — those come later. A blocker list, never a score. */
export function prequalify(f: PrequalFacts): PrequalBlocker[] {
  const b: PrequalBlocker[] = [];
  if (f.candidate.status !== "CANONICAL") b.push("SOURCE_NOT_CANONICAL");
  if (f.candidate.entityType !== "individual" && f.candidate.entityType !== "team") b.push("ENTITY_TYPE_UNKNOWN");
  if (f.candidate.productionValue === null || !f.candidate.productionYear) b.push("PRODUCTION_MISSING");
  if (!outboundWaveEligible(f.policy)) b.push("MARKET_OUTBOUND_BLOCKED");
  if (f.exclusiveConflict) b.push("EXCLUSIVITY_CONFLICT");
  const e = f.existing;
  if (e) {
    if (e.contacted) b.push("ALREADY_CONTACTED");
    if (e.activeSequence) b.push("ACTIVE_SEQUENCE");
    if (e.positiveReply) b.push("POSITIVE_RESPONDER");
    if (e.engagement) b.push("CLIENT_OR_ENGAGEMENT");
    if (e.declined) b.push("DECLINED");
    if (e.doNotContact) b.push("DO_NOT_CONTACT");
    if (e.suppressed) b.push("SUPPRESSED");
    if (!FIRST_TOUCH_STAGES.has(e.stage)) b.push("STAGE_NOT_FIRST_TOUCH");
  }
  return b;
}

// ------------------------------------------------------------ contactability

export const CONTACTABILITY = ["CONTACT_VERIFIED", "CONTACT_RESEARCH_REQUIRED", "NO_CONTACT_FOUND", "GENERIC_ONLY", "CONTACT_UNVERIFIED"] as const;
export type Contactability = (typeof CONTACTABILITY)[number];

export interface ContactFacts {
  email: string | null;
  provenance: string | null;
  /** True when a sourcing pass already ran and found nothing. */
  researched: boolean;
}

/** Only `verified` / `publicly_sourced` provenance on a non-generic address
 * is contactable (spec 042 labels; t1-cohort SEND_READY_CONTACT_PROVENANCE).
 * A pattern-guessed, AI-inferred or snippet-only address is UNVERIFIED. */
export function contactability(c: ContactFacts | null): Contactability {
  if (!c || !c.email) return c?.researched ? "NO_CONTACT_FOUND" : "CONTACT_RESEARCH_REQUIRED";
  if (isGenericEmail(c.email)) return "GENERIC_ONLY";
  if (c.provenance && (SEND_READY_CONTACT_PROVENANCE as readonly string[]).includes(c.provenance)) return "CONTACT_VERIFIED";
  return "CONTACT_UNVERIFIED";
}

// -------------------------------------------------------- benchmark freshness

export type BenchmarkStatus = "NONE" | "FRESH" | "STALE";

export function benchmarkExpiry(capturedAt: Date): Date {
  return new Date(capturedAt.getTime() + MISMATCH_THRESHOLDS.maxBenchmarkAgeDays * 86_400_000);
}

export function benchmarkFreshness(capturedAt: Date | null, now: Date): { status: BenchmarkStatus; expiresAt: Date | null } {
  if (!capturedAt) return { status: "NONE", expiresAt: null };
  const expiresAt = benchmarkExpiry(capturedAt);
  return { status: now.getTime() <= expiresAt.getTime() ? "FRESH" : "STALE", expiresAt };
}

// ------------------------------------------------------------- wave sizing

/** Observed conversion of t1-cohort-002 (2026-09-11, 384-prospect universe):
 * 203 first-touch → 47 spec-124 eligible → 32 spec-136 verified. With
 * contact verification moved BEFORE the benchmark, the expected number of
 * QUALIFIED_T1 per contact-verified entity in a fresh wave is the product.
 * Re-derive from each frozen cohort; never hand-edit. */
export const OBSERVED_FUNNEL = { firstTouch: 203, mismatchEligible: 47, evidenceVerified: 32, source: "t1-cohort-002 dry-run 2026-09-11" } as const;

export function qualifiedYieldPerContactVerified(f: typeof OBSERVED_FUNNEL = OBSERVED_FUNNEL): number {
  return (f.mismatchEligible / f.firstTouch) * (f.evidenceVerified / f.mismatchEligible);
}

/** Wave sizes derived, not chosen: the minimum makes one fresh benchmark
 * expected to yield ≥ 1 QUALIFIED_T1 (break-even against wasting a run);
 * the target makes it expected to fill one brokerage's 30-day dispatch
 * bucket (BROKERAGE_SEND_CAP_30D). */
export function waveSizing(f: typeof OBSERVED_FUNNEL = OBSERVED_FUNNEL): { yieldPerContactVerified: number; minContactVerified: number; targetContactVerified: number } {
  const y = qualifiedYieldPerContactVerified(f);
  return { yieldPerContactVerified: y, minContactVerified: Math.ceil(1 / y), targetContactVerified: Math.ceil(BROKERAGE_SEND_CAP_30D / y) };
}

// --------------------------------------------------------- market supply view

export interface MarketSupplyFeatures {
  marketKey: string;
  city: string;
  state: string;
  policy: MarketPolicy;
  launchId: string | null;
  sourceEntities: number;
  teams: number;
  individuals: number;
  /** Entities at or above the high-production line used for display only. */
  highProduction: number;
  prequalified: number;
  /** Prequalified entities at or above the supply-efficiency production
   * floor the orchestrator used — a ranking input for wave depth, never a
   * gate (a $15M team with a lower-producing, more-recommended competitor
   * still qualifies through spec 124). */
  prequalifiedAboveFloor: number;
  prequalifiedBrokerages: number;
  contactVerified: number;
  contactResearchRequired: number;
  contactedDensity: number;
  benchmark: { status: BenchmarkStatus; capturedAt: Date | null; expiresAt: Date | null; runId: string | null };
  positiveHistory: number;
  clientHistory: number;
}

export type MarketBand = "A+" | "A" | "B" | "HOLD";

/** Transparent ranking of markets for wave creation. HOLD is the only
 * gate-like outcome and it only restates a policy block or an empty pool.
 * Everything above HOLD is ordering, explained in `reasons`. */
export function marketBand(m: MarketSupplyFeatures, sizing = waveSizing()): { band: MarketBand; reasons: string[] } {
  const reasons: string[] = [];
  if (!outboundWaveEligible(m.policy)) return { band: "HOLD", reasons: [`Market policy ${m.policy.state}: outbound not allowed.`] };
  if (m.prequalified < sizing.minContactVerified) return { band: "HOLD", reasons: [`Only ${m.prequalified} prequalified entities; a wave needs at least ${sizing.minContactVerified} contact-verified to break even on a benchmark.`] };
  const depth = m.prequalifiedAboveFloor >= sizing.targetContactVerified;
  const diverse = m.prequalifiedBrokerages >= BROKERAGE_SEND_CAP_30D;
  const benchmarkReusable = m.benchmark.status === "FRESH";
  const contactReady = m.contactVerified >= sizing.minContactVerified;
  reasons.push(`${m.prequalified} prequalified (${m.prequalifiedAboveFloor} above the production floor) across ${m.prequalifiedBrokerages} brokerages${depth ? " (wave-target depth)" : ""}.`);
  reasons.push(benchmarkReusable ? `Fresh benchmark reusable until ${m.benchmark.expiresAt!.toISOString().slice(0, 10)}.` : m.benchmark.status === "STALE" ? "Benchmark stale: refresh needed near dispatch." : "No benchmark yet: run just-in-time once contacts are verified.");
  reasons.push(contactReady ? `${m.contactVerified} contacts already verified.` : `${m.contactVerified} contacts verified; ${m.contactResearchRequired} need research before a benchmark starts.`);
  if (m.clientHistory > 0) reasons.push(`${m.clientHistory} client engagement(s) on record — exclusivity value to confirm.`);
  if (depth && diverse && (benchmarkReusable || contactReady)) return { band: "A+", reasons };
  if (diverse && (depth || benchmarkReusable || contactReady)) return { band: "A", reasons };
  return { band: "B", reasons };
}

const BAND_ORDER: Record<MarketBand, number> = { "A+": 0, A: 1, B: 2, HOLD: 3 };

export function rankMarkets(markets: MarketSupplyFeatures[]): { features: MarketSupplyFeatures; band: MarketBand; reasons: string[] }[] {
  return markets
    .map((features) => ({ features, ...marketBand(features) }))
    .sort((a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || b.features.contactVerified - a.features.contactVerified || b.features.prequalified - a.features.prequalified);
}

// --------------------------------------------------------------- wave plan

export type BenchmarkAction = "REUSE_FRESH" | "RUN_WHEN_CONTACT_READY" | "REFRESH_WHEN_CONTACT_READY" | "RUN_NOW" | "REFRESH_NOW";

export interface BenchmarkWave {
  marketKey: string;
  city: string;
  state: string;
  launchId: string | null;
  band: MarketBand;
  prequalified: number;
  contactVerified: number;
  contactResearchRequired: number;
  benchmarkAction: BenchmarkAction;
  /** Just-in-time trigger: a fresh run starts only once this is true. */
  jitTriggered: boolean;
  contactsShortOfMinimum: number;
  benchmarkExpiresAt: Date | null;
}

/** One wave per outbound-allowed market, ordered by band. The JIT rule: a
 * fresh benchmark (or refresh) is authorized only when the market holds at
 * least the derived minimum of contact-verified prequalified entities. */
export function planWaves(ranked: ReturnType<typeof rankMarkets>, sizing = waveSizing()): BenchmarkWave[] {
  return ranked
    .filter((r) => r.band !== "HOLD")
    .map(({ features: m, band }) => {
      const jit = m.contactVerified >= sizing.minContactVerified;
      let action: BenchmarkAction;
      if (m.benchmark.status === "FRESH") action = "REUSE_FRESH";
      else if (m.benchmark.status === "STALE") action = jit ? "REFRESH_NOW" : "REFRESH_WHEN_CONTACT_READY";
      else action = jit ? "RUN_NOW" : "RUN_WHEN_CONTACT_READY";
      return {
        marketKey: m.marketKey, city: m.city, state: m.state, launchId: m.launchId, band,
        prequalified: m.prequalified, contactVerified: m.contactVerified, contactResearchRequired: m.contactResearchRequired,
        benchmarkAction: action, jitTriggered: jit || m.benchmark.status === "FRESH",
        contactsShortOfMinimum: Math.max(0, sizing.minContactVerified - m.contactVerified),
        benchmarkExpiresAt: m.benchmark.expiresAt,
      };
    });
}

// --------------------------------------------------- qualification vs dispatch

export type DispatchStatus = "DISPATCHABLE_NOW" | "DEFERRED_QUALIFIED";

export interface DispatchPlan {
  status: DispatchStatus;
  blockingPolicy: string | null;
  nextEligibleSendAt: Date;
  benchmarkExpiresAt: Date;
  /** True when the earliest send date lies past the benchmark's expiry:
   * queue a refresh near dispatch instead of discarding the prospect. */
  refreshRequiredBeforeSend: boolean;
}

/** The date a per-market brokerage bucket frees: with `cap` allowed sends
 * inside the trailing window, the oldest of the last `cap` must roll off. */
export function brokerageCapFreeAt(sentAts: Date[], now: Date, cap = BROKERAGE_SEND_CAP_30D, windowDays = 30): Date {
  const windowStart = now.getTime() - windowDays * 86_400_000;
  const inWindow = sentAts.map((d) => d.getTime()).filter((t) => t > windowStart).sort((a, b) => a - b);
  if (inWindow.length < cap) return now;
  return new Date(inWindow[inWindow.length - cap]! + windowDays * 86_400_000);
}

/** A qualified prospect is never re-graded by an operational cap: the cap
 * only moves the dispatch date, and a date past benchmark expiry demands a
 * just-in-time refresh rather than a discard. */
export function dispatchPlan(input: { benchmarkCapturedAt: Date; capFreeAt: Date; now: Date; blockingPolicy: string | null }): DispatchPlan {
  const benchmarkExpiresAt = benchmarkExpiry(input.benchmarkCapturedAt);
  const deferred = input.capFreeAt.getTime() > input.now.getTime();
  const nextEligibleSendAt = deferred ? input.capFreeAt : input.now;
  return {
    status: deferred ? "DEFERRED_QUALIFIED" : "DISPATCHABLE_NOW",
    blockingPolicy: deferred ? input.blockingPolicy : null,
    nextEligibleSendAt,
    benchmarkExpiresAt,
    refreshRequiredBeforeSend: nextEligibleSendAt.getTime() > benchmarkExpiresAt.getTime(),
  };
}

// ---------------------------------------------------------------- metrics

export interface SupplyFunnel {
  sourceUniverse: number;
  entityNormalized: number;
  marketAllowed: number;
  prequalified: number;
  contactVerified: number;
  benchmarked: number;
  mismatch: number;
  evidenceVerified: number;
  qualified: number;
  dispatchableNow: number;
  deferredQualified: number;
}

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);

export function supplyMetrics(f: SupplyFunnel, benchmarkedMarkets: number): Record<string, number | null> {
  return {
    contactVerificationRate: rate(f.contactVerified, f.prequalified),
    evidenceVerificationRate: rate(f.evidenceVerified, f.mismatch),
    qualifiedPerContactVerified: rate(f.qualified, f.contactVerified),
    qualifiedPerBenchmarkedMarket: rate(f.qualified, benchmarkedMarkets),
    dispatchableShareOfQualified: rate(f.dispatchableNow, f.qualified),
  };
}

// ------------------------------------------------------ promotion identity

export type PromotionIdentityVerdict = { ok: true } | { ok: false; reason: "ENTITY_TYPE_MISMATCH" | "NAME_MISMATCH"; detail: string };

/** Permanent regression property (2026-09-14 Lipschutz case): a source
 * record may be promoted onto an existing company only when the company
 * is the same commercial entity. A machine match (anything short of a
 * human `confirmed`) must carry the record's exact entity name, and a
 * company already measured at another entity level never absorbs a
 * record of a different level. A team lead relationship is recorded on
 * the team; it never turns the measured entity into the person. */
export function promotionIdentityCheck(record: { entityName: string; entityType: "individual" | "team"; matchStatus: string }, company: { name: string; measuredLevel: "individual" | "team" | "brokerage" | null } | null): PromotionIdentityVerdict {
  if (!company) return { ok: true };
  if (company.measuredLevel && company.measuredLevel !== record.entityType) {
    return { ok: false, reason: "ENTITY_TYPE_MISMATCH", detail: `record is a ${record.entityType} but company "${company.name}" is measured as ${company.measuredLevel}` };
  }
  const same = company.name.trim().toLowerCase() === record.entityName.trim().toLowerCase();
  if (!same && record.matchStatus !== "confirmed") {
    const personLike = /^[A-Za-z.'-]+\s+[A-Za-z.'-]+$/.test(company.name.trim()) && record.entityType === "team";
    return { ok: false, reason: personLike ? "ENTITY_TYPE_MISMATCH" : "NAME_MISMATCH", detail: `record "${record.entityName}" is machine-matched to company "${company.name}"` };
  }
  return { ok: true };
}

// ------------------------------------------------------- market expansion

export type MarketExpansionClass = "PROOF_BUILDING_CANDIDATE" | "PREMIUM_RESERVE_CANDIDATE" | "RESEARCH_MORE" | "LOW_PRIORITY";

export interface MarketExpansionFeatures {
  policyState: MarketPolicy["state"];
  teams: number;
  individuals: number;
  /** Entities at or above $50M closed volume. */
  highProduction: number;
  /** Teams at or above $100M — the economic-value signal a reserve
   * decision would weigh. */
  teams100m: number;
  brokerageDiversity: number;
  /** Entities with a named team lead (accessibility). */
  namedLeads: number;
}

/** PREMIUM_RESERVE_CANDIDATE is the top slice of economic value (a market
 * whose exclusivity a paying client would want later). It applies where
 * $100M+ teams number at or above this floor — the same line the RealTrends
 * profile put between the six largest metros and the rest. */
export const PREMIUM_RESERVE_TEAMS_100M = 15;
/** A proof-building candidate needs enough high producers for repeated
 * waves (≥ wave target of 20 contact-verified at a ~30% hit rate → ~60
 * entities at the $50M line is generous; 20 is the floor) and enough
 * brokerages that the per-market cap does not bottleneck dispatch. */
export const PROOF_BUILDING_MIN_HIGH_PRODUCTION = 20;

/** Transparent classes for the founder's approval queue. Never opens a
 * market: UNCLASSIFIED stays UNCLASSIFIED until a launch exists. */
export function marketExpansionClass(f: MarketExpansionFeatures): { klass: MarketExpansionClass; reasons: string[] } {
  const reasons: string[] = [];
  if (f.policyState === "TIER_1_RESERVED") return { klass: "PREMIUM_RESERVE_CANDIDATE", reasons: ["already reserved by founder directive"] };
  if (f.policyState !== "UNCLASSIFIED") return { klass: "LOW_PRIORITY", reasons: [`already ${f.policyState}`] };
  const diverse = f.brokerageDiversity >= BROKERAGE_SEND_CAP_30D * 3;
  reasons.push(`${f.highProduction} entities ≥ $50M, ${f.teams100m} teams ≥ $100M, ${f.brokerageDiversity} brokerages among them, ${f.namedLeads} named leads`);
  if (f.teams100m >= PREMIUM_RESERVE_TEAMS_100M) {
    reasons.push("economic value in the top slice: exclusivity is worth more later than a first experiment now");
    return { klass: "PREMIUM_RESERVE_CANDIDATE", reasons };
  }
  if (f.highProduction >= PROOF_BUILDING_MIN_HIGH_PRODUCTION && diverse) {
    reasons.push("depth for repeated waves and enough brokerages for the per-market cap");
    return { klass: "PROOF_BUILDING_CANDIDATE", reasons };
  }
  if (f.highProduction >= PROOF_BUILDING_MIN_HIGH_PRODUCTION / 2) {
    reasons.push("some depth; confirm contactability before proposing");
    return { klass: "RESEARCH_MORE", reasons };
  }
  return { klass: "LOW_PRIORITY", reasons };
}
