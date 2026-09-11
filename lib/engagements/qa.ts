/**
 * Deterministic delivery QA (spec 132). Pure, client-safe evaluators over
 * canonical state — the seven lanes that make multi-client delivery explicit
 * instead of remembered. Nothing here reads a database or calls a model; an
 * LLM reviewer (lib/engagements/reviewers.ts) is advisory and sits AFTER
 * these checks, never instead of them.
 */
import type { ContractStatus, EngagementStage, RenewalStatus } from "@/lib/engagements/constants";
import type { ChecklistItem, MeasurementGrade, MeasurementSnapshot } from "@/lib/engagements/rules";
import { CLIENT_UPDATE_CADENCE_DAYS, RESOLVER_POLICY_VERSION } from "@/lib/engagements/constants";

export const DELIVERY_QA_VERSION = "delivery-qa-v1";

export const QA_LANES = [
  "activation",
  "evidence",
  "execution",
  "measurement",
  "communication",
  "portfolio",
  "security",
  "offboarding",
] as const;
export type QaLane = (typeof QA_LANES)[number];
export type QaSeverity = "P0" | "P1" | "P2";

export interface QaIssue {
  lane: QaLane;
  code: string;
  severity: QaSeverity;
  message: string;
  detail?: Record<string, unknown>;
}

export type QaVerdict = "PASS" | "BLOCKED" | "REVIEW_REQUIRED";

export type QaStatus = "CLEAR" | "ATTENTION" | "BLOCKED" | "P0";

export function verdictFor(issues: QaIssue[]): QaVerdict {
  if (issues.some((i) => i.severity === "P0")) return "BLOCKED";
  if (issues.some((i) => i.severity === "P1")) return "REVIEW_REQUIRED";
  return "PASS";
}

export function qaStatusFor(issues: { severity: QaSeverity; blocking?: boolean }[]): QaStatus {
  if (issues.some((i) => i.severity === "P0")) return "P0";
  if (issues.some((i) => i.blocking)) return "BLOCKED";
  if (issues.some((i) => i.severity === "P1")) return "ATTENTION";
  return "CLEAR";
}

// ------------------------------------------------------------ 1. activation

/** Days after capture beyond which a baseline is stale at activation. */
export const BASELINE_STALE_DAYS = 120;

export interface ActivationInput {
  stage: EngagementStage;
  subjectLinked: boolean;
  primaryContactNamed: boolean;
  startsOn: string;
  endsOn: string;
  monthlyFeeUsd: number;
  totalValueUsd: number;
  contractStatus: ContractStatus;
  contractRef: string | null;
  paymentsReceivedCents: number;
  activationOverrideReason: string | null;
  marketDefinitionConfirmed: boolean;
  exclusivityStatus: "active" | "reserved" | "terminated" | "none";
  marketConflicts: number;
  competitorCount: number;
  competitorConfirmed: boolean;
  baseline: MeasurementSnapshot | null;
  baselineImmutableTrigger: boolean;
  priorityItems: number;
  accessUnknown: number;
  today: string;
}

