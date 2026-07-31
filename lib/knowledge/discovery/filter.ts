/**
 * Candidate filtering for external source discovery (spec 027).
 *
 * Pure functions: no I/O, no database, fully unit-tested. The service decides
 * *when* to call these; this module decides *whether a URL earns a fetch*.
 *
 * Every rejection carries a reason. "We searched and found nothing" and "we
 * found eleven pages and could not fetch nine of them" are different outcomes,
 * and a summary that renders them identically is the undisclosed-partial-sample
 * failure this platform exists to prevent.
 */
import { normalizeUrl, normalizeDomain } from "@/lib/knowledge/normalize";
import { urlDomain } from "@/lib/parsing/prepass";
import { isPrivateHost } from "@/lib/knowledge/sources/ingest";

export const SKIP_REASONS = [
  "own_domain",
  "duplicate_in_run",
  "already_ingested",
  "private_host",
  "unsupported_scheme",
  "unattributable_source",
  "robots_disallowed",
  "fetch_failed",
  "empty_extraction",
  "cap_reached",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Human wording for a summary. Kept beside the enum so they cannot drift. */
export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  own_domain: "the client's own site, already crawled",
  duplicate_in_run: "the same page surfaced by an earlier query",
  already_ingested: "already held from a previous run",
  private_host: "resolves to a private or internal address",
  unsupported_scheme: "not an http(s) page",
  unattributable_source: "hosted on storage with no identifiable publisher",
  robots_disallowed: "robots.txt disallows fetching it",
  fetch_failed: "could not be fetched",
  empty_extraction: "fetched but yielded no usable text",
  cap_reached: "beyond this run's page cap",
};

export interface RawCandidate {
  url: string;
  title: string | null;
  /** The query text that surfaced it. */
  sourceQuery: string;
}

export interface ScreenedCandidate extends RawCandidate {
  normalizedUrl: string;
  domain: string;
}

export type ScreenResult =
  | { keep: true; candidate: ScreenedCandidate }
  | { keep: false; candidate: ScreenedCandidate; reason: SkipReason };

export interface ScreenContext {
  /** The client's own domain — discover.ts already crawls it. */
  ownDomain?: string;
  /** Normalized URLs already held for this client, from previous runs. */
  alreadyIngested: ReadonlySet<string>;
  /** Normalized URLs kept so far in this run. Mutated by `screenAll`. */
  seenInRun: Set<string>;
  /** Maximum pages this run may ingest. */
  maxPages: number;
  /** How many have been kept already. */
  keptSoFar: number;
}

/**
 * Screen one candidate.
 *
 * Order matters and is deliberate: the cheapest, most certain rejections run
 * first, so a page dropped for being the client's own site is never also
 * reported as a robots failure. The first true reason is the reason.
 */
export function screenCandidate(raw: RawCandidate, ctx: ScreenContext): ScreenResult {
  const normalizedUrl = normalizeUrl(raw.url);
  const domain = urlDomain(normalizedUrl) ?? "";
  const candidate: ScreenedCandidate = { ...raw, normalizedUrl, domain };

  let scheme = "";
  try {
    scheme = new URL(normalizedUrl).protocol;
  } catch {
    return { keep: false, candidate, reason: "unsupported_scheme" };
  }
  if (scheme !== "http:" && scheme !== "https:") {
    return { keep: false, candidate, reason: "unsupported_scheme" };
  }

  if (domain.length === 0) {
    return { keep: false, candidate, reason: "unsupported_scheme" };
  }

  // SSRF guard. Reused from ingestSource rather than reimplemented, so the two
  // paths cannot disagree about what counts as internal.
  if (isPrivateHost(domain)) {
    return { keep: false, candidate, reason: "private_host" };
  }

  if (ctx.ownDomain && domainsMatch(domain, ctx.ownDomain)) {
    return { keep: false, candidate, reason: "own_domain" };
  }

  // Checked before the fetch: a page we could never attribute is not worth
  // spending a request, an extraction and an agent call on.
  if (!isAttributableSource(domain)) {
    return { keep: false, candidate, reason: "unattributable_source" };
  }

  if (ctx.seenInRun.has(normalizedUrl)) {
    return { keep: false, candidate, reason: "duplicate_in_run" };
  }

  if (ctx.alreadyIngested.has(normalizedUrl)) {
    return { keep: false, candidate, reason: "already_ingested" };
  }

  // Checked last among the deterministic rules: a page rejected for being a
  // duplicate should say so rather than blaming an arbitrary cap.
  if (ctx.keptSoFar >= ctx.maxPages) {
    return { keep: false, candidate, reason: "cap_reached" };
  }

  return { keep: true, candidate };
}

