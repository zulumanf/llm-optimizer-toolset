/**
 * Prospect acquisition domain constants (spec 032). Stage order and gates
 * are the source of truth for the pipeline; the DB check constraints only
 * vouch that values are known.
 */

export const LAUNCH_STATUSES = [
  "researching",
  "benchmarking",
  "outreach_ready",
  "outreach_active",
  "in_conversation",
  "partner_selected",
  "protected",
  "paused",
  "closed",
] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];

export const PROSPECT_TYPES = [
  "brokerage",
  "team",
  "individual_agent",
  "developer",
  "new_dev_marketing",
] as const;
export type ProspectType = (typeof PROSPECT_TYPES)[number];

export const PROSPECT_SOURCES = ["manual", "csv", "referral", "research"] as const;

export const PROVENANCE_LABELS = [
  "verified",
  "publicly_sourced",
  "estimated",
  "manual",
  "ai_inferred",
] as const;
export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];

export const AUTHORITY_SIGNAL_KINDS = [
  "transaction_volume",
  "transaction_count",
  "avg_deal_value",
  "notable_listing",
  "notable_sale",
  "years_in_market",
  "team_size",
  "ranking",
  "award",
  "press_mention",
  "specialization",
  "review_footprint",
  "market_report",
  "video_content",
  "speaking",
  "other",
] as const;
export type AuthoritySignalKind = (typeof AUTHORITY_SIGNAL_KINDS)[number];

/** Ordered pipeline. Index order defines "at or past" for the gates below. */
export const PROSPECT_STAGES = [
  "identified",
  "researching",
  "benchmarking",
  "qualified",
  "outreach_ready",
  "contacted",
  "replied",
  "audit_sent",
  "audit_viewed",
  "discovery_scheduled",
  "discovery_completed",
  "proposal_sent",
  "negotiation",
  "verbal_yes",
  "contracted",
] as const;

/** Terminal / parked stages sit outside the ordered ladder. */
export const PROSPECT_EXIT_STAGES = ["closed_lost", "waitlisted", "conflict_blocked"] as const;

export type ProspectStage =
  | (typeof PROSPECT_STAGES)[number]
  | (typeof PROSPECT_EXIT_STAGES)[number];

export const ALL_PROSPECT_STAGES: readonly ProspectStage[] = [
  ...PROSPECT_STAGES,
  ...PROSPECT_EXIT_STAGES,
];

/** Entering this stage or any later ladder stage requires a recorded,
 * non-blocking exclusivity check. */
export const CONFLICT_GATE_STAGE = "outreach_ready" satisfies ProspectStage;

/** Entering this stage or any later ladder stage means we contacted them —
 * forbidden for do-not-contact prospects. */
export const CONTACT_GATE_STAGE = "contacted" satisfies ProspectStage;

export const CONFLICT_STATUSES = [
  "unchecked",
  "clear",
  "possible",
  "partial",
  "direct",
  "blocked",
  "override",
] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/** Conflict statuses that satisfy the exclusivity gate. */
export const CONFLICT_STATUSES_ALLOWING_PROGRESS: readonly ConflictStatus[] = [
  "clear",
  "override",
];

export const RELATIONSHIP_STRENGTHS = ["none", "weak", "warm", "strong"] as const;

/**
 * Operator-recorded fixability facts (spec 039) — things the platform cannot
 * derive and must never guess. "unknown" is a recorded answer, distinct from
 * never-asked; unanswered items make the category read "not measured".
 */
export const ASSESSMENT_ITEMS = [
  // Website readiness (6)
  "website_indexable",
  "has_dedicated_website",
  "services_markets_clear",
  "credentials_visible",
  "neighborhood_content",
  "structured_data_consistent",
  // Ability to implement (4)
  "website_control",
  "content_publishing_access",
  "marketing_resources",
  "can_obtain_reviews",
  // Hard-flag input
  "reputation_concern",
] as const;
export type AssessmentItem = (typeof ASSESSMENT_ITEMS)[number];

export const ASSESSMENT_VALUES = ["yes", "no", "unknown"] as const;
export type AssessmentValue = (typeof ASSESSMENT_VALUES)[number];

/** Purchase intent/timing evidence (spec 042) — distinct from authority
 * signals (market standing). Every buying signal requires a source URL and
 * an observed date; the table enforces both NOT NULL. */
export const BUYING_SIGNAL_KINDS = [
  "brokerage_move",
  "team_expansion",
  "hiring_marketing",
  "website_redesign",
  "new_market_launch",
  "new_development_listings",
  "media_activity",
  "new_leadership",
  "paid_marketing_active",
  "seo_pr_investment",
  "other",
] as const;
export type BuyingSignalKind = (typeof BUYING_SIGNAL_KINDS)[number];

/**
 * Freshness windows per evidence type (spec 042). Within the window =
 * fresh; past it = stale (badged, and for benchmarks: publish requires an
 * explicit acknowledgment). Buying-signal scoring decays on these bands.
 */
