/**
 * Site discovery (spec 021 follow-up).
 *
 * `ingestSource` could always fetch a URL you handed it. What the platform
 * could not do was work out *which* URLs exist — so onboarding a client meant
 * an operator manually finding their team page, their developments page, their
 * about page, and pasting each one in. For JC Luxury Group that gap was
 * measurable: 0 source artifacts ingested, while the two pages carrying the
 * roster and the project list were found by hand outside the tool.
 *
 * Discovery is deliberately conservative:
 *
 * - **`sitemap.xml` first, crawl second.** A sitemap is the site telling us
 *   what it considers a page. Crawling is the fallback for sites without one.
 * - **Same host only.** Following off-site links turns a client audit into a
 *   crawl of the open web.
 * - **Bounded.** Page and depth caps, and a delay between requests. This
 *   fetches a prospect's website; being rude to it is both wrong and a good way
 *   to get blocked mid-audit.
 * - **Ranked, not exhaustive.** Pages are scored by how likely they are to
 *   carry the facts a visibility audit needs — roster, projects, about,
 *   locations — so an operator ingesting the top 20 gets the useful ones.
 *
 * This does not evaluate JavaScript. A site that renders its roster client-side
 * yields a thin page and says so, rather than pretending the page is empty.
 */
import { z } from "zod";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { log } from "@/lib/logger";
import { normalizeUrl } from "@/lib/knowledge/normalize";
import {
  CRAWL_FETCH_MAX_BYTES,
  SOURCE_FETCH_TIMEOUT_MS,
} from "@/lib/knowledge/constants";
import { safeFetch } from "@/lib/security/safe-fetch";
import { extractLinks, extractTitle, visibleText } from "@/lib/html";

/**
 * How we identify ourselves. Named after the platform, not after whichever
 * site is being crawled — an earlier version interpolated the target domain,
 * which would have told every webmaster their own site was crawling them.
 */
export const CRAWLER_USER_AGENT =
  "AvosVisibilityAudit/1.0 (internal AI-visibility audit; contact the operator who scheduled it)";

/**
 * Politeness gap between requests to the same host.
 *
 * Raised from 400ms after a 150-page crawl of a real client site earned eight
 * `429 Too Many Requests` — losing pages, and being rude to a prospect whose
 * goodwill we are trying to earn. A visibility audit is never so urgent that it
 * justifies hammering the site it is auditing.
 */
const CRAWL_DELAY_MS = 1_200;

/** How much to slow down after a 429, and the ceiling on that. */
const BACKOFF_MULTIPLIER = 2;
const MAX_CRAWL_DELAY_MS = 10_000;
/** Attempts for a single URL that returns 429. */
const RATE_LIMIT_RETRIES = 2;
const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MAX_DEPTH = 2;

/**
 * Path fragments that usually carry the facts an audit needs, with a weight.
 * Ordering the queue by these means a capped crawl spends its budget on the
 * roster rather than on the 400th listing detail page.
 */
const VALUABLE_PATTERNS: { pattern: RegExp; weight: number; kind: string }[] = [
  { pattern: /\/(team|agents?|our-team|people|staff)(\/|$)/i, weight: 100, kind: "roster" },
  { pattern: /\/(developments?|projects?|portfolio|buildings?)(\/|$)/i, weight: 90, kind: "projects" },
  { pattern: /\/(about|about-us|our-story|who-we-are)(\/|$)/i, weight: 85, kind: "about" },
  { pattern: /\/(neighborhoods?|neighbourhoods?|areas?|communities|locations?)(\/|$)/i, weight: 75, kind: "markets" },
  { pattern: /\/(services?|what-we-do|expertise|specialt)/i, weight: 70, kind: "services" },
  { pattern: /\/(press|news|media|awards?|recognition)(\/|$)/i, weight: 65, kind: "press" },
  { pattern: /\/(testimonials?|reviews?|clients?)(\/|$)/i, weight: 55, kind: "social_proof" },
  { pattern: /\/(blog|insights?|guides?|resources?)(\/|$)/i, weight: 40, kind: "content" },
  { pattern: /\/(contact|office)(\/|$)/i, weight: 35, kind: "contact" },
];

/** Never worth ingesting: legal boilerplate, feeds, endless listing detail. */
const SKIP_PATTERNS = [
  /\/(privacy|terms|cookie|dmca|accessibility|sitemap)/i,
  /\/(login|signin|register|account|cart|checkout)/i,
  /\/(wp-admin|wp-json|feed|rss|\.xml$|\.json$)/i,
  /\/(listings?|properties|homes-for-sale|idx)\/[^/]+\/[^/]+/i,
  /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|css|js)$/i,
  /\/(page|p)\/\d+$/i,
  /[?&](utm_|fbclid|gclid)/i,
];

/**
 * Unrendered template syntax that leaked into the served HTML.
 *
 * Site builders that template client-side emit hrefs like
 * `/agents/{{slug}}` or `/agents/${makeLnk(i)}` when a loop does not run.
 * They are always 404s, and because they sit under a high-value path they
 * otherwise sort to the very top and eat the entire page budget — which is
 * exactly what happened on the first real crawl: nine placeholder URLs
 * outranked the actual team page.
 *
 * Matched on the raw and percent-encoded forms, since the encoding depends on
 * whether the link came from a sitemap or from parsed HTML.
 */
