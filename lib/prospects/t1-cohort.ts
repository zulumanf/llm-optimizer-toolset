/**
 * Touch 1 cohort construction (2026-09-11): the pure eligibility, dedupe,
 * priority-band, selection and freeze layer over facts the DB assembler
 * (scripts/t1-cohort-build.ts) loads through the canonical services.
 *
 * No new hard thresholds live here. Every hard gate delegates to an
 * existing policy: spec 124 mismatch evaluation (thresholds in
 * MISMATCH_THRESHOLDS), spec 136 evidence release, spec 052 exclusivity,
 * spec 062 suppression, spec 120 per-market brokerage cap, spec 042 contact
 * provenance, spec 098 stage/contact gates. Bands (A+/A/B/HOLD) are a
 * transparent RANKING over preserved raw features — never a gate — and a
 * prospect with zero recommendations is never gated on that alone.
 */
import {
  BROKERAGE_SEND_CAP_30D,
  MISMATCH_TEMPLATE_VERSION,
  MISMATCH_THRESHOLDS,
  type ProvenanceLabel,
} from "@/lib/prospects/constants";
import { EVIDENCE_RELEASE_VERSION } from "@/lib/prospects/evidence-release";
import { mismatchStrength } from "@/lib/prospects/mismatch";

export const T1_COHORT_POLICY_VERSION = "t1-cohort-policy-v1";
/** Target band for one analyzable learning batch. Under-supply freezes
 * what exists and reports a gap; it never loosens a gate. */
export const T1_COHORT_TARGET = { min: 75, max: 100 } as const;

/** Reserved-market names come from the canonical market-policy layer
 * (lib/prospects/market-policy.ts); re-exported for the cohort scripts. */
export { PROTECTED_MARKET_NAMES } from "@/lib/prospects/market-policy";

/** Contact provenance that can carry a Touch 1 (spec 042 labels). */
export const SEND_READY_CONTACT_PROVENANCE: readonly ProvenanceLabel[] = ["verified", "publicly_sourced"];

/** Local parts that address a role or a shared inbox, never the named
 * decision-maker. A Touch 1 needs a person; these fail closed. */
export const GENERIC_EMAIL_LOCAL_PARTS = ["info", "office", "admin", "hello", "contact", "team", "sales", "support", "frontdesk", "agent", "agents", "listings"] as const;

export function isGenericEmail(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return (GENERIC_EMAIL_LOCAL_PARTS as readonly string[]).includes(local);
}

/** Prospect stages that are still first-touch (spec 098 PRE_CONTACT_STAGES). */
const FIRST_TOUCH_STAGES = new Set(["identified", "researching", "benchmarking", "qualified", "outreach_ready"]);

/** Launch statuses in which outbound is not running. */
const LAUNCH_BLOCKED_STATUSES = new Set(["protected", "paused", "closed"]);

export const T1_BLOCKERS = [
  "MARKET_PROTECTED",
  "MARKET_EXCLUSIVE_CONFLICT",
  "MARKET_PAUSED",
  "STAGE_NOT_FIRST_TOUCH",
  "ALREADY_CONTACTED",
  "ACTIVE_SEQUENCE",
  "POSITIVE_RESPONDER",
  "CLIENT_OR_ENGAGEMENT",
  "DECLINED",
  "DO_NOT_CONTACT",
  "SUPPRESSED",
  "PERSON_RECENTLY_CONTACTED",
  "ENTITY_UNRESOLVED",
  "ENTITY_TYPE_UNKNOWN",
  "MISMATCH_INELIGIBLE",
  "EVIDENCE_RELEASE_BLOCKED",
  "PENDING_CORRECTION",
  "NO_CONTACT",
  "CONTACT_EMAIL_UNVERIFIED",
  "CONTACT_GENERIC_ONLY",
  "NO_RECIPIENT_FIRST_NAME",
  "DUPLICATE_BUYING_UNIT",
] as const;
export type T1Blocker = (typeof T1_BLOCKERS)[number];

export type T1Level = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type T1Band = "A+" | "A" | "B" | "HOLD";
export type T1RecBucket = "ZERO_VERIFIED" | "ONE_OR_MORE";

