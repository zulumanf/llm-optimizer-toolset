/**
 * Per-page fact extraction (spec 088). Pure regex over raw HTML — the repo
 * deliberately carries no DOM parser (lib/knowledge/sources/extractors), and
 * these checks need attributes, not a full tree. Facts only: nothing here
 * interprets, that is findings.ts's job. Shared primitives (title, visible
 * text, link extraction) live in `lib/html` and are re-exported here.
 */
import {
  MAX_JSONLD_BLOCKS,
  MAX_OUTLINKS_PER_PAGE,
} from "@/lib/discoverability/constants";
import {
  attrValue,
  extractLinks,
  extractTitle,
  visibleText,
  type PageLink,
} from "@/lib/html";

export { extractTitle, visibleText };
export type { PageLink };

export interface PageFacts {
  title: string | null;
  canonicalUrl: string | null;
  metaRobots: string | null;
  /** Same-host links with anchor text, deduped by URL, capped. */
  links: PageLink[];
  /** Parsed JSON-LD blocks (arrays and @graph flattened), capped. */
  jsonLd: Record<string, unknown>[];
  jsonLdError: string | null;
  textLength: number;
  /** Distinct plausible years in visible text, ascending. */
  yearsReferenced: number[];
}

export function extractCanonical(html: string, baseUrl: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attrValue(tag, "rel");
    if (!rel || rel.toLowerCase().split(/\s+/).indexOf("canonical") === -1) continue;
    const href = attrValue(tag, "href");
    if (!href) continue;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export function extractMetaRobots(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attrValue(tag, "name");
    if (name?.toLowerCase() !== "robots") continue;
    return attrValue(tag, "content");
  }
  return null;
}

/** noindex from meta robots and/or X-Robots-Tag. null = no signal observed
 * (unknown), which is NOT "indexable" — findings must not treat it as such. */
export function detectNoindex(
  metaRobots: string | null,
  xRobotsTag: string | null
): boolean | null {
  if (metaRobots == null && xRobotsTag == null) return null;
  const combined = `${metaRobots ?? ""},${xRobotsTag ?? ""}`.toLowerCase();
  return /\bnoindex\b/.test(combined);
}

export function extractLinksWithAnchors(
  html: string,
  baseUrl: string
): PageLink[] {
  return extractLinks(html, baseUrl, {
    withAnchors: true,
    maxLinks: MAX_OUTLINKS_PER_PAGE,
  });
}

export function extractJsonLd(html: string): {
  blocks: Record<string, unknown>[];
  error: string | null;
} {
  const blocks: Record<string, unknown>[] = [];
  let error: string | null = null;
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of scripts) {
    if (blocks.length >= MAX_JSONLD_BLOCKS) break;
    try {
      const parsed: unknown = JSON.parse(match[1]!.trim());
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["@graph"])
          ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
          : [parsed];
      for (const item of items) {
        if (blocks.length >= MAX_JSONLD_BLOCKS) break;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          blocks.push(item as Record<string, unknown>);
        }
      }
    } catch (err) {
      // Record that structured data exists but does not parse — that is
      // itself a finding-worthy fact.
      error = err instanceof Error ? err.message.slice(0, 200) : "invalid JSON";
    }
  }
  return { blocks, error };
}

/** Plausible years mentioned in the visible text — freshness signal, never
 * proof. Bounded to 1990..currentYear+1 so prices and zip codes don't count. */
export function yearsReferenced(text: string, currentYear: number): number[] {
  const years = new Set<number>();
  for (const match of text.matchAll(/\b(19|20)\d{2}\b/g)) {
    const year = Number(match[0]);
    if (year >= 1990 && year <= currentYear + 1) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

export function extractPageFacts(
  html: string,
  baseUrl: string,
  currentYear: number
): PageFacts {
  const text = visibleText(html);
  const jsonLd = extractJsonLd(html);
  return {
    title: extractTitle(html),
    canonicalUrl: extractCanonical(html, baseUrl),
    metaRobots: extractMetaRobots(html),
    links: extractLinksWithAnchors(html, baseUrl),
    jsonLd: jsonLd.blocks,
    jsonLdError: jsonLd.error,
    textLength: text.length,
    yearsReferenced: yearsReferenced(text, currentYear),
  };
}