/** Screen a list, threading the run-local dedupe set and the kept counter. */
export function screenAll(raws: RawCandidate[], ctx: ScreenContext): ScreenResult[] {
  const results: ScreenResult[] = [];
  let kept = ctx.keptSoFar;
  for (const raw of raws) {
    const result = screenCandidate(raw, { ...ctx, keptSoFar: kept });
    if (result.keep) {
      kept += 1;
      ctx.seenInRun.add(result.candidate.normalizedUrl);
    }
    results.push(result);
  }
  return results;
}

/**
 * Whether two hostnames are the same site.
 *
 * `normalizeDomain` already strips `www.`, so this also treats a subdomain as
 * the client's own site — `blog.example.com` belongs to the owner of
 * `example.com`, and re-ingesting it under discovery would duplicate what the
 * site crawler is responsible for.
 */
export function domainsMatch(candidate: string, own: string): boolean {
  const a = normalizeDomain(candidate);
  const b = normalizeDomain(own);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Hosts that serve bytes but have no editorial identity.
 *
 * Added after the first live run (2026-07-30) captured two PDFs from S3
 * buckets — one an SEO vendor's artifact, one an unrelated press-release dump —
 * and proposed 38 claims from them, all rejected by hand.
 *
 * The rule is not "these sites are low quality". It is that **attribution to
 * them is meaningless**: `attributionPrefix` yields "s3.amazonaws.com reports
 * that", which names a filesystem rather than a publisher. A claim whose
 * strongest provenance is a bucket path cannot be defended to a client, so the
 * page is not worth the fetch.
 *
 * A legitimate press release hosted on S3 is lost by this rule. That is the
 * accepted cost: the publisher's own page is the source we want, and if only
 * the bucket copy exists, nobody can attribute the statement anyway.
 */
const UNATTRIBUTABLE_HOST_PATTERNS = [
  /(^|\.)s3[.-][a-z0-9-]*\.?amazonaws\.com$/,
  /(^|\.)s3\.amazonaws\.com$/,
  /(^|\.)blob\.core\.windows\.net$/,
  /(^|\.)storage\.googleapis\.com$/,
  /(^|\.)r2\.cloudflarestorage\.com$/,
  /(^|\.)digitaloceanspaces\.com$/,
  /(^|\.)backblazeb2\.com$/,
  // Link shorteners: the destination is the source, and we cannot see it here.
  /^(bit\.ly|t\.co|tinyurl\.com|lnkd\.in|goo\.gl|ow\.ly)$/,
  // Generic file/document hosts with no editorial control.
  /^(drive\.google\.com|docs\.google\.com|dropbox\.com|www\.dropbox\.com)$/,
  /^(scribd\.com|www\.scribd\.com|slideshare\.net|www\.slideshare\.net)$/,
];

/** Whether a claim sourced here could name a publisher a client would recognise. */
export function isAttributableSource(domain: string): boolean {
  const host = domain.toLowerCase();
  return !UNATTRIBUTABLE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Whether a claim proposed from this source must be phrased as attribution.
 *
 * A press article is evidence that a publication *stated* something — never
 * that it is true. Only the client's own domain yields unattributed claims,
 * because only there is the client the speaker. This is the system-of-record
 * rule (docs/architecture/build-vs-borrow-boundaries.md) applied to journalism.
 */
export function requiresAttribution(domain: string, ownDomain?: string): boolean {
  if (!ownDomain) return true;
  return !domainsMatch(domain, ownDomain);
}

/**
 * The wording prefix for an attributed claim.
 *
 * Returns the publisher's registrable domain rather than a guessed brand name:
 * we know which host served the bytes, and we do not know what it calls itself.
 * Inventing "Jersey Digs" from `jerseydigs.com` would be a fact nobody
 * verified.
 */
export function attributionPrefix(domain: string): string {
  return `${normalizeDomain(domain)} reports that`;
}