export interface T1BuyerSignal {
  kind: string;
  label: string;
  sourceUrl: string;
  observedOn: string;
  provenance: ProvenanceLabel;
}

/** Deterministic mismatch features frozen from the canonical evidence
 * snapshot. Raw first; interpretation lives in the band reasons. */
export interface T1Features {
  runId: string;
  provider: string;
  denominator: number;
  expectedResponses: number | null;
  validResponses: number | null;
  modelCount: number;
  benchmarkCompletedAt: string | null;
  benchmarkAgeDays: number | null;
  prospectRecs: number;
  competitorRecs: number;
  absoluteGap: number;
  /** competitorRecs / prospectRecs; null when prospectRecs = 0 (zeroCase). */
  recommendationMultiple: number | null;
  zeroCase: boolean;
  prospectDistinctQuestions: number | null;
  competitorDistinctQuestions: number | null;
  /** 1 = most-recommended company in the market's verified pool. */
  competitorAiRank: number | null;
  competitorRankUniverse: number | null;
  metricType: string;
  productionYear: number | null;
  prospectProduction: number;
  competitorProduction: number;
  competitorProductionRatio: number | null;
  productionDifference: number;
  strength: "strong" | "valid";
  competitorCompanyId: string;
  competitorName: string;
  competitorEntityLevel: "individual" | "team" | null;
  prospectProductionSignalId: string;
  competitorProductionSignalId: string;
}

export interface T1CandidateFacts {
  prospectId: string;
  companyId: string | null;
  name: string;
  prospectType: string;
  entityLevel: "individual" | "team" | null;
  market: {
    launchId: string;
    name: string;
    stateCode: string | null;
    /** True when the market or an ancestor is in PROTECTED_MARKET_NAMES. */
    protected: boolean;
    /** True when a live (active/reserved) exclusivity scope covers the
     * market and the prospect is not the client (spec 052 detectConflicts). */
    exclusiveConflict: boolean;
    launchStatus: string;
  };
  outreach: {
    stage: string;
    contacted: boolean;
    activeSequence: boolean;
    positiveReply: boolean;
    engagement: boolean;
    declined: boolean;
    doNotContact: boolean;
    suppressed: boolean;
    personRecentlyContacted: boolean;
  };
  mismatch: { eligible: boolean; reasonCodes: string[] };
  release: { verified: boolean; reasons: string[] } | null;
  pendingCorrection: boolean;
  contact: {
    id: string;
    name: string;
    role: string | null;
    email: string;
    provenance: ProvenanceLabel;
    generic: boolean;
    /** True when the recipient is the named team lead / the agent. */
    isDecisionMaker: boolean;
  } | null;
  firstName: string | null;
  features: T1Features | null;
  buyerSignals: T1BuyerSignal[];
  websiteOnFile: boolean;
  dedupe: {
    brokerageKey: string | null;
    /** Normalized lead person (RealTrends team_lead for teams, the agent
     * for individuals) — only set when the relationship is provenanced. */
    leadPersonKey: string | null;
  };
}

export interface T1BuyerAssessment {
  abilityToPay: T1Level;
  outsourcingPropensity: T1Level;
  buyingUrgency: T1Level;
  decisionFriction: T1Level;
  implementationFeasibility: T1Level;
  evidence: { dimension: keyof Omit<T1BuyerAssessment, "evidence">; level: T1Level; basis: string; sourceUrl: string | null; observedOn: string | null }[];
}

export interface T1Evaluation {
  prospectId: string;
  sendReady: boolean;
  blockers: T1Blocker[];
  recBucket: T1RecBucket | null;
  buyer: T1BuyerAssessment;
  band: T1Band;
  bandReasons: string[];
  whySelected: string[];
}

// ------------------------------------------------------------ eligibility

/** Deterministic gates. Every blocker maps to an existing policy; the
 * order is diagnostic only (all applicable blockers are returned). */