export function activationQa(i: ActivationInput): { verdict: QaVerdict; issues: QaIssue[] } {
  const issues: QaIssue[] = [];
  const add = (code: string, severity: QaSeverity, message: string, detail?: Record<string, unknown>) =>
    issues.push({ lane: "activation", code, severity, message, detail });
  const entering = i.stage === "signed" || i.stage === "onboarding" || i.stage === "active";
  if (!entering) return { verdict: "PASS", issues };
  if (!i.subjectLinked) add("ENTITY_MISSING", "P0", "Client entity (subject company) is not linked.");
  if (!i.primaryContactNamed) add("CONTACT_MISSING", "P1", "No primary contact named.");
  if (!(i.monthlyFeeUsd >= 0 && i.totalValueUsd >= 0)) add("TERMS_INVALID", "P0", "Engagement terms are not recorded.");
  if (i.endsOn <= i.startsOn) add("DATES_INVALID", "P0", "Engagement end is not after its start.");
  if (i.stage !== "signed") {
    if (i.contractStatus !== "signed") add("CONTRACT_NOT_SIGNED", "P0", `Contract is ${i.contractStatus}; onboarding/active requires signed.`);
    if (i.contractStatus === "signed" && !i.contractRef) add("CONTRACT_REF_MISSING", "P0", "Signed contract has no reference.");
    if (i.paymentsReceivedCents <= 0 && !i.activationOverrideReason) add("PAYMENT_MISSING", "P0", "No payment recorded and no founder override.");
    if (i.paymentsReceivedCents <= 0 && i.activationOverrideReason) add("PAYMENT_OVERRIDDEN", "P2", "Payment condition overridden by founder.", { reason: i.activationOverrideReason });
  }
  if (i.stage === "active") {
    if (!i.marketDefinitionConfirmed) add("MARKET_DEFINITION_MISSING", "P0", "Market definition not explicitly confirmed.");
    if (i.exclusivityStatus !== "active") add("EXCLUSIVITY_NOT_ACTIVE", "P0", `Exclusivity agreement is ${i.exclusivityStatus}.`);
    if (!i.baseline) add("BASELINE_MISSING", "P0", "No frozen baseline package.");
    if (i.priorityItems === 0) add("CONTEXT_MISSING", "P1", "No client priority captured.");
  }
  if (i.marketConflicts > 0) add("EXCLUSIVITY_CONFLICT", "P0", "Another live engagement overlaps this market.", { conflicts: i.marketConflicts });
  if (i.stage !== "signed" && i.competitorCount === 0) add("COMPETITOR_SET_EMPTY", "P1", "No competitor tracked; the baseline would freeze without a rival.");
  if (i.stage === "active" && !i.competitorConfirmed) add("COMPETITOR_SET_UNCONFIRMED", "P2", "Competitor set not confirmed by the client (defaults to the benchmark rival).");
  if (i.baseline) {
    if (i.baseline.versions.resolverPolicy !== RESOLVER_POLICY_VERSION) add("BASELINE_RESOLVER_OUTDATED", "P1", `Baseline frozen under ${i.baseline.versions.resolverPolicy}; current policy is ${RESOLVER_POLICY_VERSION}.`);
    if (!i.baselineImmutableTrigger) add("BASELINE_NOT_IMMUTABLE", "P0", "Immutability trigger missing on engagement_measurements.");
    if (i.baseline.capturedAt && daysBetweenIso(i.baseline.capturedAt.slice(0, 10), i.today) > BASELINE_STALE_DAYS) {
      add("STALE_EVIDENCE", "P1", `Baseline captured ${i.baseline.capturedAt.slice(0, 10)}, more than ${BASELINE_STALE_DAYS} days ago.`);
    }
    if (i.baseline.answerCount === 0) add("BASELINE_EMPTY", "P0", "Baseline has no valid answers.");
  }
  if (i.accessUnknown > 0) add("ACCESS_UNKNOWN", "P2", `${i.accessUnknown} access item(s) still requested.`);
  return { verdict: verdictFor(issues), issues };
}

function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ------------------------------------------------------------ 2. evidence

export interface EvidenceDriftInput {
  frozen: MeasurementSnapshot;
  /** Same run, same provider, same companies, recomputed now. */
  current: MeasurementSnapshot;
  subjectAliasesNow: string[];
  competitorsArchived: string[];
}

export function evidenceDriftQa(i: EvidenceDriftInput): QaIssue[] {
  const issues: QaIssue[] = [];
  const add = (code: string, severity: QaSeverity, message: string, detail?: Record<string, unknown>) =>
    issues.push({ lane: "evidence", code, severity, message, detail });
  if (i.current.subject.recommendedCount !== i.frozen.subject.recommendedCount || i.current.answerCount !== i.frozen.answerCount) {
    add("COUNT_DRIFT", "P1", `Recomputing the baseline run now gives ${i.current.subject.recommendedCount}/${i.current.answerCount}; frozen package says ${i.frozen.subject.recommendedCount}/${i.frozen.answerCount}. The package stays; review why the canonical rows changed.`, {
      frozen: `${i.frozen.subject.recommendedCount}/${i.frozen.answerCount}`,
      now: `${i.current.subject.recommendedCount}/${i.current.answerCount}`,
    });
  }
  for (const c of i.frozen.competitors) {
    const now = i.current.competitors.find((x) => x.companyId === c.companyId);
    if (now && now.recommendedCount !== c.recommendedCount) {
      add("COUNT_DRIFT", "P1", `${c.name}: frozen ${c.recommendedCount}, recomputed ${now.recommendedCount}.`);
    }
  }
  const frozenAliases = [...i.frozen.subject.aliases].sort().join("|");
  const nowAliases = [...i.subjectAliasesNow].sort().join("|");
  if (frozenAliases !== nowAliases) {
    add("BASELINE_ENTITY_DRIFT", "P1", "Subject aliases changed after the freeze. The baseline is not mutated; a human decides whether the change affects comparability.", { frozen: i.frozen.subject.aliases, now: i.subjectAliasesNow });
  }
  if (i.current.versions.resolverPolicy !== i.frozen.versions.resolverPolicy) {
    add("ENTITY_DRIFT", "P1", `Resolver policy is now ${i.current.versions.resolverPolicy}; baseline used ${i.frozen.versions.resolverPolicy}.`);
  }
  if (i.competitorsArchived.length > 0) {
    add("COMPETITOR_MISMATCH", "P1", "A baseline competitor company is archived or merged.", { companies: i.competitorsArchived });
  }
  return issues;
}

// ----------------------------------------------------------- 3. execution

export type ExecutionState =
  | "PASS"
  | "BLOCKED_CLIENT"
  | "BLOCKED_INTERNAL"
  | "BLOCKED_THIRD_PARTY"
  | "APPROVAL_REQUIRED"
  | "OUT_OF_SCOPE"
  | "EVIDENCE_MISSING";

