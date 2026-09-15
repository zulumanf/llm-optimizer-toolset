/**
 * Evidence release verification (spec 136). THE one layer every customer-
 * facing competitive claim consumes before it leaves — Touch 1, follow-ups,
 * correction emails, private-report hand-off, sequence resume. It does not
 * compute new evidence: it re-verifies the FROZEN snapshot a draft states
 * against the real-world entity, the licensed production record, the frozen
 * run, and an independent recount, and fails closed on any gap.
 *
 * Two counting paths read the same immutable rows: the primary is the
 * canonical SQL counter (`providerRecommendationCounts`); the shadow is a
 * plain JavaScript recount over the raw response/mention rows that never
 * calls it. They must agree exactly. UNKNOWN is never PASS.
 *
 * The 2026-09-05 Blu House lesson: a snapshot can be internally consistent
 * and externally incomplete (answers named the team lead; the company had
 * no verified alias; the parser never considered them). So verification
 * also checks the snapshot against identity: every verified name (company,
 * aliases, RealTrends team lead) is searched in the raw valid answers, and a
 * hit with no current-revision mention row is an unreconciled occurrence.
 */
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { KNOWN_PARSER_VERSIONS } from "@/lib/parsing/version";
import { PARSER_VERSION_ADJUDICATION, PARSER_VERSION_LLM } from "@/lib/constants";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import {
  deriveLeadAgentAliases,
  entityResolutionStatuses,
  firstLastName,
  leadAgentRelationships,
  type EntityLevel,
  type EntityResolutionStatus,
  type LeadAgentRelationship,
} from "@/lib/prospects/entity-aliases";
import { latestEvidenceCorrection } from "@/lib/prospects/evidence-corrections";
import {
  MISMATCH_PROVIDER,
  sharedMetric,
  type MismatchEvidenceSnapshot,
  type MismatchMetricType,
} from "@/lib/prospects/mismatch";

export const EVIDENCE_RELEASE_VERSION = "evidence-release-v1";
export const EVIDENCE_RELEASE_VERIFIED = "EVIDENCE_RELEASE_VERIFIED" as const;
export const EVIDENCE_RELEASE_BLOCKED = "EVIDENCE_RELEASE_BLOCKED" as const;

/** Deterministic, operator-actionable refusal codes. Never `QA_FAILED`. */
export const RELEASE_REASON_CODES = [
  "PROSPECT_ENTITY_UNVERIFIED",
  "COMPETITOR_ENTITY_UNVERIFIED",
  "AMBIGUOUS_IDENTITY",
  "ENTITY_LEVEL_MISMATCH",
  "ALIAS_COVERAGE_UNVERIFIED",
  "RELATIONSHIP_UNVERIFIED",
  "PRODUCTION_RECORD_UNVERIFIED",
  "PRODUCTION_PERIOD_MISMATCH",
  "PRODUCTION_METRIC_MISMATCH",
  "PRODUCTION_VALUE_MISMATCH",
  "FROZEN_RUN_MISSING",
  "PROVIDER_MISMATCH",
  "BENCHMARK_INCOMPLETE",
  "DENOMINATOR_MISMATCH",
  "STATED_COUNT_MISMATCH",
  "PRIMARY_SHADOW_COUNT_MISMATCH",
  "ZERO_NOT_VERIFIED",
  "RECOMMENDATION_SEMANTICS_UNVERIFIED",
  "PENDING_CORRECTION",
  "UNRESOLVED_EVIDENCE_ISSUE",
  "BENCHMARK_MARKET_MISMATCH",
] as const;
export type ReleaseReasonCode = (typeof RELEASE_REASON_CODES)[number];

export const RELEASE_CHECK_NAMES = [
  "PROSPECT_ENTITY_VERIFIED",
  "COMPETITOR_ENTITY_VERIFIED",
  "ENTITY_LEVEL_COMPARABLE",
  "ALIAS_SET_VERIFIED",
  "RELATIONSHIPS_VERIFIED",
  "PROSPECT_PRODUCTION_VERIFIED",
  "COMPETITOR_PRODUCTION_VERIFIED",
  "PRODUCTION_COMPARABLE",
  "FROZEN_RUN_PRESENT",
  "PROVIDER_VERIFIED",
  "RUN_COMPLETENESS_ACCEPTABLE",
  "DENOMINATOR_VERIFIED",
  "BENCHMARK_MARKET_VERIFIED",
  "PRIMARY_PROSPECT_COUNT_VERIFIED",
  "SHADOW_PROSPECT_COUNT_MATCH",
  "PRIMARY_COMPETITOR_COUNT_VERIFIED",
  "SHADOW_COMPETITOR_COUNT_MATCH",
  "ZERO_COUNT_VERIFIED",
  "RECOMMENDATION_SEMANTICS_VERIFIED",
  "NO_PENDING_CORRECTION",
  "NO_UNRESOLVED_EVIDENCE_ISSUE",
] as const;
export type ReleaseCheckName = (typeof RELEASE_CHECK_NAMES)[number];

export interface ReleaseCheck {
  name: ReleaseCheckName;
  passed: boolean;
  detail: string;
  reason: ReleaseReasonCode | null;
}

// ------------------------------------------------------------ shadow recount

export interface ShadowResponse {
  id: string;
  promptId: string;
  provider: string;
  /** True when the capture errored (excluded from every count). */
  error: boolean;
  promptText: string;
  /** Null for other providers (not loaded) or errored cells. */
  responseText: string | null;
}