export function cohortBlockers(f: T1CandidateFacts): T1Blocker[] {
  const b: T1Blocker[] = [];
  if (f.market.protected) b.push("MARKET_PROTECTED");
  if (f.market.exclusiveConflict) b.push("MARKET_EXCLUSIVE_CONFLICT");
  if (LAUNCH_BLOCKED_STATUSES.has(f.market.launchStatus)) b.push("MARKET_PAUSED");
  if (!FIRST_TOUCH_STAGES.has(f.outreach.stage)) b.push("STAGE_NOT_FIRST_TOUCH");
  if (f.outreach.contacted) b.push("ALREADY_CONTACTED");
  if (f.outreach.activeSequence) b.push("ACTIVE_SEQUENCE");
  if (f.outreach.positiveReply) b.push("POSITIVE_RESPONDER");
  if (f.outreach.engagement) b.push("CLIENT_OR_ENGAGEMENT");
  if (f.outreach.declined) b.push("DECLINED");
  if (f.outreach.doNotContact) b.push("DO_NOT_CONTACT");
  if (f.outreach.suppressed) b.push("SUPPRESSED");
  if (f.outreach.personRecentlyContacted) b.push("PERSON_RECENTLY_CONTACTED");
  if (!f.companyId) b.push("ENTITY_UNRESOLVED");
  if (f.entityLevel === null) b.push("ENTITY_TYPE_UNKNOWN");
  if (!f.mismatch.eligible) b.push("MISMATCH_INELIGIBLE");
  if (f.mismatch.eligible && (!f.release || !f.release.verified)) b.push("EVIDENCE_RELEASE_BLOCKED");
  if (f.pendingCorrection) b.push("PENDING_CORRECTION");
  if (!f.contact) b.push("NO_CONTACT");
  else {
    if (!SEND_READY_CONTACT_PROVENANCE.includes(f.contact.provenance)) b.push("CONTACT_EMAIL_UNVERIFIED");
    if (f.contact.generic) b.push("CONTACT_GENERIC_ONLY");
  }
  if (!f.firstName) b.push("NO_RECIPIENT_FIRST_NAME");
  return b;
}

export function recBucket(features: T1Features | null): T1RecBucket | null {
  if (!features) return null;
  return features.prospectRecs === 0 ? "ZERO_VERIFIED" : "ONE_OR_MORE";
}

// ---------------------------------------------------------- buyer signals

const OUTSOURCING_HIGH = new Set(["paid_marketing_active", "seo_pr_investment", "hiring_marketing"]);
const OUTSOURCING_MEDIUM = new Set(["website_redesign", "media_activity"]);
const URGENCY_TRIGGERS = new Set(["brokerage_move", "new_market_launch", "team_expansion", "new_leadership", "website_redesign"]);
/** A trigger older than this reads MEDIUM, not HIGH (buying-signal
 * freshness convention, spec 042: 180 days). */
const URGENCY_FRESH_DAYS = 180;

/** Interpretable categories with the evidence that produced them. UNKNOWN
 * is the honest default; nothing here estimates willingness to pay. */