export interface ExecutionTask {
  title: string;
  description: string | null;
  status: string;
  evidenceCount: number;
  observation: string | null;
  hypothesis: string | null;
  confidence: string | null;
  control: string | null;
  scope: string;
  clientApproval: string;
  blockedReason: string | null;
  targetUrl: string | null;
  beforeState: string | null;
  afterState: string | null;
  measurementNote: string | null;
  ownerId: string | null;
}

/** Words that describe work without saying what changed. A completion whose
 * title matches and whose after-state is empty is not a change. */
export const VAGUE_WORK_PATTERNS: RegExp[] = [
  /\boptimi[sz]ed?\b/i,
  /\bworked on\b/i,
  /\bimproved? (citations|visibility|seo|profiles?|site|website)\b/i,
  /\bdid seo\b/i,
  /\bseo work\b/i,
  /\bfixed visibility\b/i,
  /\bcleaned? up\b/i,
];

/** Adjacent services that are out of scope unless the engagement names them. */
export const OUT_OF_SCOPE_PATTERNS: { key: string; re: RegExp }[] = [
  { key: "social media", re: /\bsocial media\b|\binstagram\b|\btiktok\b|\bfacebook (page|ads)\b/i },
  { key: "paid advertising", re: /\bpaid (ads?|advertising|search)\b|\bgoogle ads\b|\bppc\b/i },
  { key: "website redesign", re: /\bredesign\b|\bnew (website|site) build\b|\bmigrat(e|ion) (the )?(site|website)\b/i },
  { key: "CRM", re: /\bcrm\b|\bfollow ?up boss\b|\bhubspot\b/i },
  { key: "general SEO", re: /\bseo retainer\b|\bbacklinks?\b|\blink building\b|\bkeyword (research|ranking)s?\b/i },
  { key: "PR", re: /\bpress release\b|\bpublic relations\b|\bmedia outreach\b/i },
  { key: "photography / listing marketing", re: /\bphotograph(y|er)\b|\blisting (marketing|video|flyer)\b/i },
];

export function scopeSuspicion(text: string, engagementScope: string): string | null {
  for (const p of OUT_OF_SCOPE_PATTERNS) {
    if (p.re.test(text) && !p.re.test(engagementScope)) return p.key;
  }
  return null;
}

export function executionState(t: ExecutionTask): { state: ExecutionState; reasons: string[] } {
  const reasons: string[] = [];
  if (t.scope !== "in_scope") {
    reasons.push(`scope is ${t.scope.replace(/_/g, " ")}`);
    return { state: "OUT_OF_SCOPE", reasons };
  }
  if (t.evidenceCount === 0) {
    reasons.push("no evidence linked");
    return { state: "EVIDENCE_MISSING", reasons };
  }
  if (t.clientApproval === "required" || t.clientApproval === "rejected" || t.clientApproval === "edit_requested") {
    reasons.push(`client approval ${t.clientApproval.replace(/_/g, " ")}`);
    return { state: "APPROVAL_REQUIRED", reasons };
  }
  if (t.blockedReason === "client_access" || t.blockedReason === "client_approval" || t.blockedReason === "client_input") {
    reasons.push(`waiting on client: ${t.blockedReason.replace(/_/g, " ")}`);
    return { state: "BLOCKED_CLIENT", reasons };
  }
  if (t.blockedReason === "third_party") {
    reasons.push("waiting on a third-party platform");
    return { state: "BLOCKED_THIRD_PARTY", reasons };
  }
  if (t.blockedReason === "internal") {
    reasons.push("waiting on us");
    return { state: "BLOCKED_INTERNAL", reasons };
  }
  return { state: "PASS", reasons };
}

/** Before START: scope, evidence, client input, approval. */
export function executionStartQa(t: ExecutionTask, engagementScope: string): QaIssue[] {
  const issues: QaIssue[] = [];
  const add = (code: string, severity: QaSeverity, message: string) => issues.push({ lane: "execution", code, severity, message });
  const { state, reasons } = executionState(t);
  if (state !== "PASS") add(state, "P1", `Cannot start: ${reasons.join("; ")}.`);
  const suspicion = scopeSuspicion(`${t.title} ${t.description ?? ""}`, engagementScope);
  if (suspicion && t.scope === "in_scope") add("SCOPE_SUSPECTED", "P1", `Looks like ${suspicion}, which the engagement scope does not name. Mark it needs_founder_review or confirm in-scope with a reason.`);
  if (!t.observation) add("OBSERVATION_MISSING", "P2", "No observation recorded.");
  if (!t.hypothesis) add("HYPOTHESIS_MISSING", "P2", "No hypothesis recorded.");
  if (!t.confidence) add("CONFIDENCE_MISSING", "P2", "No confidence label.");
  if (!t.control) add("CONTROL_MISSING", "P2", "No control label.");
  if (!t.targetUrl) add("TARGET_MISSING", "P2", "No target asset.");
  if (!t.measurementNote) add("MEASUREMENT_PATH_MISSING", "P2", "No measurement path.");
  if (!t.ownerId) add("OWNER_MISSING", "P2", "No owner.");
  return issues;
}