export interface ShadowMention {
  responseId: string;
  companyId: string;
  revision: number;
  mentioned: boolean;
  recommended: boolean;
  needsReview: boolean;
  parserVersion: string;
  /** mentions.reviewed_by is set — a person judged this row. */
  reviewed?: boolean;
}

export interface ShadowCompany {
  id: string;
  name: string;
  aliases: string[];
  /** Verified identity names beyond name+aliases (RealTrends team lead
   * forms). Searched in raw text; never used to credit anything. */
  identityNames: string[];
}

export interface ShadowCompanyResult {
  companyId: string;
  /** Distinct valid answers with a current-revision recommended row, echo
   * excluded — the shadow numerator. */
  recommended: number;
  distinctQuestions: number;
  /** Valid answers whose raw text contains a verified identity name. */
  rawOccurrenceResponses: number;
  /** Raw occurrences with NO current mention row for this company: the
   * parser never considered them (the Blu House state). */
  coverageGaps: string[];
  unresolvedReview: number;
  parserVersions: string[];
  recommendedWithoutMentioned: number;
  echoExcluded: number;
}

export interface ShadowRecount {
  provider: string;
  denominator: number;
  excluded: { errors: number; holdout: number; otherProvider: number };
  companies: Record<string, ShadowCompanyResult>;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const regexCache = new Map<string, RegExp>();
/** Mirror of the SQL echo rule (`\m … \M`, case-insensitive). */
function echoRegex(term: string): RegExp {
  const key = `e:${term}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(`(?<!\\w)${escapeRegex(term)}(?!\\w)`, "i");
    regexCache.set(key, re);
  }
  return re;
}
/** Mirror of the parser's alias boundary (lib/parsing/prepass.ts). */
function occurrenceRegex(term: string): RegExp {
  const key = `o:${term}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(`(?<![\\w.])${escapeRegex(term)}(?!\\w)(?!\\.\\w)`, "i");
    regexCache.set(key, re);
  }
  return re;
}

const nonEmpty = (xs: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
};

/** Deterministic whole-word occurrence of any name in a text. */
export function rawOccurrence(text: string | null, names: string[]): boolean {
  if (!text) return false;
  return nonEmpty(names).some((n) => occurrenceRegex(n).test(text));
}

/** Re-derived here on purpose (independent of db/mentions.ts SQL and of
 * lib/parsing/precedence.ts code): a classifier-class row (LLM, adjudication,
 * or human-reviewed) outranks every heuristic row; within a class the higher
 * revision wins. A heuristic row appended during a provider outage is
 * therefore never the row the shadow counts. */
function classifierClass(m: ShadowMention): boolean {
  return m.reviewed === true || m.parserVersion === PARSER_VERSION_LLM || m.parserVersion === PARSER_VERSION_ADJUDICATION;
}

function currentRevisions(mentions: ShadowMention[]): Map<string, ShadowMention> {
  const current = new Map<string, ShadowMention>();
  for (const m of mentions) {
    const key = `${m.responseId}:${m.companyId}`;
    const have = current.get(key);
    if (!have) { current.set(key, m); continue; }
    const mc = classifierClass(m);
    const hc = classifierClass(have);
    if (mc !== hc) { if (mc) current.set(key, m); continue; }
    if (m.revision > have.revision) current.set(key, m);
  }
  return current;
}

function shadowCompany(
  company: ShadowCompany,
  valid: ShadowResponse[],
  current: Map<string, ShadowMention>
): ShadowCompanyResult {
  const echoNames = nonEmpty([company.name, ...company.aliases]);
  const identity = nonEmpty([company.name, ...company.aliases, ...company.identityNames]);
  const prompts = new Set<string>();
  const versions = new Set<string>();
  const out: ShadowCompanyResult = {
    companyId: company.id, recommended: 0, distinctQuestions: 0, rawOccurrenceResponses: 0,
    coverageGaps: [], unresolvedReview: 0, parserVersions: [], recommendedWithoutMentioned: 0, echoExcluded: 0,
  };
  for (const r of valid) {
    const row = current.get(`${r.id}:${company.id}`);
    if (row) {
      versions.add(row.parserVersion);
      if (row.needsReview) out.unresolvedReview += 1;
      if (row.recommended && !row.mentioned) out.recommendedWithoutMentioned += 1;
      if (row.recommended) {
        const echoed = echoNames.some((n) => echoRegex(n).test(r.promptText));
        if (echoed) out.echoExcluded += 1;
        else {
          out.recommended += 1;
          prompts.add(r.promptId);
        }
      }
    }
    if (rawOccurrence(r.responseText, identity)) {
      out.rawOccurrenceResponses += 1;
      if (!row) out.coverageGaps.push(r.id);
    }
  }
  out.distinctQuestions = prompts.size;
  out.parserVersions = [...versions].sort();
  return out;
}

/**
 * Independent recount. Same immutable rows as the primary counter, none of
 * its SQL: provider isolation, error exclusion, holdout exclusion, current
 * revision, echo exclusion and one-credit-per-answer are all re-derived
 * here in plain code. Verification logic only — never a second platform.
 */