const TEMPLATE_PLACEHOLDER = /(\{\{|\}\}|\$\{|%7B%7B|%7D%7D|\$%7B|\[\[)/i;

export interface DiscoveredPage {
  url: string;
  /** Why it was ranked where it was: roster, projects, about… */
  kind: string;
  score: number;
  title: string | null;
  depth: number;
  source: "sitemap" | "crawl";
  /** Characters of visible text. Low values usually mean JS-rendered. */
  textLength: number;
  /** Set when the page could not be fetched — stated, not silently dropped. */
  error?: string;
}

export interface DiscoveryResult {
  domain: string;
  pages: DiscoveredPage[];
  sitemapFound: boolean;
  pagesFetched: number;
  /** Pages seen but not fetched because a cap was hit. Never silent. */
  truncated: number;
  notes: string[];
}

/** Exported for tests: how valuable a URL looks to a visibility audit. */
export function scoreUrlForAudit(url: string): { score: number; kind: string } {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  for (const { pattern, weight, kind } of VALUABLE_PATTERNS) {
    if (pattern.test(path)) return { score: weight, kind };
  }
  // The homepage always matters; anything else unmatched is background.
  if (path === "/" || path === "") return { score: 95, kind: "homepage" };
  return { score: 10, kind: "other" };
}

export function shouldSkipUrl(url: string): boolean {
  if (TEMPLATE_PLACEHOLDER.test(url)) return true;
  return SKIP_PATTERNS.some((pattern) => pattern.test(url));
}

async function fetchText(
  url: string
): Promise<{ html: string; status: number; retryAfterMs: number | null }> {
  // Central outbound policy (lib/security/safe-fetch.ts): private hosts and
  // private redirect targets refused, page size capped while streaming.
  const response = await safeFetch(url, {
    timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
    maxBytes: CRAWL_FETCH_MAX_BYTES,
    headers: {
      // Identify honestly and consistently. A webmaster seeing this in their
      // logs should be able to tell who fetched their pages and why — and it
      // must name US, not the site being fetched.
      "user-agent": CRAWLER_USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
  });
  const html = response.ok ? response.bytes.toString("utf8") : "";
  // Honour the server's own instruction when it gives one; a Retry-After is
  // the host telling us exactly how to behave, and ignoring it is a choice.
  const header = response.headers.get("retry-after");
  const retryAfterMs = header
    ? Number.isFinite(Number(header))
      ? Number(header) * 1000
      : Math.max(0, new Date(header).getTime() - Date.now())
    : null;
  return { html, status: response.status, retryAfterMs };
}

/**
 * Fetch, honouring 429 by waiting and retrying, and permanently slowing the
 * crawl afterwards. Returns the delay the caller should now use between
 * requests, so one rate-limited page makes the whole crawl gentler rather than
 * the same wall being hit repeatedly.
 */
async function fetchPolitely(
  url: string,
  currentDelayMs: number
): Promise<{ html: string; status: number; delayMs: number }> {
  let delayMs = currentDelayMs;

  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
    const { html, status, retryAfterMs } = await fetchText(url);
    if (status !== 429) return { html, status, delayMs };

    // Slow the rest of the crawl, not just this retry.
    delayMs = Math.min(delayMs * BACKOFF_MULTIPLIER, MAX_CRAWL_DELAY_MS);
    if (attempt === RATE_LIMIT_RETRIES) {
      log("warn", "knowledge.crawl_rate_limited", { url, delayMs });
      return { html: "", status, delayMs };
    }
    const wait = retryAfterMs ?? delayMs;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return { html: "", status: 429, delayMs };
}

/** Same-host outlinks (lib/html), canonicalized and deduped for the queue. */
function crawlLinks(html: string, baseUrl: string, host: string): string[] {
  return [
    ...new Set(
      extractLinks(html, baseUrl, { host }).map((url) => normalizeUrl(url))
    ),
  ];
}

async function readSitemap(origin: string): Promise<string[]> {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const urls = new Set<string>();

  for (const candidate of candidates) {
    try {
      const { html, status } = await fetchText(candidate);
      if (status !== 200 || !html.includes("<loc>")) continue;

      const locs = [...html.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]!.trim());
      // A sitemap index points at more sitemaps; follow one level, not a tree.
      const nested = locs.filter((loc) => /sitemap.*\.xml$/i.test(loc)).slice(0, 5);
      for (const loc of locs.filter((l) => !/sitemap.*\.xml$/i.test(l))) urls.add(loc);

      for (const child of nested) {
        const inner = await fetchText(child);
        for (const match of inner.html.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
          urls.add(match[1]!.trim());
        }
      }
      if (urls.size > 0) break;
    } catch {
      // No sitemap is normal; the crawl fallback handles it.
    }
  }
  return [...urls];
}

const discoverSchema = z.object({
  domain: z.string().trim().min(3).max(255),
  maxPages: z.number().int().min(1).max(200).default(DEFAULT_MAX_PAGES),
  maxDepth: z.number().int().min(0).max(4).default(DEFAULT_MAX_DEPTH),
});

/**
 * Discover a client's pages, ranked by how likely they are to carry audit-worthy
 * facts. Fetches nothing beyond the caps and reports what it skipped.
 */
export async function discoverSite(raw: unknown): Promise<ActionResult<DiscoveryResult>> {
  const parsed = discoverSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A domain is required."));
  }
  const { maxPages, maxDepth } = parsed.data;

  let origin: string;
  let host: string;
  try {
    const url = new URL(
      parsed.data.domain.startsWith("http")
        ? parsed.data.domain
        : `https://${parsed.data.domain}`
    );
    origin = url.origin;
    host = url.host;
  } catch {
    return fail(new ClassifiedError("validation", "That domain could not be parsed."));
  }

  const notes: string[] = [];
  const seen = new Set<string>();
  const results: DiscoveredPage[] = [];

  // Queue of {url, depth, source}. Sitemap entries enter at depth 0 because the
  // site itself vouched for them.
  const sitemapUrls = await readSitemap(origin);
  const sitemapFound = sitemapUrls.length > 0;
  if (sitemapFound) {
    notes.push(`sitemap.xml listed ${sitemapUrls.length} URLs`);
  } else {
    notes.push("No sitemap.xml found — crawled from the homepage instead.");
  }

  const skippedPlaceholders = sitemapUrls.filter((u) => TEMPLATE_PLACEHOLDER.test(u)).length;
  if (skippedPlaceholders > 0) {
    notes.push(
      `${skippedPlaceholders} URL(s) contained unrendered template syntax ({{…}} or \${…}) and were skipped — the site templates those links client-side.`
    );
  }

  const queue: { url: string; depth: number; source: "sitemap" | "crawl" }[] = [
    { url: normalizeUrl(origin), depth: 0, source: "crawl" },
    ...sitemapUrls
      .filter((u) => !shouldSkipUrl(u))
      .map((u) => ({ url: normalizeUrl(u), depth: 0, source: "sitemap" as const })),
  ];

  let fetched = 0;
  let delayMs = CRAWL_DELAY_MS;
  let rateLimited = 0;
  while (queue.length > 0 && fetched < maxPages) {
    // Highest-value URL first, so a capped crawl spends its budget well.
    queue.sort((a, b) => scoreUrlForAudit(b.url).score - scoreUrlForAudit(a.url).score);
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);

    const { score, kind } = scoreUrlForAudit(next.url);
    try {
      const polite = await fetchPolitely(next.url, delayMs);
      const { html, status } = polite;
      if (polite.delayMs !== delayMs) {
        delayMs = polite.delayMs;
        rateLimited += 1;
      }
      fetched += 1;
      if (status !== 200 || html.length === 0) {
        results.push({
          url: next.url, kind, score, title: null, depth: next.depth,
          source: next.source, textLength: 0, error: `HTTP ${status}`,
        });
        continue;
      }

      const textLength = visibleText(html).length;
      results.push({
        url: next.url,
        kind,
        score,
        title: extractTitle(html),
        depth: next.depth,
        source: next.source,
        textLength,
      });

      if (next.depth < maxDepth) {
        for (const link of crawlLinks(html, next.url, host)) {
          if (!seen.has(link) && !shouldSkipUrl(link)) {
            queue.push({ url: link, depth: next.depth + 1, source: "crawl" });
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } catch (err) {
      results.push({
        url: next.url, kind, score, title: null, depth: next.depth,
        source: next.source, textLength: 0,
        error: err instanceof Error ? err.message : "fetch failed",
      });
    }
  }

  const truncated = queue.filter((q) => !seen.has(q.url)).length;
  if (truncated > 0) {
    // Stated, never silent: a capped crawl that reads as complete is a lie.
    notes.push(`${truncated} more URLs were found but not fetched (page cap ${maxPages}).`);
  }

  if (rateLimited > 0) {
    // Stated, because a crawl that quietly lost pages to rate limiting looks
    // identical to a site that simply has fewer pages.
    notes.push(
      `The site rate-limited ${rateLimited} request(s); the crawl slowed to ${delayMs}ms between pages. Re-run later to pick up anything missed.`
    );
  }

  const thin = results.filter((r) => !r.error && r.textLength < 500);
  if (thin.length > 0) {
    notes.push(
      `${thin.length} page(s) returned little text — likely rendered by JavaScript, which this crawler does not execute.`
    );
  }

  log("info", "knowledge.site_discovered", {
    host, fetched, found: results.length, sitemapFound,
  });

  results.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return ok({
    domain: host,
    pages: results,
    sitemapFound,
    pagesFetched: fetched,
    truncated,
    notes,
  });
}

/** Exported for tests: the crawl order, with skipped URLs removed. */
export function rankUrls(urls: string[]): string[] {
  return urls
    .filter((url) => !shouldSkipUrl(url))
    .sort((a, b) => scoreUrlForAudit(b).score - scoreUrlForAudit(a).score || a.localeCompare(b));
}
