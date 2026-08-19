/**
 * Technical discoverability engine (spec 088) — shared constants and
 * versions. One engine, small deterministic checks; every derived artifact
 * is stamped so historical scans stay reproducible.
 */

export const SCAN_VERSION = "technical-scan-v1";
export const PAGE_CLASSIFIER_VERSION = "page-classifier-v1";
export const SCHEMA_CHECK_VERSION = "schema-check-v1";
export const FRESHNESS_VERSION = "freshness-v1";
export const SITE_PRIORITY_VERSION = "site-priority-v1";

/**
 * Crawlers whose access we evaluate against robots.txt. Names are matched
 * case-insensitively against User-agent tokens. Policy here is a signal
 * about ACCESS, never a claim about recommendation visibility.
 */
export const AI_CRAWLERS = [
  "Googlebot",
  "GPTBot",
  "OAI-SearchBot",
  "ClaudeBot",
  "PerplexityBot",
] as const;

/** Scan safety caps. */
export const DEFAULT_SCAN_PAGES = 25;
export const MAX_SCAN_PAGES = 50;
export const MAX_SITEMAP_DOCS = 5;
export const MAX_SITEMAP_URLS = 500;
export const PAGE_FETCH_TIMEOUT_MS = 10_000;
export const PAGE_FETCH_MAX_BYTES = 2_000_000;
export const ROBOTS_FETCH_TIMEOUT_MS = 8_000;
export const ROBOTS_FETCH_MAX_BYTES = 262_144;
export const MAX_OUTLINKS_PER_PAGE = 200;
export const MAX_JSONLD_BLOCKS = 10;

/** Real-estate page kinds (page-classifier-v1). */
export const PAGE_KINDS = [
  "homepage",
  "team",
  "agent",
  "market",
  "neighborhood",
  "building",
  "property_type",
  "transaction",
  "case_study",
  "press",
  "authority",
  "blog",
  "contact",
  "generic",
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Kinds that carry the client's authority case — the pages whose
 * discoverability and connectivity the engine exists to protect. */
export const AUTHORITY_KINDS: ReadonlySet<PageKind> = new Set([
  "team",
  "agent",
  "market",
  "neighborhood",
  "building",
  "transaction",
  "case_study",
  "press",
  "authority",
]);

/** A page must score at least this (scoreUrlForAudit) to drive high-severity
 * findings — mirrors the onboarding crawler's MIN_SCORE. */
export const IMPORTANT_PAGE_SCORE = 65;