export function shadowRecount(input: {
  provider: string;
  responses: ShadowResponse[];
  holdoutPromptIds: ReadonlySet<string>;
  mentions: ShadowMention[];
  companies: ShadowCompany[];
}): ShadowRecount {
  const excluded = { errors: 0, holdout: 0, otherProvider: 0 };
  const valid: ShadowResponse[] = [];
  for (const r of input.responses) {
    if (r.provider !== input.provider) excluded.otherProvider += 1;
    else if (r.error) excluded.errors += 1;
    else if (input.holdoutPromptIds.has(r.promptId)) excluded.holdout += 1;
    else valid.push(r);
  }
  const current = currentRevisions(input.mentions);
  const companies: Record<string, ShadowCompanyResult> = {};
  for (const c of input.companies) companies[c.id] = shadowCompany(c, valid, current);
  return { provider: input.provider, denominator: valid.length, excluded, companies };
}

// ------------------------------------------------------------- pure verdict

export interface ProductionRecord {
  id: string;
  source: "realtrends_records" | "authority_signal";
  entityType: "individual" | "team" | null;
  productionYear: number | null;
  volumeUsd: number;
  sides: number;
}

export interface ReleaseSideInput {
  role: "prospect" | "competitor";
  companyId: string;
  name: string;
  stated: {
    recommendationCount: number;
    productionSignalId: string;
    productionYear: number | null;
    productionValue: number;
  };
  entity: EntityResolutionStatus | null;
  relationship: { leadName: string | null; provenanced: boolean };
  identityNames: string[];
  production: ProductionRecord | null;
  primaryCount: number | null;
  shadow: ShadowCompanyResult | null;
}

export interface ReleaseRunInput {
  found: boolean;
  status: string | null;
  completedAt: Date | null;
  /** Non-holdout prompts × repetitions configured for the claimed provider. */
  expectedCells: number;
  validCells: number;
  errorCells: number;
  otherProviderCells: number;
}

export interface ReleaseVerdictInput {
  snapshot: { runId: string; provider: string; answerCount: number; metricType: MismatchMetricType };
  expectedProvider: string;
  knownParserVersions: readonly string[];
  run: ReleaseRunInput;
  primaryDenominator: number | null;
  shadowDenominator: number | null;
  /** Latest correction in force for this prospect/send, if any. */
  correction: { id: string; correctedAt: Date; prospectCount: number; competitorCount: number } | null;
  prospect: ReleaseSideInput;
  competitor: ReleaseSideInput;
  /** Canonical geography of the claim (hardening 2026-09-14). `projectMarketId`
   * is the run's project market (null for per-prospect benchmark projects,
   * whose identity is the prospect itself); `launchMarketId` is the
   * prospect's launch market. A market-level project answering for a
   * prospect from another market is a binding contaminated by the legacy
   * display-name collision and must never release. */
  benchmarkMarket: { projectMarketId: string | null; launchMarketId: string | null; projectLabel: string | null; launchLabel: string | null };
}

export interface ReleaseDiagnostics {
  runId: string;
  provider: string;
  expectedCells: number;
  validCells: number;
  errorCells: number;
  otherProviderCells: number;
  stated: { prospect: number; competitor: number; denominator: number };
  primary: { prospect: number | null; competitor: number | null; denominator: number | null };
  shadow: { prospect: number | null; competitor: number | null; denominator: number | null };
  coverageGaps: { prospect: number; competitor: number };
  entityLevels: { prospect: EntityLevel | null; competitor: EntityLevel | null };
  productionRecords: { prospect: string | null; competitor: string | null };
  parserVersions: string[];
  correctionId: string | null;
}

export interface EvidenceReleaseVerdict {
  version: string;
  verified: boolean;
  reasons: ReleaseReasonCode[];
  checks: ReleaseCheck[];
  diagnostics: ReleaseDiagnostics;
}

const mk = (name: ReleaseCheckName, passed: boolean, detail: string, reason: ReleaseReasonCode): ReleaseCheck => ({
  name, passed, detail, reason: passed ? null : reason,
});

const AMBIGUOUS_ENTITY = /reconciled by a human|single name|not a two-token|verify by hand/i;

function entityChecks(i: ReleaseVerdictInput): ReleaseCheck[] {
  const side = (s: ReleaseSideInput, name: ReleaseCheckName, code: ReleaseReasonCode): ReleaseCheck => {
    if (!s.entity) return mk(name, false, `${s.name}: no entity resolution status`, code);
    const ambiguous = !s.entity.verified && AMBIGUOUS_ENTITY.test(s.entity.reason);
    return mk(name, s.entity.verified, `${s.name}: ${s.entity.reason}`, ambiguous ? "AMBIGUOUS_IDENTITY" : code);
  };
  const p = i.prospect;
  const c = i.competitor;
  const pl = p.entity?.level ?? null;
  const cl = c.entity?.level ?? null;
  const recordLevelOk = (s: ReleaseSideInput, lvl: EntityLevel | null): boolean =>
    !s.production?.entityType || lvl === "brokerage" || s.production.entityType === lvl;
  const levelOk = pl !== null && cl !== null && pl === cl && recordLevelOk(p, pl) && recordLevelOk(c, cl);
  const gaps = (s: ReleaseSideInput): number => s.shadow?.coverageGaps.length ?? Number.POSITIVE_INFINITY;
  const aliasOk = p.identityNames.length > 0 && c.identityNames.length > 0 && gaps(p) === 0 && gaps(c) === 0;
  const relOk = (s: ReleaseSideInput): boolean => {
    if (s.entity?.level !== "team") return true;
    if (!s.relationship.provenanced || !s.relationship.leadName) return false;
    const lead = firstLastName(s.relationship.leadName) ?? s.relationship.leadName;
    return s.identityNames.some((n) => n.toLowerCase() === lead.toLowerCase() || n.toLowerCase() === s.relationship.leadName!.toLowerCase());
  };
  return [
    side(p, "PROSPECT_ENTITY_VERIFIED", "PROSPECT_ENTITY_UNVERIFIED"),
    side(c, "COMPETITOR_ENTITY_VERIFIED", "COMPETITOR_ENTITY_UNVERIFIED"),
    mk("ENTITY_LEVEL_COMPARABLE", levelOk,
      `prospect ${pl ?? "unknown"} (record ${p.production?.entityType ?? "n/a"}) vs competitor ${cl ?? "unknown"} (record ${c.production?.entityType ?? "n/a"})`,
      "ENTITY_LEVEL_MISMATCH"),
    mk("ALIAS_SET_VERIFIED", aliasOk,
      aliasOk
        ? `identity names searched: prospect ${p.identityNames.length}, competitor ${c.identityNames.length}; no unreconciled raw occurrences`
        : `unreconciled raw occurrences (verified name in a valid answer with no mention row): prospect ${Number.isFinite(gaps(p)) ? gaps(p) : "unknown"}, competitor ${Number.isFinite(gaps(c)) ? gaps(c) : "unknown"}`,
      "ALIAS_COVERAGE_UNVERIFIED"),
    mk("RELATIONSHIPS_VERIFIED", relOk(p) && relOk(c),
      [p, c].map((s) => s.entity?.level === "team"
        ? `${s.name}: lead ${s.relationship.leadName ?? "none"} ${s.relationship.provenanced ? "(licensed RealTrends record)" : "(NO provenance)"}`
        : `${s.name}: no person→team relationship required`).join(" | "),
      "RELATIONSHIP_UNVERIFIED"),
  ];
}

