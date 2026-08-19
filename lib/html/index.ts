/**
 * Shared HTML primitives. Pure regex over raw HTML — the repo deliberately
 * carries no DOM parser: these are extraction helpers for evidence and
 * crawling, not rendering, and a regex a human can verify against the stored
 * original beats a dependency.
 *
 * Consumers with richer needs stay where they are:
 * - `lib/discoverability/page-facts.ts` builds attribute-level facts on top
 *   of these primitives.
 * - `lib/knowledge/sources/extractors/text.ts` keeps its own HTML extractor —
 *   it strips comments, converts block closes to newlines, and decodes
 *   entities, semantics this module intentionally does not have.
 */

export interface PageLink {
  url: string;
  anchor: string | null;
}

/** Value of an attribute inside a single raw tag string, or null. */
export function attrValue(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i")
  );
  return match?.[1]?.trim() ?? null;
}

/** <title> text, trimmed, capped at 300 chars. Longer titles yield null. */
export function extractTitle(html: string): string | null {
  return html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.trim() ?? null;
}

/** Script/style stripped, tags removed, whitespace collapsed. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ExtractLinksOptions {
  /** Return `{url, anchor}` objects instead of bare URLs. */
  withAnchors?: boolean;
  /** Same-host filter override; defaults to `new URL(baseUrl).host`. */
  host?: string;
  /** Cap on distinct links collected (anchor mode only). */
  maxLinks?: number;
}

/**
 * Same-host links from an HTML page. Two deliberately distinct modes — each
 * preserves the exact semantics of the call sites it was consolidated from:
 *
 * - `withAnchors: true` (discoverability page facts): parses `<a …>…</a>`
 *   pairs regardless of attribute order, skips `#`/mailto:/tel:/javascript:
 *   prefixes, strips fragments (so `/about#team` yields `/about`), dedupes by
 *   URL keeping the first anchor, and caps at `maxLinks`.
 * - default (onboarding crawler): matches quoted `href` attributes, drops any
 *   href containing a fragment entirely, strips nothing else, dedupes, no
 *   cap. Callers wanting canonical URLs normalize the result themselves.
 */
export function extractLinks(
  html: string,
  baseUrl: string,
  opts: ExtractLinksOptions & { withAnchors: true }
): PageLink[];
export function extractLinks(
  html: string,
  baseUrl: string,
  opts?: ExtractLinksOptions & { withAnchors?: false }
): string[];
export function extractLinks(
  html: string,
  baseUrl: string,
  opts: ExtractLinksOptions = {}
): PageLink[] | string[] {
  const host =
    opts.host ??
    (() => {
      try {
        return new URL(baseUrl).host;
      } catch {
        return null;
      }
    })();
  if (!host) return [];

  if (opts.withAnchors) {
    const maxLinks = opts.maxLinks ?? Number.POSITIVE_INFINITY;
    const byUrl = new Map<string, string | null>();
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      if (byUrl.size >= maxLinks) break;
      const href = attrValue(`<a ${match[1]!}>`, "href");
      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:")
      ) {
        continue;
      }
      try {
        const resolved = new URL(href, baseUrl);
        // Same host only — the graph we care about is the client's own site.
        if (resolved.host !== host) continue;
        resolved.hash = "";
        const url = resolved.toString();
        const anchor =
          match[2]!
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || null;
        // First anchor wins; a repeated link adds no information.
        if (!byUrl.has(url)) byUrl.set(url, anchor);
      } catch {
        // Malformed href is the page's problem.
      }
    }
    return [...byUrl.entries()].map(([url, anchor]) => ({ url, anchor }));
  }

  const out = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    const href = match[1]!;
    if (
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    ) {
      continue;
    }
    try {
      const resolved = new URL(href, baseUrl);
      // Same host only: following off-site links turns a client audit into a
      // crawl of the open web.
      if (resolved.host !== host) continue;
      resolved.hash = "";
      out.add(resolved.toString());
    } catch {
      // A malformed href is the page's problem, not a reason to stop.
    }
  }
  return [...out];
}