export function assessBuyer(f: T1CandidateFacts, now: Date): T1BuyerAssessment {
  const evidence: T1BuyerAssessment["evidence"] = [];
  const signals = f.buyerSignals.filter((s) => s.provenance !== "ai_inferred" && s.provenance !== "estimated");

  let outsourcing: T1Level = "UNKNOWN";
  for (const s of signals) {
    if (OUTSOURCING_HIGH.has(s.kind)) { outsourcing = "HIGH"; evidence.push({ dimension: "outsourcingPropensity", level: "HIGH", basis: `${s.kind}: ${s.label}`, sourceUrl: s.sourceUrl, observedOn: s.observedOn }); }
    else if (OUTSOURCING_MEDIUM.has(s.kind) && outsourcing !== "HIGH") { outsourcing = "MEDIUM"; evidence.push({ dimension: "outsourcingPropensity", level: "MEDIUM", basis: `${s.kind}: ${s.label}`, sourceUrl: s.sourceUrl, observedOn: s.observedOn }); }
  }

  let urgency: T1Level = "UNKNOWN";
  for (const s of signals) {
    if (!URGENCY_TRIGGERS.has(s.kind)) continue;
    const ageDays = Math.floor((now.getTime() - new Date(s.observedOn).getTime()) / 86_400_000);
    const level: T1Level = ageDays <= URGENCY_FRESH_DAYS ? "HIGH" : "MEDIUM";
    if (urgency === "UNKNOWN" || (level === "HIGH" && urgency !== "HIGH")) urgency = level;
    evidence.push({ dimension: "buyingUrgency", level, basis: `${s.kind} observed ${s.observedOn}: ${s.label}`, sourceUrl: s.sourceUrl, observedOn: s.observedOn });
  }

  let friction: T1Level = "UNKNOWN";
  if (f.prospectType === "brokerage") { friction = "HIGH"; evidence.push({ dimension: "decisionFriction", level: "HIGH", basis: "brokerage-level entity: multi-stakeholder approval expected", sourceUrl: null, observedOn: null }); }
  else if (f.contact?.isDecisionMaker) { friction = "LOW"; evidence.push({ dimension: "decisionFriction", level: "LOW", basis: `recipient is the ${f.prospectType === "team" ? "team lead" : "agent"} (${f.contact.name})`, sourceUrl: null, observedOn: null }); }
  else if (f.contact) { friction = "MEDIUM"; evidence.push({ dimension: "decisionFriction", level: "MEDIUM", basis: `recipient ${f.contact.name} (${f.contact.role ?? "role unknown"}) is not the named lead`, sourceUrl: null, observedOn: null }); }

  let feasibility: T1Level = "UNKNOWN";
  if (f.websiteOnFile || signals.some((s) => s.kind === "website_redesign")) { feasibility = "MEDIUM"; evidence.push({ dimension: "implementationFeasibility", level: "MEDIUM", basis: "a controllable official website is on file", sourceUrl: null, observedOn: null }); }

  return { abilityToPay: "UNKNOWN", outsourcingPropensity: outsourcing, buyingUrgency: urgency, decisionFriction: friction, implementationFeasibility: feasibility, evidence };
}

// ---------------------------------------------------------------- banding

/** Ranking-only conventions (not gates): a competitor recommended in this
 * many distinct questions reads as "broad" rather than a single-prompt
 * artefact. */
export const BAND_BREADTH_QUESTIONS = 3;

export function priorityBand(
  sendReady: boolean,
  features: T1Features | null,
  buyer: T1BuyerAssessment
): { band: T1Band; reasons: string[] } {
  if (!sendReady || !features) return { band: "HOLD", reasons: ["not send-ready"] };
  const reasons: string[] = [];
  const strong = features.strength === "strong";
  const breadth = (features.competitorDistinctQuestions ?? 0) >= BAND_BREADTH_QUESTIONS;
  const direct = buyer.decisionFriction === "LOW";
  const anySignal = buyer.outsourcingPropensity !== "UNKNOWN" || buyer.buyingUrgency !== "UNKNOWN";
  reasons.push(strong ? `STRONG mismatch (ratio ${features.competitorProductionRatio?.toFixed(2) ?? "n/a"} ≤ 0.8 and gap ${features.absoluteGap} ≥ 3, spec 124 diagnostic)` : `valid mismatch (gap ${features.absoluteGap}, ratio ${features.competitorProductionRatio?.toFixed(2) ?? "n/a"})`);
  reasons.push(breadth ? `competitor recommended across ${features.competitorDistinctQuestions} distinct questions` : `competitor breadth ${features.competitorDistinctQuestions ?? "unknown"} question(s)`);
  reasons.push(direct ? "decision-maker directly reachable" : `decision friction ${buyer.decisionFriction}`);
  reasons.push(anySignal ? `buyer signals: outsourcing ${buyer.outsourcingPropensity}, urgency ${buyer.buyingUrgency}` : "buyer signals UNKNOWN (does not exclude)");
  if (strong && breadth && direct && anySignal) return { band: "A+", reasons };
  if ((strong && direct) || (breadth && direct)) return { band: "A", reasons };
  return { band: "B", reasons };
}