const metricValue = (r: ProductionRecord, m: MismatchMetricType): number => (m === "closed_volume" ? r.volumeUsd : r.sides);

function productionChecks(i: ReleaseVerdictInput): ReleaseCheck[] {
  const m = i.snapshot.metricType;
  const side = (s: ReleaseSideInput, name: ReleaseCheckName): ReleaseCheck => {
    const r = s.production;
    if (!r) return mk(name, false, `${s.name}: production record ${s.stated.productionSignalId} not found`, "PRODUCTION_RECORD_UNVERIFIED");
    if (r.productionYear === null || r.productionYear !== s.stated.productionYear) {
      return mk(name, false, `${s.name}: record year ${r.productionYear ?? "null"} ≠ stated ${s.stated.productionYear ?? "null"}`, "PRODUCTION_PERIOD_MISMATCH");
    }
    const v = metricValue(r, m);
    if (v !== s.stated.productionValue) {
      return mk(name, false, `${s.name}: record ${m} ${v} ≠ stated ${s.stated.productionValue}`, "PRODUCTION_VALUE_MISMATCH");
    }
    return mk(name, true, `${s.name}: ${r.source} ${r.id} · ${r.entityType ?? "unknown level"} · ${r.productionYear} · ${m} ${v}`, "PRODUCTION_RECORD_UNVERIFIED");
  };
  const p = i.prospect.production;
  const c = i.competitor.production;
  let comparable: ReleaseCheck;
  if (!p || !c) comparable = mk("PRODUCTION_COMPARABLE", false, "one side has no production record", "PRODUCTION_RECORD_UNVERIFIED");
  else if (p.productionYear === null || p.productionYear !== c.productionYear) {
    comparable = mk("PRODUCTION_COMPARABLE", false, `periods differ: ${p.productionYear ?? "null"} vs ${c.productionYear ?? "null"}`, "PRODUCTION_PERIOD_MISMATCH");
  } else if (!p.entityType || !c.entityType || p.entityType !== c.entityType) {
    comparable = mk("PRODUCTION_COMPARABLE", false, `entity levels differ: ${p.entityType ?? "unknown"} production vs ${c.entityType ?? "unknown"} production`, "ENTITY_LEVEL_MISMATCH");
  } else if (sharedMetric(p, c) !== m) {
    comparable = mk("PRODUCTION_COMPARABLE", false, `shared metric is ${sharedMetric(p, c) ?? "none"}, claim states ${m}`, "PRODUCTION_METRIC_MISMATCH");
  } else comparable = mk("PRODUCTION_COMPARABLE", true, `same period ${p.productionYear}, same level ${p.entityType}, same metric ${m}`, "PRODUCTION_METRIC_MISMATCH");
  return [side(i.prospect, "PROSPECT_PRODUCTION_VERIFIED"), side(i.competitor, "COMPETITOR_PRODUCTION_VERIFIED"), comparable];
}

const RELEASABLE_RUN_STATUSES = new Set(["completed", "partial"]);