export const FRESHNESS_WINDOWS_DAYS = {
  benchmark: 90,
  authoritySignal: 365,
  buyingSignal: 180,
  contact: 180,
  assessment: 365,
} as const;

export interface Staleness {
  ageDays: number;
  stale: boolean;
}

/** Pure staleness check; `now` injectable for tests. */
export function staleness(
  observedAt: Date | string,
  windowDays: number,
  now: Date = new Date()
): Staleness {
  const observed = typeof observedAt === "string" ? new Date(observedAt) : observedAt;
  const ageDays = Math.floor((now.getTime() - observed.getTime()) / 86_400_000);
  return { ageDays, stale: ageDays > windowDays };
}

export const FINDING_KINDS = [
  "authority_visibility_gap",
  "competitor_contrast",
  "absence",
  "citation_gap",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_SEVERITIES = ["low", "medium", "high"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const OUTREACH_CHANNELS = [
  "email",
  "linkedin_message",
  "followup_email",
  "warm_intro",
] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

/**
 * A contact's preferred way to be reached. Distinct from OUTREACH_CHANNELS
 * (draft channels): "phone" is a preference someone can state, but the
 * platform drafts no phone scripts, and "followup_email" is a draft kind,
 * not a preference. Mirrors the check constraint in migration 042.
 */
export const CONTACT_CHANNELS = [
  "email",
  "linkedin_message",
  "phone",
  "warm_intro",
] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const RECORDING_STATUSES = [
  "not_started",
  "script_ready",
  "recorded",
  "sent",
  "viewed",
  "replied",
  "meeting_booked",
] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const FINDING_GENERATOR_VERSION = "prospect-findings-v1+deterministic";
export const RECORDING_GENERATOR_VERSION = "recording-plan-v1+deterministic";
export const OUTREACH_TEMPLATE_VERSION = "reply-first-email-v1";

/**
 * Wording the platform refuses to approve in prospect-facing text (spec 032,
 * target §6/§23): revenue-loss and causality claims we cannot evidence, and
 * hype language the outreach guidelines prohibit. Matched case-insensitively.
 */
export const PROHIBITED_PHRASES = [
  "lost revenue",
  "losing revenue",
  "revenue you're losing",
  "costing you",
  "cost you",
  "missed commissions",
  "losing deals",
  "lost deals",
  "guaranteed",
  "revolutionary",
  "cutting-edge",
  "because of this, you",
] as const;

/** First prohibited phrase found in the text, or null. */
export function findProhibitedPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of PROHIBITED_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

/** Minimum responses in a run before absence/contrast findings are offered —
 * one response is an anecdote, not a pattern (target §23). */
export const MIN_RESPONSES_FOR_FINDINGS = 5;

export const AUDIT_TOKEN_BYTES = 32;

/** Audit links die on their own (plan 3.4): 45 days covers a slow reply
 * cycle, and an operator can pass an explicit expiresAt to extend. Immortal
 * links require deliberately unsetting — which the UI does not offer. */
export const AUDIT_LINK_DEFAULT_EXPIRY_DAYS = 45;

/**
 * Commission rate for the audit page's dollar-stake ESTIMATE (PR B, P5a).
 * Labeled as an estimate on the page; configurable per deploy. The frame is
 * arithmetic on the prospect's own sourced numbers — never a loss claim
 * (PROHIBITED_PHRASES discipline).
 */
const rateFromEnv = Number(process.env.COMMISSION_RATE_ESTIMATE);
export const COMMISSION_RATE_ESTIMATE =
  Number.isFinite(rateFromEnv) && rateFromEnv > 0 && rateFromEnv < 0.2
    ? rateFromEnv
    : 0.025;

/**
 * A team is "visibly recommended" in a benchmark when it appears in at least
 * this many answers: 20% of the sample, floored at 5 so tiny samples cannot
 * qualify. Shared by the audit template (hero variant selection) and the
 * publish-time warnings (already-visible prospect ⇒ weak pitch).
 */
export function visibilityThreshold(responseCount: number): number {
  return Math.max(5, 0.2 * responseCount);
}

/** Sender identity for the audit footer (PR B, P5e) — env-configured so
 * the template never hardcodes a person. Absent values render nothing.
 * The OUTBOUND sender of record is outreach_sender_identity (spec 052);
 * these remain page-display credibility fields only. */
export const SENDER_COMPANY = process.env.SENDER_COMPANY ?? null;
export const SENDER_CREDENTIAL = process.env.SENDER_CREDENTIAL ?? null;

// Re-contact guards (spec 052). Per-prospect DNC alone let the same human
// be contacted under two prospects, and three teams in one brokerage in
// one week. Windows are deliberate constants, not config — changing them
// is a policy decision that belongs in a diff.
export const RECONTACT_PERSON_WINDOW_DAYS = 30;
export const BROKERAGE_SEND_CAP_30D = 3;