export function evaluateCandidate(f: T1CandidateFacts, now: Date): T1Evaluation {
  const blockers = cohortBlockers(f);
  const sendReady = blockers.length === 0;
  const buyer = assessBuyer(f, now);
  const { band, reasons } = priorityBand(sendReady, f.features, buyer);
  const why: string[] = [];
  if (sendReady && f.features) {
    const x = f.features;
    why.push(`verified ${x.productionYear ?? ""} production ${x.prospectProduction.toLocaleString("en-US")} vs ${x.competitorName} ${x.competitorProduction.toLocaleString("en-US")} (${x.metricType})`);
    why.push(x.zeroCase ? `${x.competitorName} recommended ${x.competitorRecs}× in ${x.denominator} OpenAI answers; prospect verified zero` : `${x.competitorName} recommended ${x.competitorRecs}× vs prospect ${x.prospectRecs}× in ${x.denominator} OpenAI answers`);
    if (x.competitorAiRank !== null) why.push(`competitor ranks #${x.competitorAiRank} of ${x.competitorRankUniverse ?? "?"} verified entities in the market`);
    if (f.contact) why.push(`recipient ${f.contact.name} (${f.contact.role ?? "decision-maker"}), ${f.contact.provenance} email`);
    why.push(`market ${f.market.name} open (no live exclusivity, not protected)`);
    why.push(...buyer.evidence.map((e) => `${e.dimension} ${e.level}: ${e.basis}`));
  }
  return { prospectId: f.prospectId, sendReady, blockers, recBucket: recBucket(f.features), buyer, band, bandReasons: reasons, whySelected: why };
}

// ----------------------------------------------------------------- dedupe

const BAND_RANK: Record<T1Band, number> = { "A+": 0, A: 1, B: 2, HOLD: 3 };

function strengthOrder(a: { facts: T1CandidateFacts; evaluation: T1Evaluation }, b: { facts: T1CandidateFacts; evaluation: T1Evaluation }): number {
  return (
    BAND_RANK[a.evaluation.band] - BAND_RANK[b.evaluation.band] ||
    (b.facts.features?.absoluteGap ?? 0) - (a.facts.features?.absoluteGap ?? 0) ||
    (a.facts.features?.competitorProductionRatio ?? 1) - (b.facts.features?.competitorProductionRatio ?? 1) ||
    a.facts.name.localeCompare(b.facts.name)
  );
}

/**
 * One buying unit, one Touch 1: the same canonical company, or a team and
 * the person who is its provenanced lead (RealTrends team_lead) in the
 * same market. Keeps the stronger evaluation; the other is blocked with
 * DUPLICATE_BUYING_UNIT. Never infers a relationship from co-occurrence —
 * leadPersonKey is only present when the assembler had provenance.
 */
export function dedupeBuyingUnits(
  items: { facts: T1CandidateFacts; evaluation: T1Evaluation }[]
): { facts: T1CandidateFacts; evaluation: T1Evaluation }[] {
  const ordered = [...items].sort(strengthOrder);
  const seenCompany = new Set<string>();
  const seenLead = new Set<string>();
  return ordered.map((it) => {
    if (!it.evaluation.sendReady) return it;
    const companyKey = it.facts.companyId ?? "";
    const leadKey = it.facts.dedupe.leadPersonKey ? `${it.facts.market.launchId}:${it.facts.dedupe.leadPersonKey}` : null;
    const dup = seenCompany.has(companyKey) || (leadKey !== null && seenLead.has(leadKey));
    if (dup) {
      const evaluation: T1Evaluation = { ...it.evaluation, sendReady: false, blockers: [...it.evaluation.blockers, "DUPLICATE_BUYING_UNIT"], band: "HOLD", bandReasons: ["duplicate buying unit"], whySelected: [] };
      return { ...it, evaluation };
    }
    seenCompany.add(companyKey);
    if (leadKey) seenLead.add(leadKey);
    return it;
  });
}

// -------------------------------------------------------------- selection

export interface T1SelectionInput {
  items: { facts: T1CandidateFacts; evaluation: T1Evaluation }[];
  /** Allowed sends already consumed per (launchId, brokerageKey) in the
   * trailing 30 days — the spec 120 cap counts the market, not the world. */
  priorBrokerageSends: Map<string, number>;
  max?: number;
}

export interface T1Selection {
  selected: { facts: T1CandidateFacts; evaluation: T1Evaluation }[];
  deferred: { prospectId: string; name: string; reason: "BROKERAGE_CAP_30D" | "DUPLICATE_EMAIL" | "OVER_TARGET" }[];
}