function runChecks(i: ReleaseVerdictInput): ReleaseCheck[] {
  const r = i.run;
  const present = r.found && r.completedAt !== null;
  const providerOk = i.snapshot.provider === i.expectedProvider && r.validCells > 0;
  const complete = r.status !== null && RELEASABLE_RUN_STATUSES.has(r.status) && r.expectedCells > 0 && r.validCells === r.expectedCells;
  const denomOk = i.primaryDenominator !== null && i.shadowDenominator !== null
    && i.primaryDenominator === i.shadowDenominator && i.shadowDenominator === i.snapshot.answerCount;
  return [
    mk("FROZEN_RUN_PRESENT", present, present ? `run ${i.snapshot.runId} completed ${r.completedAt!.toISOString()}` : `run ${i.snapshot.runId} ${r.found ? "has no completion" : "not found"}`, "FROZEN_RUN_MISSING"),
    mk("PROVIDER_VERIFIED", providerOk,
      `claim provider ${i.snapshot.provider} (expected ${i.expectedProvider}); ${r.validCells} valid ${i.snapshot.provider} cells; ${r.otherProviderCells} other-provider cells excluded`,
      "PROVIDER_MISMATCH"),
    mk("RUN_COMPLETENESS_ACCEPTABLE", complete,
      `status ${r.status ?? "unknown"}; ${r.validCells} of ${r.expectedCells} expected ${i.snapshot.provider} cells valid, ${r.errorCells} errored`,
      "BENCHMARK_INCOMPLETE"),
    mk("DENOMINATOR_VERIFIED", denomOk,
      `stated ${i.snapshot.answerCount} · primary ${i.primaryDenominator ?? "unknown"} · shadow ${i.shadowDenominator ?? "unknown"}`,
      "DENOMINATOR_MISMATCH"),
    mk("BENCHMARK_MARKET_VERIFIED", benchmarkMarketMatches(i.benchmarkMarket),
      i.benchmarkMarket.projectMarketId === null
        ? "per-prospect benchmark project (identity is the prospect)"
        : `run project market ${i.benchmarkMarket.projectLabel ?? i.benchmarkMarket.projectMarketId} · prospect launch market ${i.benchmarkMarket.launchLabel ?? i.benchmarkMarket.launchMarketId ?? "none"}`,
      "BENCHMARK_MARKET_MISMATCH"),
  ];
}

/** Pure. A market-level project must answer for its own market only. */
export function benchmarkMarketMatches(m: ReleaseVerdictInput["benchmarkMarket"]): boolean {
  if (m.projectMarketId === null) return true;
  return m.launchMarketId !== null && m.launchMarketId === m.projectMarketId;
}

function countChecks(i: ReleaseVerdictInput): ReleaseCheck[] {
  const side = (s: ReleaseSideInput, primaryName: ReleaseCheckName, shadowName: ReleaseCheckName): ReleaseCheck[] => [
    mk(primaryName, s.primaryCount !== null && s.primaryCount === s.stated.recommendationCount,
      `${s.name}: stated ${s.stated.recommendationCount}, primary ${s.primaryCount ?? "unknown"}`, "STATED_COUNT_MISMATCH"),
    mk(shadowName, s.shadow !== null && s.primaryCount !== null && s.shadow.recommended === s.primaryCount,
      `${s.name}: primary ${s.primaryCount ?? "unknown"}, shadow ${s.shadow?.recommended ?? "unknown"}${s.shadow ? ` (${s.shadow.distinctQuestions} distinct questions, ${s.shadow.echoExcluded} echo-excluded)` : ""}`,
      "PRIMARY_SHADOW_COUNT_MISMATCH"),
  ];
  const zeros = [i.prospect, i.competitor].filter((s) => s.stated.recommendationCount === 0);
  const zeroOk = zeros.every((s) => s.entity?.verified === true && s.identityNames.length > 0 && s.shadow !== null && s.shadow.coverageGaps.length === 0);
  const zeroDetail = zeros.length === 0
    ? "no zero count claimed"
    : zeros.map((s) => `${s.name}: ${s.identityNames.length} identity names searched, ${s.shadow?.rawOccurrenceResponses ?? "unknown"} raw occurrences, ${s.shadow?.coverageGaps.length ?? "unknown"} unreconciled`).join(" | ");
  const versions = nonEmpty([...(i.prospect.shadow?.parserVersions ?? []), ...(i.competitor.shadow?.parserVersions ?? [])]);
  const unknownVersions = versions.filter((v) => !i.knownParserVersions.includes(v));
  const rwm = (i.prospect.shadow?.recommendedWithoutMentioned ?? 0) + (i.competitor.shadow?.recommendedWithoutMentioned ?? 0);
  const denom = i.snapshot.answerCount;
  const bounded = [i.prospect, i.competitor].every((s) => s.stated.recommendationCount >= 0 && s.stated.recommendationCount <= denom);
  const semanticsOk = unknownVersions.length === 0 && rwm === 0 && bounded;
  return [
    ...side(i.prospect, "PRIMARY_PROSPECT_COUNT_VERIFIED", "SHADOW_PROSPECT_COUNT_MATCH"),
    ...side(i.competitor, "PRIMARY_COMPETITOR_COUNT_VERIFIED", "SHADOW_COMPETITOR_COUNT_MATCH"),
    mk("ZERO_COUNT_VERIFIED", zeroOk, zeroDetail, "ZERO_NOT_VERIFIED"),
    mk("RECOMMENDATION_SEMANTICS_VERIFIED", semanticsOk,
      semanticsOk
        ? `explicit recommendation (classifier), one credit per answer, echo excluded, current revision; parser versions ${versions.join(", ") || "none"}`
        : `${unknownVersions.length ? `unknown parser versions ${unknownVersions.join(", ")}; ` : ""}${rwm ? `${rwm} rows recommended without mention; ` : ""}${bounded ? "" : "count exceeds denominator"}`,
      "RECOMMENDATION_SEMANTICS_UNVERIFIED"),
  ];
}

