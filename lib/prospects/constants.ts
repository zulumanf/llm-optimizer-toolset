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

/** Evidence classification (migrations 074/085): who stands behind a fact.
 * 'sponsored' marks paid placement (e.g. sponsored publication coverage) —
 * kept and shown, but discounted by the authority score and badged
 * distinctly from independent reporting on the audit page. */
export const SIGNAL_SOURCE_TYPES = [
  "independent",
  "self_reported",
  "derived",
  "sponsored",
] as const;
export type SignalSourceTypeLabel = (typeof SIGNAL_SOURCE_TYPES)[number];

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

/** Stages in which an UNATTENDED (worker-dispatched) send must refuse: a
 * reply or exit was recorded and no queued draft may transmit past it
 * (spec 099). Human-initiated sends are not gated on this — the ladder
 * legitimately sends the audit after a reply. */
export const UNATTENDED_SEND_BLOCKED_STAGES = [
  "replied",
  "discovery_scheduled",
  "discovery_completed",
  "proposal_sent",
  "negotiation",
  "verbal_yes",
  "contracted",
  ...PROSPECT_EXIT_STAGES,
] as const;

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

/** Stages before any outreach — an allowed send advances these to
 * CONTACT_GATE_STAGE automatically (spec 098). */
export const PRE_CONTACT_STAGES = [
  "identified",
  "researching",
  "benchmarking",
  "qualified",
  "outreach_ready",
] as const satisfies readonly ProspectStage[];

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

/** Page-weight bound on the audit's verbatim appendix (launch fix
 * 2026-08-14). Sized so any realistic benchmark run fits whole — the page
 * claims "every answer is published" ONLY when the snapshot actually holds
 * every qualifying capture; past the cap it states shown-of-total instead
 * (snapshot.transcriptTotal). Never a silent truncation. */
export const AUDIT_TRANSCRIPT_CAP = 400;

/** Today as YYYY-MM-DD (UTC) — the ledger/date-column idiom, previously
 * hand-rolled at four call sites (simplify pass 2026-08-14). */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

// v2 (spec 094): no asserted rank→visibility benchmark, no "the team" for
// individuals, counts as the primary unit (no rounded-up sub-10% rates).
export const FINDING_GENERATOR_VERSION = "prospect-findings-v2+deterministic";
export const RECORDING_GENERATOR_VERSION = "recording-plan-v1+deterministic";
export const OUTREACH_TEMPLATE_VERSION = "reply-first-email-v1";
// Spec 124: the competitive-mismatch template. The version string IS the
// template identity persisted on drafts (prompt_version) — bump it with any
// copy change so analytics attribution survives edits.
export const MISMATCH_TEMPLATE_VERSION = "competitive_mismatch_reply_v1";

/** Prospect-readable labels per template version for analytics groupings. */
/** Spec 127: follow-up touches over the frozen Touch 1 evidence. */
// v2 (2026-09-04): reply-only copy, agent/team wording, no report claim
// without a finished report, distinct-question count, no em/en dashes.
export const FOLLOWUP_TEMPLATE_VERSIONS = {
  t2NoEngagement: "competitive_mismatch_t2_no_engagement_v2",
  t2Engaged: "competitive_mismatch_t2_engaged_v2",
  t3Engaged: "competitive_mismatch_t3_engaged_v2",
  t3NoEngagement: "competitive_mismatch_t3_no_engagement_v2",
} as const;
export type FollowupTemplateVersion =
  (typeof FOLLOWUP_TEMPLATE_VERSIONS)[keyof typeof FOLLOWUP_TEMPLATE_VERSIONS];
export const FOLLOWUP_TEMPLATE_VERSION_LIST: readonly string[] = Object.values(FOLLOWUP_TEMPLATE_VERSIONS);
export const FOLLOWUP_EXPERIMENT_ID = "competitive_mismatch_bootstrap_test_001";
/** Business days from the previous touch's actual send to the next touch. */
export const FOLLOWUP_CADENCE_BUSINESS_DAYS = { 2: 3, 3: 4 } as const;
export const FOLLOWUP_MAX_TOUCHES = 3;
/** Recipient-local morning window: 09:00 + [3, 88] min → 09:03–10:28. */
export const FOLLOWUP_SEND_WINDOW = { startHour: 9, minOffsetMinutes: 3, maxOffsetMinutes: 88 } as const;
/** Branch is rendered no earlier than this before its slot. */
export const FOLLOWUP_RENDER_LEAD_MINUTES = 30;
/** Preflight refuses when the Gmail reply sync is older than this. */
export const FOLLOWUP_REPLY_SYNC_MAX_AGE_MINUTES = 90;
export const FOLLOWUP_SEVERAL_QUESTIONS_MIN = 3;
export const FOLLOWUP_OOO_PAUSE_DAYS = 7;
/** A cold sequence never sends past this many calendar days after the
 * successful Touch 1: cap deferrals, holidays or OOO pauses must not
 * produce a follow-up weeks later. After it: complete, no reply. */
