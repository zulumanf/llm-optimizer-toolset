/**
 * Named constants for the knowledge compilation layer (docs/11: no magic
 * numbers, no hardcoded semantic strings).
 *
 * Freshness windows are the ones a human would argue about, so they live in one
 * table with the reasoning attached rather than scattered through queries.
 * `docs/operations/knowledge-freshness-and-provenance.md` is the prose version.
 */

// ------------------------------------------------------------------ versions

/** Bumped when the compiler's output format changes; recorded on every page. */
export const KNOWLEDGE_COMPILER_VERSION = "wiki-compiler-v1";
/** Bumped when packet assembly changes what an agent is shown. */
export const CONTEXT_BUILDER_VERSION = "context-builder-v1";

// ------------------------------------------------------------------ ingestion

/** 50 MB. Larger sources exist, but not ones this single-box deployment should
 * hold in memory to hash and parse. */
export const SOURCE_MAX_BYTES = 50 * 1024 * 1024;
export const SOURCE_FETCH_TIMEOUT_MS = 30_000;
/** Ceiling for crawled HTML pages — pages, not documents, so far smaller
 * than SOURCE_MAX_BYTES. Stream-capped in lib/security/safe-fetch.ts. */
export const CRAWL_FETCH_MAX_BYTES = 3_000_000;
export const EXTRACTION_TIMEOUT_MS = 120_000;
/** Characters of extracted text kept per document. Beyond this the source stays
 * whole on disk and the excerpt spans point into it. */
export const EXTRACTED_TEXT_MAX_CHARS = 2_000_000;

// ----------------------------------------------------------------- freshness

export const FRESHNESS_STATES = [
  "current",
  "nearing_review",
  "stale",
  "expired",
  "superseded",
  "unknown",
] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** Ordered worst-last. A page's state is the worst among its dependencies. */
export const FRESHNESS_SEVERITY: Record<FreshnessState, number> = {
  current: 0,
  nearing_review: 1,
  superseded: 2,
  stale: 3,
  expired: 4,
  unknown: 5,
};

/**
 * Review windows in days, by claim category. Each entry is a judgement about
 * how fast that kind of fact decays in this domain — see the ops doc for why.
 */
export const REVIEW_WINDOW_DAYS: Record<string, number> = {
  affiliation: 90,
  team: 90,
  ranking: 365,
  award: 365,
  transaction: 0, // stable once verified; 0 means "does not decay"
  market_statistic: 90,
  inventory: 7,
  sales_volume: 180,
  general: 365,
};
export const DEFAULT_REVIEW_WINDOW_DAYS = 365;
/** Within this share of the window's end, a claim reads as `nearing_review`. */
export const NEARING_REVIEW_FRACTION = 0.2;

/** Categories whose claims are meaningless without an explicit "as of" date. */
export const CATEGORIES_REQUIRING_AS_OF = ["sales_volume", "market_statistic", "ranking"];

/** Categories that are time-bounded: valid for their period, then `expired`. */
export const TIME_BOUNDED_CATEGORIES = ["ranking", "award", "market_statistic"];

// --------------------------------------------------------------- materiality

export const MATERIALITY_LEVELS = ["ordinary", "material", "high_risk"] as const;
export type Materiality = (typeof MATERIALITY_LEVELS)[number];

/**
 * Categories that carry legal, contractual or reputational risk when
 * overstated. These require strong evidence, freshness validation,
 * contradiction checking and human approval
 * (docs/architecture/canonical-truth-vs-compiled-knowledge.md).
 */
export const HIGH_RISK_CATEGORIES = [
  "sales_volume",
  "ranking",
  "award",
  "affiliation",
  "team",
  "market_dominance",
  "licensing",
  "revenue",
  "transaction_attribution",
  "celebrity_client",
];

/** Words that turn an ordinary claim into a superlative one. */
export const SUPERLATIVE_MARKERS = [
  "best",
  "top",
  "leading",
  "#1",
  "number one",
  "largest",
  "most",
  "premier",
  "unrivaled",
  "unrivalled",
];