function integrityChecks(i: ReleaseVerdictInput): ReleaseCheck[] {
  const c = i.correction;
  const pending = c !== null && (c.prospectCount !== i.prospect.stated.recommendationCount || c.competitorCount !== i.competitor.stated.recommendationCount);
  const review = (i.prospect.shadow?.unresolvedReview ?? 0) + (i.competitor.shadow?.unresolvedReview ?? 0);
  return [
    mk("NO_PENDING_CORRECTION", !pending,
      c ? `correction ${c.id.slice(0, 8)} (${c.correctedAt.toISOString()}) states ${c.prospectCount}/${c.competitorCount}; claim states ${i.prospect.stated.recommendationCount}/${i.competitor.stated.recommendationCount}` : "no correction recorded",
      "PENDING_CORRECTION"),
    mk("NO_UNRESOLVED_EVIDENCE_ISSUE", review === 0, `${review} current mention rows awaiting human review`, "UNRESOLVED_EVIDENCE_ISSUE"),
  ];
}

/** Pure. Every check runs (no short-circuit) so the ledger explains the
 * whole state; the verdict is TRUE only when every check passed. */
export function composeReleaseVerdict(i: ReleaseVerdictInput): EvidenceReleaseVerdict {
  const checks = [...entityChecks(i), ...productionChecks(i), ...runChecks(i), ...countChecks(i), ...integrityChecks(i)];
  const reasons = [...new Set(checks.filter((c) => !c.passed).map((c) => c.reason!))];
  return {
    version: EVIDENCE_RELEASE_VERSION,
    verified: reasons.length === 0,
    reasons,
    checks,
    diagnostics: {
      runId: i.snapshot.runId,
      provider: i.snapshot.provider,
      expectedCells: i.run.expectedCells,
      validCells: i.run.validCells,
      errorCells: i.run.errorCells,
      otherProviderCells: i.run.otherProviderCells,
      stated: { prospect: i.prospect.stated.recommendationCount, competitor: i.competitor.stated.recommendationCount, denominator: i.snapshot.answerCount },
      primary: { prospect: i.prospect.primaryCount, competitor: i.competitor.primaryCount, denominator: i.primaryDenominator },
      shadow: { prospect: i.prospect.shadow?.recommended ?? null, competitor: i.competitor.shadow?.recommended ?? null, denominator: i.shadowDenominator },
      coverageGaps: { prospect: i.prospect.shadow?.coverageGaps.length ?? -1, competitor: i.competitor.shadow?.coverageGaps.length ?? -1 },
      entityLevels: { prospect: i.prospect.entity?.level ?? null, competitor: i.competitor.entity?.level ?? null },
      productionRecords: { prospect: i.prospect.production?.id ?? null, competitor: i.competitor.production?.id ?? null },
      parserVersions: nonEmpty([...(i.prospect.shadow?.parserVersions ?? []), ...(i.competitor.shadow?.parserVersions ?? [])]),
      correctionId: i.correction?.id ?? null,
    },
  };
}

/** One ledger-ready line: verdict, reason codes, failing details, and the
 * reconstruction diagnostics (versions, counts, denominators, records). */
export function releaseGateDetail(v: EvidenceReleaseVerdict): string {
  const failing = v.checks.filter((c) => !c.passed).map((c) => `[${c.name}] ${c.detail}`).join(" ");
  const diag = JSON.stringify({ version: v.version, ...v.diagnostics });
  return v.verified
    ? `${EVIDENCE_RELEASE_VERIFIED}: primary and shadow counts agree on the frozen run. diag=${diag}`
    : `${EVIDENCE_RELEASE_BLOCKED}: ${v.reasons.join(", ")}. ${failing} No competitive claim transmits until resolved. diag=${diag}`;
}

/** Deterministic customer-facing derivations. Rendering may round ("roughly
 * 44%", "12.5 times as often"); nothing downstream recomputes these. */
export function derivedClaimFigures(s: Pick<MismatchEvidenceSnapshot, "prospect" | "competitor">): {
  productionRatioPct: number | null;
  recommendationMultiple: number | null;
  absoluteGap: number;
} {
  const pv = s.prospect.productionValue;
  const cv = s.competitor.productionValue;
  const pr = s.prospect.recommendationCount;
  const cr = s.competitor.recommendationCount;
  return {
    productionRatioPct: pv > 0 ? Math.round((cv / pv) * 10_000) / 100 : null,
    recommendationMultiple: pr > 0 ? Math.round((cr / pr) * 10) / 10 : null,
    absoluteGap: cr - pr,
  };
}

// ---------------------------------------------------------------- DB loader

interface RunLoad {
  run: ReleaseRunInput;
  holdoutPromptIds: Set<string>;
  responses: ShadowResponse[];
}

type ProviderConfigRow = { provider?: string; repetitions?: number };

async function loadRun(runId: string, provider: string): Promise<RunLoad> {
  const [run] = await sql`
    select r.status, r.completed_at, r.providers,
      coalesce((select jsonb_agg(jsonb_build_object('promptId', p."promptId", 'isHoldout', coalesce(p."isHoldout", false)))
        from prompt_set_versions v, jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, "isHoldout" boolean)
        where v.id = r.prompt_set_version_id), '[]'::jsonb) as prompts
    from runs r where r.id = ${runId}
  `;
  const empty: ReleaseRunInput = { found: false, status: null, completedAt: null, expectedCells: 0, validCells: 0, errorCells: 0, otherProviderCells: 0 };
  if (!run) return { run: empty, holdoutPromptIds: new Set(), responses: [] };
  const prompts = (run.prompts as { promptId: string; isHoldout: boolean }[]) ?? [];
  const holdout = new Set(prompts.filter((p) => p.isHoldout).map((p) => p.promptId));
  const reps = ((run.providers as ProviderConfigRow[]) ?? [])
    .filter((p) => p.provider === provider)
    .reduce((n, p) => n + Number(p.repetitions ?? 0), 0);
  const rows = await sql`
    select id, prompt_id, provider, (error is not null) as errored, prompt_text,
      case when provider = ${provider} and error is null then response_text else null end as response_text
    from responses where run_id = ${runId}
  `;
  const responses: ShadowResponse[] = rows.map((r) => ({
    id: r.id as string, promptId: r.promptId as string, provider: r.provider as string, error: Boolean(r.errored),
    promptText: (r.promptText as string) ?? "", responseText: (r.responseText as string | null) ?? null,
  }));
  const own = responses.filter((r) => r.provider === provider);
  const valid = own.filter((r) => !r.error && !holdout.has(r.promptId)).length;
  return {
    run: {
      found: true,
      status: (run.status as string | null) ?? null,
      completedAt: run.completedAt ? new Date(run.completedAt as Date) : null,
      expectedCells: (prompts.length - holdout.size) * reps,
      validCells: valid,
      errorCells: own.filter((r) => r.error).length,
      otherProviderCells: responses.length - own.length,
    },
    holdoutPromptIds: holdout,
    responses,
  };
}