export function brokerageCapKey(launchId: string, brokerageKey: string): string {
  return `${launchId}|${brokerageKey}`;
}

/** Priority order, then the canonical per-market brokerage cap and an
 * email-level dedupe. Qualified prospects that do not fit are DEFERRED —
 * still qualified, never re-graded. */
export function selectCohort(input: T1SelectionInput): T1Selection {
  const max = input.max ?? T1_COHORT_TARGET.max;
  const ready = input.items.filter((i) => i.evaluation.sendReady).sort(strengthOrder);
  const used = new Map<string, number>();
  const emails = new Set<string>();
  const selected: T1Selection["selected"] = [];
  const deferred: T1Selection["deferred"] = [];
  for (const it of ready) {
    if (selected.length >= max) { deferred.push({ prospectId: it.facts.prospectId, name: it.facts.name, reason: "OVER_TARGET" }); continue; }
    const email = it.facts.contact!.email.toLowerCase();
    if (emails.has(email)) { deferred.push({ prospectId: it.facts.prospectId, name: it.facts.name, reason: "DUPLICATE_EMAIL" }); continue; }
    const bk = it.facts.dedupe.brokerageKey;
    if (bk) {
      const key = brokerageCapKey(it.facts.market.launchId, bk);
      const consumed = (input.priorBrokerageSends.get(key) ?? 0) + (used.get(key) ?? 0);
      if (consumed >= BROKERAGE_SEND_CAP_30D) { deferred.push({ prospectId: it.facts.prospectId, name: it.facts.name, reason: "BROKERAGE_CAP_30D" }); continue; }
      used.set(key, (used.get(key) ?? 0) + 1);
    }
    emails.add(email);
    selected.push(it);
  }
  return { selected, deferred };
}

// ------------------------------------------------------------------ freeze

export type T1CohortVerdict = "COHORT_READY" | "COHORT_READY_BELOW_TARGET" | "BLOCKED";

export function cohortVerdict(sendReadyCount: number): T1CohortVerdict {
  if (sendReadyCount >= T1_COHORT_TARGET.min) return "COHORT_READY";
  return sendReadyCount > 0 ? "COHORT_READY_BELOW_TARGET" : "BLOCKED";
}

export interface T1CohortMember {
  membershipKey: string;
  cohortId: string;
  prospectId: string;
  companyId: string;
  name: string;
  entityType: string;
  entityLevel: "individual" | "team" | null;
  market: T1CandidateFacts["market"];
  contact: NonNullable<T1CandidateFacts["contact"]>;
  features: T1Features;
  recBucket: T1RecBucket;
  buyer: T1BuyerAssessment;
  buyerSignals: T1BuyerSignal[];
  band: T1Band;
  bandReasons: string[];
  whySelected: string[];
  policy: { cohortPolicyVersion: string; templateVersion: string; evidenceReleaseVersion: string; mismatchThresholds: typeof MISMATCH_THRESHOLDS };
  selectedAt: string;
  /** Selection is not permission to send; the send gate rechecks. */
  sendReadiness: "COHORT_READY_NOT_SCHEDULED";
}

export function membershipKey(cohortId: string, prospectId: string): string {
  return `${cohortId}:${prospectId}`;
}

/** Freeze the feature snapshot for each selected prospect. Immutable by
 * construction: the caller persists it and never rewrites it. */
export function freezeCohort(
  cohortId: string,
  selection: T1Selection["selected"],
  selectedAt: Date
): T1CohortMember[] {
  return selection.map(({ facts, evaluation }) => ({
    membershipKey: membershipKey(cohortId, facts.prospectId),
    cohortId,
    prospectId: facts.prospectId,
    companyId: facts.companyId!,
    name: facts.name,
    entityType: facts.prospectType,
    entityLevel: facts.entityLevel,
    market: facts.market,
    contact: facts.contact!,
    features: facts.features!,
    recBucket: evaluation.recBucket!,
    buyer: evaluation.buyer,
    buyerSignals: facts.buyerSignals,
    band: evaluation.band,
    bandReasons: evaluation.bandReasons,
    whySelected: evaluation.whySelected,
    policy: { cohortPolicyVersion: T1_COHORT_POLICY_VERSION, templateVersion: MISMATCH_TEMPLATE_VERSION, evidenceReleaseVersion: EVIDENCE_RELEASE_VERSION, mismatchThresholds: MISMATCH_THRESHOLDS },
    selectedAt: selectedAt.toISOString(),
    sendReadiness: "COHORT_READY_NOT_SCHEDULED",
  }));
}

