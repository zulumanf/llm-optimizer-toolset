/**
 * robots.txt analysis for the technical scan (spec 088). Reuses the spec-027
 * parser (lib/knowledge/discovery/robots.ts) — evaluated once per crawler
 * token — and fetches through safeFetch, unlike the discovery bypass.
 *
 * Epistemics: an unreachable robots.txt is "no policy observed", never a
 * blocking finding. A Disallow for a crawler is an ACCESS observation, never
 * a recommendation-visibility claim.
 */
import { safeFetch, type SafeFetchDeps } from "@/lib/security/safe-fetch";
import { parseRobots, isPathAllowed } from "@/lib/knowledge/discovery/robots";
import {
  AI_CRAWLERS,
  ROBOTS_FETCH_MAX_BYTES,
  ROBOTS_FETCH_TIMEOUT_MS,
} from "@/lib/discoverability/constants";

export interface CrawlerAccess {
  crawler: string;
  /** Whether "/" is fetchable under the rules that apply to this crawler. */
  rootAllowed: boolean;
  /** True when a User-agent group names this crawler specifically (its rules
   * replace the wildcard's); false = the wildcard group applied. */
  viaSpecificGroup: boolean;
  /** The disallow patterns that applied, for evidence. */
  disallow: string[];
}

export interface RobotsReport {
  /** null = fetch failed entirely (network error). */
  fetchStatus: number | null;
  present: boolean;
  fetchError: string | null;
  sitemapRefs: string[];
  crawlerAccess: CrawlerAccess[];
  /** Raw body retained only when small enough — evidence for findings. */
  bodyExcerpt: string | null;
}

/** `Sitemap:` directives — the one field the spec-027 parser skips. */
export function extractSitemapRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)) {
    try {
      refs.add(new URL(match[1]!).toString());
    } catch {
      // A malformed sitemap URL is the site's problem, not a crash.
    }
  }
  return [...refs];
}

/** Per-crawler evaluation using the existing parser. A group is "specific"
 * when parsing with the crawler's token yields different rules than parsing
 * with a token no site names. */
export function evaluateCrawlers(
  body: string,
  crawlers: readonly string[] = AI_CRAWLERS
): CrawlerAccess[] {
  const wildcard = parseRobots(body, "avos-no-such-crawler-token");
  return crawlers.map((crawler) => {
    const rules = parseRobots(body, crawler.toLowerCase());
    const viaSpecificGroup =
      JSON.stringify(rules) !== JSON.stringify(wildcard);
    return {
      crawler,
      rootAllowed: isPathAllowed("/", rules),
      viaSpecificGroup,
      disallow: rules.disallow,
    };
  });
}

export async function fetchRobotsReport(
  origin: string,
  deps: SafeFetchDeps = {}
): Promise<RobotsReport> {
  try {
    const result = await safeFetch(
      `${origin}/robots.txt`,
      {
        timeoutMs: ROBOTS_FETCH_TIMEOUT_MS,
        maxBytes: ROBOTS_FETCH_MAX_BYTES,
      },
      deps
    );
    if (!result.ok) {
      return {
        fetchStatus: result.status,
        present: false,
        fetchError: null,
        sitemapRefs: [],
        crawlerAccess: [],
        bodyExcerpt: null,
      };
    }
    const body = result.bytes.toString("utf8");
    return {
      fetchStatus: result.status,
      present: true,
      fetchError: null,
      sitemapRefs: extractSitemapRefs(body),
      crawlerAccess: evaluateCrawlers(body),
      bodyExcerpt: body.slice(0, 4000),
    };
  } catch (err) {
    return {
      fetchStatus: null,
      present: false,
      fetchError: err instanceof Error ? err.message.slice(0, 300) : "fetch failed",
      sitemapRefs: [],
      crawlerAccess: [],
      bodyExcerpt: null,
    };
  }
}