async function loadBenchmarkMarket(runId: string, prospectId: string | null): Promise<ReleaseVerdictInput["benchmarkMarket"]> {
  const [row] = await sql`
    select p.market_id as project_market_id, pm.name || ', ' || coalesce(pm.state_code, '?') as project_label,
      l.market_id as launch_market_id, lm.name || ', ' || coalesce(lm.state_code, '?') as launch_label
    from runs r join projects p on p.id = r.project_id
    left join markets pm on pm.id = p.market_id
    left join prospects pr on pr.id = ${prospectId}
    left join market_launches l on l.id = pr.launch_id
    left join markets lm on lm.id = l.market_id
    where r.id = ${runId}
  `;
  return {
    projectMarketId: (row?.projectMarketId as string | null) ?? null,
    launchMarketId: (row?.launchMarketId as string | null) ?? null,
    projectLabel: (row?.projectLabel as string | null) ?? null,
    launchLabel: (row?.launchLabel as string | null) ?? null,
  };
}

async function loadMentions(runId: string, companyIds: string[]): Promise<ShadowMention[]> {
  const rows = await sql`
    select m.response_id, m.company_id, m.revision, m.mentioned, m.recommended, m.needs_review, m.parser_version,
      (m.reviewed_by is not null) as reviewed
    from mentions m join responses r on r.id = m.response_id
    where r.run_id = ${runId} and m.company_id = any(${companyIds}::uuid[])
  `;
  return rows.map((m) => ({
    responseId: m.responseId as string, companyId: m.companyId as string, revision: Number(m.revision),
    mentioned: Boolean(m.mentioned), recommended: Boolean(m.recommended), needsReview: Boolean(m.needsReview),
    parserVersion: m.parserVersion as string, reviewed: Boolean(m.reviewed),
  }));
}

async function loadProductionRecord(signalId: string): Promise<ProductionRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(signalId)) return null;
  const [rt] = await sql`
    select id, entity_type, production_year, volume_usd, sides from realtrends_records
    where id = ${signalId} and match_status in ('high_confidence', 'confirmed')
  `;
  if (rt) {
    return {
      id: rt.id as string, source: "realtrends_records",
      entityType: rt.entityType === "team" || rt.entityType === "individual" ? rt.entityType : null,
      productionYear: rt.productionYear === null ? null : Number(rt.productionYear),
      volumeUsd: rt.volumeUsd === null ? 0 : Number(rt.volumeUsd),
      sides: rt.sides === null ? 0 : Math.round(Number(rt.sides)),
    };
  }
  const [sig] = await sql`select id, metadata from prospect_authority_signals where id = ${signalId}`;
  if (!sig) return null;
  const m = (sig.metadata as Record<string, unknown>) ?? {};
  const et = m.entityType ?? m["entity_type"];
  const year = m.productionYear ?? m["production_year"];
  return {
    id: sig.id as string, source: "authority_signal",
    entityType: et === "team" || et === "individual" ? et : null,
    productionYear: year === null || year === undefined ? null : Number(year),
    volumeUsd: Number(m.volumeUsd ?? m["volume_usd"] ?? 0),
    sides: Math.round(Number(m.sides ?? 0)),
  };
}

/** Verified identity names for the raw occurrence check: company name and
 * registry aliases, plus the licensed team-lead forms of a TEAM record. */
export function identityNamesFor(company: { name: string; aliases: string[] }, rel: LeadAgentRelationship | null): string[] {
  const names = [company.name, ...company.aliases];
  if (rel && rel.entityType === "team" && rel.teamLead) {
    names.push(rel.teamLead);
    const fl = firstLastName(rel.teamLead);
    if (fl) names.push(fl);
    const d = deriveLeadAgentAliases(rel);
    if (d.status === "aliases") names.push(...d.aliases);
  }
  return nonEmpty(names);
}

export interface VerifyReleaseContext {
  prospectId: string;
  /** Delivered Touch 1 send the correction ledger is keyed by; null for a
   * Touch 1 that has not transmitted (newest correction for the prospect). */
  sendId: string | null;
}

/**
 * Load everything the pure verdict needs for one frozen snapshot and
 * compose it. Reads only; never reruns the benchmark; never writes.
 */