/** Idempotent membership: members already persisted for this cohort are
 * not re-added; existing rows are never rewritten. */
export function newMembers(existingKeys: ReadonlySet<string>, members: T1CohortMember[]): T1CohortMember[] {
  return members.filter((m) => !existingKeys.has(m.membershipKey));
}

/**
 * Re-evaluate the selection against fresh facts immediately before the
 * freeze (a correction, an exclusivity agreement, a reply, a suppression
 * may have landed during construction). Anything no longer send-ready is
 * dropped with its blockers; nothing is re-graded upward.
 */
export function revalidateBeforeFreeze(
  selection: T1Selection["selected"],
  freshFacts: Map<string, T1CandidateFacts>,
  now: Date
): { kept: T1Selection["selected"]; dropped: { prospectId: string; name: string; blockers: T1Blocker[] }[] } {
  const kept: T1Selection["selected"] = [];
  const dropped: { prospectId: string; name: string; blockers: T1Blocker[] }[] = [];
  for (const it of selection) {
    const fresh = freshFacts.get(it.facts.prospectId);
    if (!fresh) { dropped.push({ prospectId: it.facts.prospectId, name: it.facts.name, blockers: ["ENTITY_UNRESOLVED"] }); continue; }
    const re = evaluateCandidate(fresh, now);
    if (re.sendReady) kept.push(it);
    else dropped.push({ prospectId: it.facts.prospectId, name: it.facts.name, blockers: re.blockers });
  }
  return { kept, dropped };
}

// ------------------------------------------------------------ diagnostics

export type T1EvidenceBottleneck =
  | "ENTITY_UNVERIFIED" | "COMPETITOR_UNVERIFIED" | "PRODUCTION_INCOMPARABLE" | "BENCHMARK_STALE"
  | "BENCHMARK_INCOMPLETE" | "PRIMARY_SHADOW_MISMATCH" | "DENOMINATOR_INVALID" | "ZERO_UNVERIFIED"
  | "PENDING_CORRECTION" | "MISMATCH_INSUFFICIENT" | "NO_INVERSION" | "NO_BENCHMARK" | "OTHER";

/** Map canonical reason codes (spec 124 + spec 136) onto the report
 * categories. First applicable category wins; codes are not invented. */
export function evidenceBottleneck(codes: string[]): T1EvidenceBottleneck {
  const has = (...xs: string[]) => xs.some((x) => codes.includes(x));
  if (has("PENDING_CORRECTION", "UNRESOLVED_EVIDENCE_ISSUE")) return "PENDING_CORRECTION";
  if (has("NO_BENCHMARK", "BENCHMARK_SCOPE_INVALID", "CHATGPT_DATA_UNAVAILABLE", "FROZEN_RUN_MISSING", "PROVIDER_MISMATCH")) return "NO_BENCHMARK";
  if (has("BENCHMARK_TOO_OLD")) return "BENCHMARK_STALE";
  if (has("BENCHMARK_INCOMPLETE")) return "BENCHMARK_INCOMPLETE";
  if (has("PRIMARY_SHADOW_COUNT_MISMATCH", "STATED_COUNT_MISMATCH")) return "PRIMARY_SHADOW_MISMATCH";
  if (has("DENOMINATOR_MISMATCH")) return "DENOMINATOR_INVALID";
  if (has("PROSPECT_ENTITY_UNVERIFIED", "AMBIGUOUS_IDENTITY", "ALIAS_COVERAGE_UNVERIFIED", "RELATIONSHIP_UNVERIFIED", "ENTITY_RESOLUTION_UNCERTAIN", "RECOMMENDATION_SEMANTICS_UNVERIFIED")) return "ENTITY_UNVERIFIED";
  if (has("COMPETITOR_ENTITY_UNVERIFIED")) return "COMPETITOR_UNVERIFIED";
  if (has("ZERO_NOT_VERIFIED")) return "ZERO_UNVERIFIED";
  if (has("PRODUCTION_DATA_UNVERIFIED", "PRODUCTION_RECORD_UNVERIFIED", "PRODUCTION_PERIOD_MISMATCH", "PRODUCTION_METRIC_MISMATCH", "PRODUCTION_VALUE_MISMATCH", "ENTITY_LEVEL_MISMATCH", "NO_VALID_COMPETITOR")) return "PRODUCTION_INCOMPARABLE";
  if (has("RECOMMENDATION_GAP_TOO_SMALL", "PRODUCTION_GAP_TOO_SMALL")) return "MISMATCH_INSUFFICIENT";
  if (has("NO_LOWER_PRODUCING_COMPETITOR", "NO_HIGHER_RECOMMENDATION_COMPETITOR")) return "NO_INVERSION";
  return "OTHER";
}