/** Before COMPLETE: what changed, where, before, after, approval provenance. */
export function executionCompleteQa(t: ExecutionTask): QaIssue[] {
  const issues: QaIssue[] = [];
  const add = (code: string, severity: QaSeverity, message: string) => issues.push({ lane: "execution", code, severity, message });
  if (!t.afterState?.trim()) add("AFTER_STATE_MISSING", "P1", "Record the exact after state before completing.");
  if (!t.beforeState?.trim()) add("BEFORE_STATE_MISSING", "P1", "Record the before state before completing.");
  if (!t.targetUrl?.trim()) add("TARGET_MISSING", "P1", "Record where the change happened (URL or profile).");
  if (VAGUE_WORK_PATTERNS.some((re) => re.test(t.title)) && !t.afterState?.trim()) {
    add("VAGUE_COMPLETION", "P1", `"${t.title}" describes activity, not a change. State what is different now.`);
  }
  if (t.clientApproval === "required" || t.clientApproval === "rejected" || t.clientApproval === "edit_requested") {
    add("APPROVAL_REQUIRED", "P1", "Client approval not captured for a change that requires it.");
  }
  if (t.blockedReason) add("STILL_BLOCKED", "P1", "Task is blocked; unblock it first.");
  return issues;
}

// --------------------------------------------------------- 4. measurement

export type ComparabilityLabel = "HIGH_COMPARABILITY" | "PARTIAL_COMPARABILITY" | "NON_COMPARABLE";

export function comparabilityLabel(grade: MeasurementGrade, runStatus: string): ComparabilityLabel {
  if (grade === "not_comparable") return "NON_COMPARABLE";
  if (runStatus !== "completed") return "PARTIAL_COMPARABILITY";
  return grade === "high" ? "HIGH_COMPARABILITY" : "PARTIAL_COMPARABILITY";
}