export async function verifyEvidenceRelease(
  snapshot: MismatchEvidenceSnapshot,
  ctx: VerifyReleaseContext
): Promise<EvidenceReleaseVerdict> {
  const ids = [snapshot.prospect.companyId, snapshot.competitor.companyId];
  const [runLoad, mentions, companyRows, rels, statuses, primary, correction, prospectRecord, competitorRecord, benchmarkMarket] = await Promise.all([
    loadRun(snapshot.runId, snapshot.provider),
    loadMentions(snapshot.runId, ids),
    sql`select id, name, aliases from companies where id = any(${ids}::uuid[])`,
    leadAgentRelationships(ids),
    entityResolutionStatuses([
      { companyId: snapshot.prospect.companyId, prospectId: snapshot.prospect.prospectId },
      { companyId: snapshot.competitor.companyId, prospectId: snapshot.competitor.prospectId },
    ]),
    providerRecommendationCounts(snapshot.runId, snapshot.provider, ids),
    latestEvidenceCorrection(ctx.prospectId, ctx.sendId),
    loadProductionRecord(snapshot.prospect.productionSignalId),
    loadProductionRecord(snapshot.competitor.productionSignalId),
    loadBenchmarkMarket(snapshot.runId, snapshot.prospect.prospectId),
  ]);
  const companies = new Map(companyRows.map((c) => [c.id as string, { name: c.name as string, aliases: ((c.aliases as string[]) ?? []) }]));
  const relById = new Map(rels.map((r) => [r.companyId, r]));
  const shadowCompanies: ShadowCompany[] = ids.map((id) => {
    const c = companies.get(id) ?? { name: "", aliases: [] };
    return { id, name: c.name, aliases: c.aliases, identityNames: identityNamesFor(c, relById.get(id) ?? null) };
  });
  const shadow = shadowRecount({
    provider: snapshot.provider, responses: runLoad.responses, holdoutPromptIds: runLoad.holdoutPromptIds, mentions, companies: shadowCompanies,
  });
  const side = (role: "prospect" | "competitor", e: MismatchEvidenceSnapshot["prospect"], production: ProductionRecord | null): ReleaseSideInput => {
    const rel = relById.get(e.companyId) ?? null;
    return {
      role, companyId: e.companyId, name: e.name,
      stated: { recommendationCount: e.recommendationCount, productionSignalId: e.productionSignalId, productionYear: e.productionYear, productionValue: e.productionValue },
      entity: statuses.find((s) => s.companyId === e.companyId) ?? null,
      relationship: { leadName: rel?.teamLead ?? null, provenanced: Boolean(rel?.realtrendsRecordId && rel.entityType === "team" && rel.teamLead) },
      identityNames: shadowCompanies.find((c) => c.id === e.companyId)?.identityNames ?? [],
      production,
      primaryCount: runLoad.run.found ? (primary.recommendedByCompany[e.companyId] ?? 0) : null,
      shadow: shadow.companies[e.companyId] ?? null,
    };
  };
  return composeReleaseVerdict({
    benchmarkMarket,
    snapshot: { runId: snapshot.runId, provider: snapshot.provider, answerCount: snapshot.answerCount, metricType: snapshot.metricType },
    expectedProvider: MISMATCH_PROVIDER,
    knownParserVersions: KNOWN_PARSER_VERSIONS,
    run: runLoad.run,
    primaryDenominator: runLoad.run.found ? primary.answerCount : null,
    shadowDenominator: runLoad.run.found ? shadow.denominator : null,
    correction: correction
      ? { id: correction.id, correctedAt: correction.correctedAt, prospectCount: correction.correctedSnapshot.prospect.recommendationCount, competitorCount: correction.correctedSnapshot.competitor.recommendationCount }
      : null,
    prospect: side("prospect", snapshot.prospect, prospectRecord),
    competitor: side("competitor", snapshot.competitor, competitorRecord),
  });
}

/** The frozen snapshot a draft states: its own, or the nearest ancestor's
 * (a body rewrite carries none; a follow-up inherits Touch 1's). */
export async function evidenceSnapshotForDraft(
  db: TransactionSql | typeof sql,
  draftId: string
): Promise<{ snapshot: MismatchEvidenceSnapshot; evidenceDraftId: string } | null> {
  const [row] = await db`
    with recursive chain as (
      select id, parent_id, evidence_snapshot, 0 as depth from outreach_drafts where id = ${draftId}
      union all
      select p.id, p.parent_id, p.evidence_snapshot, c.depth + 1 from chain c join outreach_drafts p on p.id = c.parent_id
      where c.evidence_snapshot is null and c.depth < 10
    )
    select id, evidence_snapshot from chain where evidence_snapshot is not null order by depth asc limit 1
  `;
  const snap = (row?.evidenceSnapshot as MismatchEvidenceSnapshot | null) ?? null;
  if (!snap?.prospect?.companyId || !snap.competitor?.companyId) return null;
  return { snapshot: snap, evidenceDraftId: row!.id as string };
}

/** Send/approval helper: the verdict for a draft's frozen claim, or null
 * when the draft states no competitive count claim. */
export async function verifyDraftEvidenceRelease(
  db: TransactionSql | typeof sql,
  draft: { id: string; prospectId: string; sequenceId: string | null }
): Promise<EvidenceReleaseVerdict | null> {
  const found = await evidenceSnapshotForDraft(db, draft.id);
  if (!found) return null;
  let sendId: string | null = null;
  if (draft.sequenceId) {
    const [seq] = await db`select touch1_send_id from outreach_followup_sequences where id = ${draft.sequenceId}`;
    sendId = (seq?.touch1SendId as string | null) ?? null;
  }
  return verifyEvidenceRelease(found.snapshot, { prospectId: draft.prospectId, sendId });
}