export type T1ContactBottleneck = "NO_CONTACT_FOUND" | "EMAIL_UNVERIFIED" | "ONLY_GENERIC_EMAIL" | "DECISION_MAKER_UNKNOWN" | "CONTACT_SOURCE_CONFLICT" | "OTHER";

export function contactBottleneck(blockers: T1Blocker[]): T1ContactBottleneck | null {
  if (blockers.includes("NO_CONTACT")) return "NO_CONTACT_FOUND";
  if (blockers.includes("CONTACT_EMAIL_UNVERIFIED")) return "EMAIL_UNVERIFIED";
  if (blockers.includes("CONTACT_GENERIC_ONLY")) return "ONLY_GENERIC_EMAIL";
  if (blockers.includes("NO_RECIPIENT_FIRST_NAME")) return "DECISION_MAKER_UNKNOWN";
  return null;
}

/** Build the raw feature block from the canonical snapshot + loaders. */
export function featuresFromSnapshot(input: {
  runId: string; provider: string; answerCount: number; modelCount: number; completedAt: string | null; benchmarkAgeDays: number | null;
  expectedResponses: number | null; validResponses: number | null;
  prospect: { recommendationCount: number; productionValue: number; productionYear: number | null; productionSignalId: string };
  competitor: { companyId: string; name: string; recommendationCount: number; productionValue: number; productionSignalId: string; productionRatio: number | null; recommendationGap: number; entityLevel: "individual" | "team" | null };
  metricType: string;
  distinctQuestions: { prospect: number; competitor: number } | null;
  competitorRank: { rank: number; universe: number } | null;
}): T1Features {
  const p = input.prospect.recommendationCount;
  const c = input.competitor.recommendationCount;
  return {
    runId: input.runId, provider: input.provider, denominator: input.answerCount, expectedResponses: input.expectedResponses, validResponses: input.validResponses,
    modelCount: input.modelCount, benchmarkCompletedAt: input.completedAt, benchmarkAgeDays: input.benchmarkAgeDays,
    prospectRecs: p, competitorRecs: c, absoluteGap: c - p,
    recommendationMultiple: p > 0 ? Math.round((c / p) * 100) / 100 : null, zeroCase: p === 0,
    prospectDistinctQuestions: input.distinctQuestions?.prospect ?? null, competitorDistinctQuestions: input.distinctQuestions?.competitor ?? null,
    competitorAiRank: input.competitorRank?.rank ?? null, competitorRankUniverse: input.competitorRank?.universe ?? null,
    metricType: input.metricType, productionYear: input.prospect.productionYear,
    prospectProduction: input.prospect.productionValue, competitorProduction: input.competitor.productionValue,
    competitorProductionRatio: input.competitor.productionRatio, productionDifference: input.prospect.productionValue - input.competitor.productionValue,
    strength: mismatchStrength({ productionRatio: input.competitor.productionRatio, recommendationGap: input.competitor.recommendationGap }),
    competitorCompanyId: input.competitor.companyId, competitorName: input.competitor.name, competitorEntityLevel: input.competitor.entityLevel,
    prospectProductionSignalId: input.prospect.productionSignalId, competitorProductionSignalId: input.competitor.productionSignalId,
  };
}