export const FOLLOWUP_MAX_SEQUENCE_AGE_DAYS = 21;
/** Touch 3 (engaged) may add one frozen-evidence category line only when
 * the competitor has at least this many recommendations in the category and
 * the category holds more than this share of the recommendation gap. */
export const FOLLOWUP_CATEGORY_LINE = { minCompetitor: 3, minGapShare: 0.5 } as const;
/** Touch 2/3 bodies (before the signature) stay short: a note, not a newsletter. */
export const FOLLOWUP_MAX_BODY_WORDS = 120;
export const FOLLOWUP_MEANINGFUL_OPEN_GAP_MINUTES = 10;
/** Mail-provider scanners fetch pixels/links within this window of a send. */
export const MAIL_SCANNER_WINDOW_SECONDS = 600;
export const REPLY_SYNC_LOOKBACK_DAYS = 30;

export const OUTREACH_TEMPLATE_LABELS: Record<string, string> = {
  [OUTREACH_TEMPLATE_VERSION]: "Reply-first audit email",
  [MISMATCH_TEMPLATE_VERSION]: "Competitive mismatch",
  [FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement]: "Mismatch T2 · no engagement",
  [FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged]: "Mismatch T2 · engaged",
  [FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged]: "Mismatch T3 · engaged",
  [FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement]: "Mismatch T3 · no engagement",
};

/**
 * Competitive-mismatch eligibility thresholds (spec 124). Policy constants,
 * not env config — the comparison must never be quietly weakened to make
 * the template fire; loosening any of these is a reviewed diff.
 */
export const MISMATCH_THRESHOLDS = {
  /** Competitor OpenAI recommendations must exceed the prospect's by ≥ this. */
  minRecommendationGap: 2,
  /** Competitor production must be ≤ this fraction of the prospect's. */
  maxCompetitorProductionRatio: 0.9,
  /** Hard maximum benchmark age for the template to fire at all. */
  maxBenchmarkAgeDays: 14,
} as const;

/** Reply classifications (spec 124) — mirrors the prospect_replies CHECK. */
export const REPLY_CLASSIFICATIONS = [
  "positive_interest",
  "question",
  "objection",
  "proof_request",
  "referral",
  "not_interested",
  "unsubscribe",
  "out_of_office",
  "unclear",
] as const;
export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number];

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
/** Per MARKET (launch) since spec 120 — the office-intrusion risk the cap
 * guards against is local; a national brand's teams in different metros
 * share only the name. Matching is on the normalized brokerage name. */
export const BROKERAGE_SEND_CAP_30D = 3;

/** Brokerage-name normalization (spec 120): naming variants must land in
 * the same cap bucket. Cut everything from the first comma, then a trailing
 * corporate-suffix token. The SAME patterns run in SQL (regexp_replace) and
 * in TS so the two sides can never disagree. */
export const BROKERAGE_CUT_COMMA = ",.*$";
export const BROKERAGE_CUT_SUFFIX = "\\s+(inc|llc)\\.?$";
export function normalizeBrokerage(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(new RegExp(BROKERAGE_CUT_COMMA), "")
    .replace(new RegExp(BROKERAGE_CUT_SUFFIX), "")
    .trim();
}

// Gmail transmission (spec 091). The cap is ours, far below Gmail's own
// limits — a warming sender address, and a policy constant like the ones
// above: raising it is a diff, not a config edit.
export const GMAIL_DAILY_SEND_CAP = 25;

/** The PUBLIC website shown in the outgoing signature/footer. Outbound
 * email must never show the app subdomain — the operator console is not
 * the company's public face (cohort 001 pre-send directive, 2026-08-31). */
export const OUTREACH_PUBLIC_WEBSITE = "www.RecommendedFirst.com";
export const OUTREACH_FORBIDDEN_FOOTER_HOST = "app.recommendedfirst.com";

/** SQL regex (case-insensitive) that counts as "the body contains a link" —
 * the Arm A / Arm B discriminator (spec 122). Matches scheme'd URLs and the
 * naked branded domain some drafts use. */
export const OUTREACH_LINK_PATTERN = "(https?://|recommendedfirst\\.com)";
/** The operator's daily send commitment (spec 119) — the input scoreboard
 * target, deliberately under the transport cap so follow-ups never compete
 * with the quota for headroom. A policy constant like the cap above. */
export const DAILY_SEND_QUOTA = 15;
/** How far ahead a human may schedule an approved draft's transmission. */
export const SCHEDULED_SEND_MAX_DAYS_AHEAD = 30;
/** Transport-failure retries before a scheduled send parks as blocked. */
export const SCHEDULED_SEND_MAX_ATTEMPTS = 3;
/** A claim older than this with no recorded outcome means the worker died
 * mid-dispatch. Such a draft is never auto-retried — the mail may have
 * left — it parks for a human to verify in the Gmail Sent folder. */
export const SCHEDULED_SEND_STALE_CLAIM_MINUTES = 15;
