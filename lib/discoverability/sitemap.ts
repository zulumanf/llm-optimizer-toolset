/**
 * Sitemap discovery + parsing for the technical scan (spec 088). Unlike the
 * onboarding crawler's <loc>-only reader, this keeps lastmod and which
 * sitemap each URL came from — the freshness and sitemap-coverage checks
 * need both. Regex parsing, matching the repo's no-DOM-parser convention.
 */
import { safeFetch, type SafeFetchDeps } from "@/lib/security/safe-fetch";
import {
  MAX_SITEMAP_DOCS,
  MAX_SITEMAP_URLS,
  PAGE_FETCH_MAX_BYTES,
  PAGE_FETCH_TIMEOUT_MS,
} from "@/lib/discoverability/constants";

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
  sitemapUrl: string;
}

export interface SitemapDocReport {
  url: string;
  status: number | null;
  urlCount: number;
  error: string | null;
}

export interface SitemapReport {
  found: boolean;
  documents: SitemapDocReport[];
  entries: SitemapEntry[];
  truncated: boolean;
}

/** Parse one sitemap document. <url> blocks yield url+lastmod; a document
 * whose <loc>s are themselves sitemaps is an index (returned as children). */
export function parseSitemapDoc(
  xml: string,
  sitemapUrl: string
): { entries: SitemapEntry[]; children: string[] } {
  const entries: SitemapEntry[] = [];
  const children: string[] = [];

  const urlBlocks = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)];
  if (urlBlocks.length > 0) {
    for (const block of urlBlocks) {
      const loc = block[1]!.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
      if (!loc) continue;
      const lastmod =
        block[1]!.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1] ?? null;
      entries.push({ url: loc, lastmod, sitemapUrl });
    }
    return { entries, children };
  }

  // No <url> blocks: either a sitemap index or a bare <loc> list.
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const loc = match[1]!;
    if (/sitemap[^/]*\.xml(\.gz)?$/i.test(loc)) children.push(loc);
    else entries.push({ url: loc, lastmod: null, sitemapUrl });
  }
  return { entries, children };
}

/**
 * Fetch and parse sitemaps: robots-declared refs first, then the standard
 * locations. One level of index nesting, capped documents and URLs.
 */
export async function discoverSitemaps(
  origin: string,
  robotsRefs: string[],
  deps: SafeFetchDeps = {}
): Promise<SitemapReport> {
  const candidates = [
    ...robotsRefs,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
  ];
  const seen = new Set<string>();
  const documents: SitemapDocReport[] = [];
  const entries: SitemapEntry[] = [];
  let truncated = false;

  const readDoc = async (
    url: string
  ): Promise<{ children: string[] } | null> => {
    if (seen.has(url) || documents.length >= MAX_SITEMAP_DOCS) {
      if (!seen.has(url)) truncated = true;
      return null;
    }
    seen.add(url);
    try {
      const result = await safeFetch(
        url,
        { timeoutMs: PAGE_FETCH_TIMEOUT_MS, maxBytes: PAGE_FETCH_MAX_BYTES },
        deps
      );
      if (!result.ok) {
        documents.push({ url, status: result.status, urlCount: 0, error: null });
        return null;
      }
      const xml = result.bytes.toString("utf8");
      if (!xml.includes("<loc>")) {
        documents.push({ url, status: result.status, urlCount: 0, error: null });
        return null;
      }
      const parsed = parseSitemapDoc(xml, url);
      for (const entry of parsed.entries) {
        if (entries.length >= MAX_SITEMAP_URLS) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
      documents.push({
        url,
        status: result.status,
        urlCount: parsed.entries.length,
        error: null,
      });
      return { children: parsed.children };
    } catch (err) {
      documents.push({
        url,
        status: null,
        urlCount: 0,
        error: err instanceof Error ? err.message.slice(0, 200) : "fetch failed",
      });
      return null;
    }
  };

  for (const candidate of candidates) {
    const doc = await readDoc(candidate);
    if (!doc) continue;
    for (const child of doc.children) await readDoc(child);
    // A candidate that yielded entries is enough — the standard locations
    // are fallbacks, not a set to union exhaustively.
    if (entries.length > 0) break;
  }

  return { found: entries.length > 0, documents, entries, truncated };
}
