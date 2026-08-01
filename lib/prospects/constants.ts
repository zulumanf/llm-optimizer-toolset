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