/** Causal or guarantee language that the evidence does not support. */
export const CAUSAL_PATTERNS: { code: string; re: RegExp }[] = [
  { code: "CAUSAL_OVERCLAIM", re: /\bcaused\b|\bcauses\b|\bcausing\b/i },
  { code: "CAUSAL_OVERCLAIM", re: /\bbecause of (our|the) (work|changes?|fix(es)?)\b/i },
  { code: "CAUSAL_OVERCLAIM", re: /\b(our|the) (changes?|work|fix(es)?) (increased|moved|improved|lifted|raised|boosted|drove|led to)\b/i },
  { code: "CAUSAL_OVERCLAIM", re: /\bmoved (you|ryan|the team|them) up\b/i },
  { code: "CAUSAL_OVERCLAIM", re: /\bthanks to (our|the) (work|changes?)\b/i },
  { code: "CAUSAL_OVERCLAIM", re: /\bresulted in\b|\bas a result of (our|the)\b/i },
  { code: "GUARANTEE", re: /\bguarantee[ds]?\b|\bwill rank\b|\brank(ed|ing)? (#\s?1|first|number one)\b|\b#\s?1 (on|in) (chatgpt|openai|ai)\b/i },
  { code: "UNSUPPORTED_PERCENT", re: /\b(visibility|recommendations?|mentions?) (increased|grew|improved|rose|jumped|up) (by )?\d+(\.\d+)?\s?%/i },
];

export function causalLanguageIssues(text: string, lane: QaLane = "measurement"): QaIssue[] {
  const issues: QaIssue[] = [];
  for (const p of CAUSAL_PATTERNS) {
    const m = p.re.exec(text);
    if (m) issues.push({ lane, code: p.code, severity: "P1", message: `"${m[0]}" states causality or a guarantee the evidence does not support.`, detail: { match: m[0] } });
  }
  return issues;
}

// -------------------------------------------------------- 5. communication

export interface CommunicationFactPack {
  clientName: string;
  marketName: string;
  otherClientNames: string[];
  /** Every "X of N" statement the canonical record supports. */
  canonicalCounts: string[];
  doneTitles: string[];
  inProgressTitles: string[];
  blockedTitles: string[];
  approvalTitles: string[];
  nextMeasurementOn: string | null;
  engagementEndsOn: string;
}

const PROSPECTING_PATTERNS = /\bcold (outreach|email)\b|\bprospect(s|ing)?\b|\btouch ?[123]\b|\bsequence\b|\bpipeline\b|\bconversion rate\b|\bopen rate\b/i;
const OPERATOR_NOTE_PATTERNS = /\binternal:|\btodo\b|\bfixme\b|\bnote to self\b|\boperator note\b|\bdo not send\b/i;
const JARGON_PATTERNS = /\bprompt set\b|\bmention row\b|\bparser\b|\bentity resolution\b|\bdenominator\b|\bholdout\b|\bclassifier\b|\brevision\b|\bsnapshot\b|\brun id\b/i;

/** Sections of the canonical weekly format. */
function sectionLines(draft: string, header: RegExp, nextHeaders: RegExp): string[] {
  const lines = draft.split("\n");
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (nextHeaders.test(l)) break;
    if (l.startsWith("- ")) out.push(l.slice(2).trim());
  }
  return out;
}

const HEADERS = /^(DONE|IN PROGRESS|NEED FROM YOU|MEASUREMENT|NEXT)\b/;

export function communicationQa(draft: string, pack: CommunicationFactPack): { verdict: "PASS" | "ISSUES"; issues: QaIssue[] } {
  const issues: QaIssue[] = [];
  const add = (code: string, severity: QaSeverity, message: string, detail?: Record<string, unknown>) =>
    issues.push({ lane: "communication", code, severity, message, detail });

  if (!draft.includes(pack.clientName)) add("CLIENT_NAME_MISSING", "P1", `Draft does not name the client (${pack.clientName}).`);
  for (const other of pack.otherClientNames) {
    if (other && other !== pack.clientName && draft.includes(other)) add("OTHER_CLIENT_DATA", "P0", `Draft mentions another client: ${other}.`);
  }
  const numberRe = /\b(\d{1,4}) of (\d{1,4})\b/g;
  const canonical = new Set(pack.canonicalCounts);
  for (const m of draft.matchAll(numberRe)) {
    const stmt = `${m[1]} of ${m[2]}`;
    if (!canonical.has(stmt)) add("NUMBER_NOT_CANONICAL", "P0", `"${stmt}" is not a count the canonical record supports.`, { statement: stmt });
  }
  for (const c of causalLanguageIssues(draft, "communication")) issues.push(c);
  if (PROSPECTING_PATTERNS.test(draft)) add("PROSPECTING_LANGUAGE", "P1", `Draft contains prospecting language ("${PROSPECTING_PATTERNS.exec(draft)?.[0]}").`);
  if (OPERATOR_NOTE_PATTERNS.test(draft)) add("OPERATOR_NOTES", "P0", "Draft contains operator notes.");
  const jargon = JARGON_PATTERNS.exec(draft);
  if (jargon) add("TECHNICAL_JARGON", "P2", `"${jargon[0]}" is internal vocabulary; say it in plain words.`);

  const done = sectionLines(draft, /^DONE\b/, HEADERS);
  const inProgress = sectionLines(draft, /^IN PROGRESS\b/, HEADERS);
  const matches = (bullet: string, titles: string[]) => titles.some((t) => bullet.toLowerCase().includes(t.toLowerCase().slice(0, 40)));
  for (const b of done) {
    if (/^no changes were completed/i.test(b)) continue;
    if (!matches(b, pack.doneTitles)) add("STATUS_MISMATCH", "P1", `DONE lists "${b.slice(0, 60)}" but no completed work item matches.`);
  }
  for (const b of inProgress) {
    if (/^nothing in progress/i.test(b)) continue;
    if (matches(b, pack.doneTitles) && !matches(b, pack.inProgressTitles)) add("STATUS_MISMATCH", "P1", `IN PROGRESS lists "${b.slice(0, 60)}" which is already complete.`);
  }
  const dateRe = /\b(20\d{2}-\d{2}-\d{2})\b/g;
  for (const m of draft.matchAll(dateRe)) {
    const d = m[1]!;
    const known = new Set([pack.nextMeasurementOn, pack.engagementEndsOn].filter(Boolean));
    if (/remeasurement|measure again|next (run|measurement)/i.test(draft.slice(Math.max(0, m.index! - 80), m.index)) && !known.has(d)) {
      add("MEASUREMENT_DATE_MISMATCH", "P1", `Remeasurement date ${d} does not match the planned slot (${pack.nextMeasurementOn ?? "none"}).`);
    }
  }
  return { verdict: issues.length === 0 ? "PASS" : "ISSUES", issues };
}

// ------------------------------------------------------------ 6. portfolio

export type BillingState = "PAYMENT_CURRENT" | "PAYMENT_DUE" | "PAYMENT_OVERDUE" | "UNKNOWN";

export interface BillingEventLite {
  kind: string;
  amountCents: number;
  dueDate: string | null;
  externalInvoiceId: string | null;
}

/** Unknown never reads as current: with no ledger rows the state is UNKNOWN. */
export function billingState(events: BillingEventLite[], today: string): BillingState {
  if (events.length === 0) return "UNKNOWN";
  const invoices = events.filter((e) => e.kind === "invoice_created");
  const paidIds = new Set(events.filter((e) => e.kind === "payment_received" && e.externalInvoiceId).map((e) => e.externalInvoiceId));
  const receivedCents = events.filter((e) => e.kind === "payment_received").reduce((s, e) => s + e.amountCents, 0);
  const openInvoices = invoices.filter((i) => !(i.externalInvoiceId && paidIds.has(i.externalInvoiceId)));
  if (openInvoices.some((i) => i.dueDate && i.dueDate < today)) return "PAYMENT_OVERDUE";
  if (openInvoices.length > 0) {
    const invoicedCents = invoices.reduce((s, i) => s + i.amountCents, 0);
    return receivedCents >= invoicedCents ? "PAYMENT_CURRENT" : "PAYMENT_DUE";
  }
  if (invoices.length === 0 && receivedCents > 0) return "PAYMENT_CURRENT";
  return "PAYMENT_CURRENT";
}

export type WaitingOn = "client" | "us" | "third_party" | null;

export interface PortfolioAlert {
  code: string;
  severity: QaSeverity;
  message: string;
  nextAction: string;
  waitingOn: WaitingOn;
  /** Orchestrator rank: 0 safety, 1 client waiting on us, 2 measurement, 3 approvals/communication, 4 routine. */
  rank: 0 | 1 | 2 | 3 | 4;
  blocking?: boolean;
}

export interface PortfolioClientInput {
  stage: EngagementStage;
  startsOn: string;
  endsOn: string;
  renewalReviewOn: string;
  renewalStatus: RenewalStatus;
  onboardingDone: boolean;
  checklist: ChecklistItem[];
  commercialReady: boolean;
  commercialReasons: string[];
  exclusivityStatus: "active" | "reserved" | "terminated" | "none";
  agreementEndsOn: string | null;
  marketConflicts: number;
  tasks: { status: string; clientApproval: string; blockedReason: string | null; updatedAt: string; implementedAt: string | null; scope: string }[];
  lastChangeAt: string | null;
  lastMeasurementAt: string | null;
  nextMeasurementOn: string | null;
  lastClientUpdateOn: string | null;
  billing: BillingState;
  portalGrants: number;
  openQaIssues: QaIssue[];
  today: string;
}

export const NO_WORK_COMPLETED_DAYS = 21;
export const CLIENT_INPUT_FOLLOWUP_DAYS = 5;
export const ENGAGEMENT_ENDING_DAYS = 14;

export function portfolioAlerts(c: PortfolioClientInput): PortfolioAlert[] {
  const alerts: PortfolioAlert[] = [];
  const push = (a: PortfolioAlert) => alerts.push(a);
  const live = c.stage === "signed" || c.stage === "onboarding" || c.stage === "active" || c.stage === "renewal_review";
  if (!live) return alerts;

  for (const q of c.openQaIssues) {
    if (q.severity === "P0") push({ code: q.lane === "evidence" ? "EVIDENCE_QA_FAILURE" : q.lane === "activation" ? "BASELINE_QA_FAILURE" : "QA_FAILURE", severity: "P0", message: q.message, nextAction: "Resolve or override with a reason before continuing.", waitingOn: "us", rank: 0, blocking: true });
  }
  if (c.marketConflicts > 0) push({ code: "EXCLUSIVITY_CONFLICT", severity: "P0", message: "Another live engagement overlaps this market.", nextAction: "Founder decision: terminate one agreement or record an override with a reason.", waitingOn: "us", rank: 0, blocking: true });
  if (c.stage === "active" && c.exclusivityStatus !== "active") push({ code: "EXCLUSIVITY_CONFLICT", severity: "P0", message: `Active client without an active territory agreement (${c.exclusivityStatus}).`, nextAction: "Activate exclusivity or explain why not.", waitingOn: "us", rank: 0, blocking: true });
  if (c.agreementEndsOn && c.agreementEndsOn < c.endsOn && live) push({ code: "EXCLUSIVITY_CONFLICT", severity: "P1", message: `Territory agreement ends ${c.agreementEndsOn}, before the engagement ends ${c.endsOn}.`, nextAction: "Extend the agreement to the term end.", waitingOn: "us", rank: 0 });
  if (c.billing === "UNKNOWN" && c.stage !== "signed") push({ code: "BILLING_ATTENTION", severity: "P1", message: "Billing state unknown: no invoice or payment recorded.", nextAction: "Record the invoice and payment in the ledger.", waitingOn: "us", rank: 3 });
  if (c.billing === "PAYMENT_OVERDUE") push({ code: "BILLING_ATTENTION", severity: "P1", message: "An invoice is past due.", nextAction: "Follow up on payment.", waitingOn: "client", rank: 3 });

  if (c.stage === "signed" && !c.commercialReady) push({ code: "CLIENT_WAITING_ON_US", severity: "P1", message: `Signed but not onboarding: ${c.commercialReasons.join(" ")}`, nextAction: "Record contract/payment; start onboarding.", waitingOn: "us", rank: 1 });
  if (c.stage === "onboarding" && !c.onboardingDone) {
    const open = c.checklist.filter((x) => !x.done).map((x) => x.label.toLowerCase());
    push({ code: "ONBOARDING_INCOMPLETE", severity: "P1", message: `Onboarding incomplete: ${open.join("; ")}.`, nextAction: "Finish the checklist and mark active.", waitingOn: "us", rank: 1 });
  }

  const approvals = c.tasks.filter((t) => t.clientApproval === "required" && t.status !== "rejected");
  const clientInput = c.tasks.filter((t) => (t.blockedReason === "client_input" || t.blockedReason === "client_access") && t.status !== "rejected" && t.status !== "done");
  const readyToStart = c.tasks.filter((t) => t.status === "approved" && !t.blockedReason && (t.clientApproval === "not_required" || t.clientApproval === "approved"));
  const internalBlocked = c.tasks.filter((t) => t.blockedReason === "internal" && t.status !== "done" && t.status !== "rejected");
  const thirdParty = c.tasks.filter((t) => t.blockedReason === "third_party" && t.status !== "done" && t.status !== "rejected");
  const active = c.tasks.filter((t) => t.status === "in_progress" || t.status === "approved" || t.status === "suggested");

  if (readyToStart.length > 0) push({ code: "CLIENT_WAITING_ON_US", severity: "P1", message: `${readyToStart.length} approved change(s) cleared to start and not started.`, nextAction: "Start the work; record the before state.", waitingOn: "us", rank: 1 });
  if (internalBlocked.length > 0) push({ code: "CLIENT_WAITING_ON_US", severity: "P1", message: `${internalBlocked.length} item(s) blocked on us.`, nextAction: "Clear the internal blocker.", waitingOn: "us", rank: 1 });
  if (approvals.length > 0) push({ code: "CLIENT_APPROVAL_WAITING", severity: "P2", message: `${approvals.length} change(s) await the client's approval.`, nextAction: "No action unless the request is older than the follow-up window; then nudge in the weekly update.", waitingOn: "client", rank: 3 });
  if (clientInput.length > 0) push({ code: "CLIENT_INPUT_WAITING", severity: "P2", message: `${clientInput.length} item(s) wait on client input or access.`, nextAction: "Ask in the weekly update.", waitingOn: "client", rank: 3 });
  if (thirdParty.length > 0) push({ code: "THIRD_PARTY_WAITING", severity: "P2", message: `${thirdParty.length} item(s) wait on a third-party platform.`, nextAction: "Check the platform; record the date.", waitingOn: "third_party", rank: 4 });

  if (c.stage === "active" || c.stage === "renewal_review") {
    if (active.length === 0 && clientInput.length === 0 && thirdParty.length === 0 && approvals.length === 0) {
      push({ code: "NO_ACTIVE_WORK", severity: "P1", message: "Active client with no open, blocked or awaiting work item.", nextAction: "Add the next evidence-backed work item or record why the plan is complete.", waitingOn: "us", rank: 1 });
    }
    const lastChange = c.lastChangeAt ?? c.startsOn;
    if (daysBetweenIso(lastChange, c.today) > NO_WORK_COMPLETED_DAYS && daysBetweenIso(c.startsOn, c.today) > NO_WORK_COMPLETED_DAYS) {
      push({ code: "NO_WORK_COMPLETED_RECENTLY", severity: "P1", message: `No change completed in ${daysBetweenIso(lastChange, c.today)} days.`, nextAction: "Finish an item or record the blocker honestly.", waitingOn: "us", rank: 1 });
    }
  }

  if (c.stage !== "signed") {
    const stale = c.lastClientUpdateOn === null || daysBetweenIso(c.lastClientUpdateOn, c.today) > CLIENT_UPDATE_CADENCE_DAYS;
    if (stale) push({ code: "CLIENT_UPDATE_DUE", severity: "P1", message: c.lastClientUpdateOn ? `Last client update ${c.lastClientUpdateOn}.` : "Client has never received an update.", nextAction: "Review the composed weekly draft, send it, record it.", waitingOn: "us", rank: 3 });
  }

  if (c.nextMeasurementOn) {
    const days = daysBetweenIso(c.today, c.nextMeasurementOn);
    if (days < 0) push({ code: "MEASUREMENT_OVERDUE", severity: "P1", message: `Remeasurement was due ${c.nextMeasurementOn}.`, nextAction: "Start the run on the baseline instrument and record it.", waitingOn: "us", rank: 2 });
    else if (days <= 3) push({ code: "MEASUREMENT_DUE", severity: "P1", message: `Remeasurement due ${c.nextMeasurementOn}.`, nextAction: "Start the run on the baseline instrument.", waitingOn: "us", rank: 2 });
  } else if (c.stage === "active") {
    push({ code: "MEASUREMENT_DUE", severity: "P1", message: "No remeasurement is planned.", nextAction: "Plan the next measurement.", waitingOn: "us", rank: 2 });
  }

  if (c.renewalStatus === "due" || c.stage === "renewal_review") push({ code: "RENEWAL_REVIEW_DUE", severity: "P1", message: `Renewal review due; term ends ${c.endsOn}.`, nextAction: "Prepare baseline vs latest, work delivered, remaining opportunity.", waitingOn: "us", rank: 3 });
  const toEnd = daysBetweenIso(c.today, c.endsOn);
  if (toEnd >= 0 && toEnd <= ENGAGEMENT_ENDING_DAYS) push({ code: "ENGAGEMENT_ENDING", severity: "P1", message: `Term ends in ${toEnd} day(s).`, nextAction: c.renewalStatus === "renewed" ? "Confirm the new term's gates." : "Decide renew or offboard.", waitingOn: "us", rank: 3 });
  if (c.stage === "active" && c.portalGrants === 0) push({ code: "PORTAL_ACCESS_ISSUE", severity: "P2", message: "Active client has no portal viewer.", nextAction: "Invite the client, or note that email-only reporting was agreed.", waitingOn: "us", rank: 4 });

  for (const q of c.openQaIssues) {
    if (q.severity === "P1") push({ code: q.lane === "evidence" ? "EVIDENCE_QA_FAILURE" : "QA_ATTENTION", severity: "P1", message: q.message, nextAction: "Review and resolve or override with a reason.", waitingOn: "us", rank: 1 });
  }
  return alerts.sort((a, b) => a.rank - b.rank || severityRank(a.severity) - severityRank(b.severity));
}

function severityRank(s: QaSeverity): number {
  return s === "P0" ? 0 : s === "P1" ? 1 : 2;
}

export function waitingOnSummary(alerts: PortfolioAlert[]): WaitingOn {
  if (alerts.some((a) => a.waitingOn === "us" && a.rank <= 2)) return "us";
  if (alerts.some((a) => a.waitingOn === "client")) return "client";
  if (alerts.some((a) => a.waitingOn === "third_party")) return "third_party";
  if (alerts.some((a) => a.waitingOn === "us")) return "us";
  return null;
}

/** Where the client sits in MEASURE → DIAGNOSE → CHANGE → REMEASURE, and any
 * missing link. */
export interface LoopPosition {
  baseline: boolean;
  hypotheses: number;
  activeWork: number;
  implemented: number;
  nextMeasurementOn: string | null;
  latestResult: string | null;
  nextDecision: string;
  missing: string[];
}

export function loopPosition(i: {
  stage: EngagementStage;
  baseline: boolean;
  hypotheses: number;
  activeWork: number;
  implemented: number;
  nextMeasurementOn: string | null;
  latestResult: string | null;
  renewalStatus: RenewalStatus;
}): LoopPosition {
  const missing: string[] = [];
  if (i.stage === "active" || i.stage === "renewal_review") {
    if (!i.baseline) missing.push("baseline");
    if (i.hypotheses === 0) missing.push("hypotheses");
    if (i.activeWork === 0 && i.implemented === 0) missing.push("work");
    if (!i.nextMeasurementOn && !i.latestResult) missing.push("next measurement");
  }
  const nextDecision =
    i.stage === "renewal_review" || i.renewalStatus === "due"
      ? "renew or complete"
      : i.latestResult
        ? "act on the latest result"
        : i.nextMeasurementOn
          ? `remeasure on ${i.nextMeasurementOn}`
          : "plan the next measurement";
  return { ...i, nextDecision, missing };
}

// ---------------------------------------------------------- 8. offboarding

export interface OffboardingInput {
  stage: EngagementStage;
  agreementStatus: "active" | "reserved" | "terminated" | "none";
  portalGrants: number;
  plannedMeasurements: number;
  openTasks: number;
  accessGranted: number;
  cooldownUntil: string | null;
  prospectDoNotContact: boolean | null;
}

export function offboardingQa(i: OffboardingInput): QaIssue[] {
  const issues: QaIssue[] = [];
  if (i.stage !== "completed" && i.stage !== "churned") return issues;
  const add = (code: string, severity: QaSeverity, message: string) => issues.push({ lane: "offboarding", code, severity, message });
  if (i.agreementStatus === "active" || i.agreementStatus === "reserved") add("EXCLUSIVITY_NOT_RELEASED", "P0", "Closed engagement still holds its territory.");
  if (i.portalGrants > 0) add("PORTAL_GRANTS_OPEN", "P0", `${i.portalGrants} portal grant(s) still open after close.`);
  if (i.plannedMeasurements > 0) add("MEASUREMENTS_NOT_STOPPED", "P1", `${i.plannedMeasurements} planned measurement(s) still scheduled.`);
  if (i.openTasks > 0) add("WORK_UNHANDLED", "P1", `${i.openTasks} open work item(s) neither completed nor declined.`);
  if (i.accessGranted > 0) add("ACCESS_NOT_REVOKED", "P1", `${i.accessGranted} delegated access item(s) still marked granted.`);
  if (!i.cooldownUntil) add("COOLDOWN_MISSING", "P1", "No cold-prospecting cooldown recorded.");
  if (i.prospectDoNotContact === false) add("COOLDOWN_MISSING", "P1", "Former client's prospect is not flagged do-not-contact.");
  return issues;
}