// ------------------------------------------------------------ token budgets

/** Rough characters-per-token for the local counter. See tokens.ts for why an
 * approximation is honest here and where the exact number comes from. */
export const CHARS_PER_TOKEN = 4;

export const DEFAULT_PACKET_TOKEN_BUDGET = 8_000;

/** Hot-file budgets. A "concise" file that silently grows is not concise. */
export const HOT_FILE_TOKEN_BUDGETS: Record<string, number> = {
  "client-summary": 1_200,
  "current-strategy": 800,
  "approved-claims": 1_500,
  "current-priorities": 600,
  "open-risks": 600,
  "recent-changes": 800,
  "active-actions": 600,
  "attribution-summary": 600,
  "integration-health": 400,
};

/**
 * Priority classes, lowest number = most important. The first five are the
 * never-truncate set: dropping any of them produces a packet that looks
 * complete while missing a restriction, which is worse than no packet at all.
 */
export const PACKET_PRIORITY = {
  taskObjective: 1,
  safetyInstruction: 2,
  approvedClaim: 3,
  requiredEvidence: 4,
  contradiction: 5,
  workflowState: 6,
  strategy: 7,
  historical: 8,
  optional: 9,
} as const;

export const NEVER_TRUNCATE_PRIORITY_MAX = 5;

/** Floors as a share of the budget, applied before optional material is added. */
export const PACKET_RESERVED_SHARE: Record<string, number> = {
  safetyInstruction: 0.15,
  approvedClaim: 0.3,
  requiredEvidence: 0.15,
  workflowState: 0.1,
};

/** How long a built packet stays valid for execution. Older packets remain
 * readable for audit; they are simply refused as inputs. */
export const PACKET_TTL_HOURS = 24;

// --------------------------------------------------------------- compilation

/** Pages compiled concurrently in one build. Bounded because each one runs
 * several queries and the box also serves the app. */
export const BUILD_CONCURRENCY = 4;
export const BUILD_MAX_ATTEMPTS = 3;

/** Days of canonical change summarised by the `recent-changes` hot file. */
export const RECENT_CHANGES_WINDOW_DAYS = 30;

// ---------------------------------------------------------------- normalizing

/** Query parameters stripped during URL normalization. */
export const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
];

/** Confidence bands for entity matching. Below `probable`, a human decides. */
export const MATCH_CONFIDENCE_EXACT = 1.0;
export const MATCH_CONFIDENCE_PROBABLE = 0.85;
export const MATCH_CONFIDENCE_AMBIGUOUS = 0.6;

// ------------------------------------------------- maintenance (spec 025)

/**
 * How long a page may sit stale before it becomes an exception. Being stale is
 * normal — a claim changed and the rebuild has not run yet. Being stale for a
 * working day means the rebuild is not happening, which is a different problem.
 */
export const STALE_PAGE_SLA_HOURS = 24;

/**
 * A page whose token count exceeds its budget by this factor is flagged. Not
 * an error: an oversized page still compiles and still serves. It is a signal
 * that a template is accreting, which is how a "concise" hot file stops being
 * one without anybody deciding it should.
 */
export const OVERSIZED_PAGE_FACTOR = 1.25;

/** A page never selected into a packet over this window is probably dead weight. */
export const UNUSED_PAGE_DAYS = 30;

/**
 * Claims whose only support is a single source. Not wrong — but a material
 * claim resting on one source is one retraction away from being unsupported.
 */
export const WEAK_EVIDENCE_MAX_SOURCES = 1;

/** Retrieval evaluation gate: below this recall of required facts, CI fails. */
export const RETRIEVAL_RECALL_FLOOR = 0.9;

/** And any forbidden item present at all is a hard failure, never a ratio. */
export const RETRIEVAL_FORBIDDEN_TOLERANCE = 0;
