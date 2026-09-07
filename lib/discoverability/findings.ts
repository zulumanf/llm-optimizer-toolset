/**
 * Finding derivation for the technical scan (spec 088). Pure functions over
 * a completed scan's facts — every finding carries the OBSERVATION /
 * INFERENCE / RECOMMENDATION split, a severity (how wrong the technical
 * condition is) and a separate priority band (how worth fixing it is, via
 * the shared banding vocabulary). Unknown data produces NO negative finding.
 */
import { priorityBand, type PriorityBand } from "@/lib/gaps/detect";
import type { RobotsReport } from "@/lib/discoverability/robots";
import type { PageLink } from "@/lib/discoverability/page-facts";
import { checkStructuredData } from "@/lib/discoverability/schema-check";
import {
  AUTHORITY_KINDS,
  FRESHNESS_VERSION,
  IMPORTANT_PAGE_SCORE,
  SCHEMA_CHECK_VERSION,
  SITE_PRIORITY_VERSION,
  type PageKind,
} from "@/lib/discoverability/constants";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface ScannedPage {
  url: string;
  fetchError?: string | null;
  finalUrl: string | null;
  discoveredVia: "sitemap" | "crawl" | "homepage";
  httpStatus: number | null;
  ok: boolean;
  pageKind: PageKind;
  importance: number;
  title: string | null;
  canonicalUrl: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  noindex: boolean | null;
  inSitemap: boolean;
  sitemapLastmod: string | null;
  textLength: number | null;
  latestYearReferenced: number | null;
  outlinks: PageLink[];
  jsonLd: Record<string, unknown>[];
  jsonLdError: string | null;
}

export interface SiteFindingDraft {
  checkType: string;
  severity: Severity;
  observation: string;
  inference: string | null;
  recommendation: string;
  detail: Record<string, unknown>;
  priorityScore: number;
  priorityBand: PriorityBand;
  /** Resolves to site_pages.id at insert; null = scan-level finding. */
  pageUrl: string | null;
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 1,
  high: 0.8,
  medium: 0.55,
  low: 0.3,
  info: 0.1,
};

/** Execution/attainability/speed per check — all owned-site work, so these
 * sit high; the spread encodes editorial vs config effort. */
const CHECK_FACTORS: Record<string, { execution: number; attainability: number; speed: number }> = {
  robots_blocks_ai_crawler: { execution: 0.9, attainability: 0.9, speed: 0.9 },
  page_noindex: { execution: 0.9, attainability: 0.9, speed: 0.9 },
  canonical_mismatch: { execution: 0.85, attainability: 0.9, speed: 0.8 },
  page_error: { execution: 0.8, attainability: 0.85, speed: 0.8 },
  page_redirected: { execution: 0.8, attainability: 0.85, speed: 0.8 },
  missing_from_sitemap: { execution: 0.9, attainability: 0.9, speed: 0.85 },
  orphan_page: { execution: 0.7, attainability: 0.85, speed: 0.7 },
  missing_entity_schema: { execution: 0.8, attainability: 0.9, speed: 0.8 },
  incomplete_entity_schema: { execution: 0.8, attainability: 0.9, speed: 0.8 },
  inconsistent_entity_schema: { execution: 0.8, attainability: 0.9, speed: 0.8 },
  invalid_structured_data: { execution: 0.85, attainability: 0.9, speed: 0.85 },
  stale_authority_page: { execution: 0.6, attainability: 0.8, speed: 0.5 },
  intent_coverage_gap: { execution: 0.5, attainability: 0.7, speed: 0.4 },
};

function commercialWeight(page: ScannedPage | null): number {
  if (!page) return 1.0; // scan-level findings affect the whole site
  if (AUTHORITY_KINDS.has(page.pageKind)) return 1.0;
  if (page.pageKind === "homepage") return 0.9;
  if (page.pageKind === "blog") return 0.5;
  return 0.4;
}

function scoreFinding(
  checkType: string,
  severity: Severity,
  page: ScannedPage | null
): { priorityScore: number; priorityBand: PriorityBand; detail: Record<string, unknown> } {
  const factors = CHECK_FACTORS[checkType] ?? { execution: 0.6, attainability: 0.7, speed: 0.5 };
  const commercial = commercialWeight(page);
  const severityWeight = SEVERITY_WEIGHT[severity];
  const priorityScore =
    100 *
    (0.3 * commercial +
      0.25 * severityWeight +
      0.2 * factors.execution +
      0.15 * factors.attainability +
      0.1 * factors.speed);
  return {
    priorityScore: Number(priorityScore.toFixed(1)),
    priorityBand: priorityBand(priorityScore),
    detail: {
      priority: {
        formulaVersion: SITE_PRIORITY_VERSION,
        inputs: { commercial, severityWeight, ...factors },
      },
    },
  };
}

function normalized(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.host.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

function isImportant(page: ScannedPage): boolean {
  return AUTHORITY_KINDS.has(page.pageKind) || page.importance >= IMPORTANT_PAGE_SCORE;
}

function slugOf(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface DeriveInput {
  domain: string;
  robots: RobotsReport;
  sitemapFound: boolean;
  pages: ScannedPage[];
  subjectNames: string[];
  monitoredDimensions: { neighborhoods: string[]; buildings: string[] };
  currentYear: number;
  /** URLs deliberately isolated (landing pages etc.) — never orphans. */
  orphanExcludeUrls?: string[];
}

export function deriveFindings(input: DeriveInput): SiteFindingDraft[] {
  const findings: SiteFindingDraft[] = [];
  const push = (
    checkType: string,
    severity: Severity,
    page: ScannedPage | null,
    text: { observation: string; inference: string | null; recommendation: string },
    detail: Record<string, unknown>
  ): void => {
    const scored = scoreFinding(checkType, severity, page);
    findings.push({
      checkType,
      severity,
      ...text,
      detail: { ...detail, ...scored.detail },
      priorityScore: scored.priorityScore,
      priorityBand: scored.priorityBand,
      pageUrl: page?.url ?? null,
    });
  };

  // 1. Robots: blocked AI crawlers (one aggregated scan-level finding).
  // Unreachable robots.txt = "no policy observed" — never a blocking claim.
  const blocked = input.robots.crawlerAccess.filter((c) => !c.rootAllowed);
  if (blocked.length > 0) {
    const names = blocked.map((c) => c.crawler);
    push(
      "robots_blocks_ai_crawler",
      "high",
      null,
      {
        observation:
          `robots.txt on ${input.domain} disallows the site root for: ` +
          `${names.join(", ")}` +
          (blocked.some((c) => c.viaSpecificGroup)
            ? " (named in a specific User-agent group)."
            : " (via the wildcard group)."),
        inference:
          "This may limit direct page access by those crawlers. Crawler " +
          "access is one ingredient of AI visibility, not a guarantee " +
          "either way.",
        recommendation:
          "Review whether blocking these crawlers is intentional; if not, " +
          "adjust robots.txt. No change is made automatically.",
      },
      { crawlers: blocked }
    );
  }

  const okPages = input.pages.filter((p) => p.ok);

  for (const page of input.pages) {
    const important = isImportant(page);
    const label = `${page.pageKind} page ${page.url}`;

    // 2. Errors. A page we could not fetch at all stays unknown, not broken.
    if (page.httpStatus != null && page.httpStatus >= 400) {
      push(
        "page_error",
        important ? "high" : "medium",
        page,
        {
          observation: `The ${label} returned HTTP ${page.httpStatus}.`,
          inference: important
            ? "An authority page that returns an error cannot be read by any crawler or assistant."
            : null,
          recommendation: "Restore the page or redirect it to its current equivalent.",
        },
        { httpStatus: page.httpStatus, discoveredVia: page.discoveredVia }
      );
      continue;
    }
    if (!page.ok) continue;

    // 3. noindex — only when actually observed (null = unknown, no finding).
    if (page.noindex === true) {
      push(
        "page_noindex",
        important ? "high" : "medium",
        page,
        {
          observation:
            `The ${label} carries a noindex directive ` +
            `(meta robots: ${page.metaRobots ?? "—"}; X-Robots-Tag: ${page.xRobotsTag ?? "—"}).`,
          inference: "Search-grounded systems are told not to index this page.",
          recommendation:
            "Confirm whether noindex is intentional for this page; remove it if the page should carry authority.",
        },
        { metaRobots: page.metaRobots, xRobotsTag: page.xRobotsTag }
      );
    }

    // 4. Redirected page (evidence: requested vs final URL).
    if (page.finalUrl && normalized(page.finalUrl) !== normalized(page.url)) {
      push(
        "page_redirected",
        important ? "medium" : "info",
        page,
        {
          observation: `${page.url} redirects to ${page.finalUrl}.`,
          inference: important
            ? "Links and citations pointing at the original URL depend on this redirect staying in place."
            : null,
          recommendation:
            "Confirm the redirect is intentional and that internal links and sitemaps point at the final URL.",
        },
        { finalUrl: page.finalUrl }
      );
    }

    // 5. Canonical mismatch — only when a canonical is present.
    if (page.canonicalUrl) {
      const self = normalized(page.finalUrl ?? page.url);
      const canonical = normalized(page.canonicalUrl);
      if (canonical !== self) {
        const crossHost = canonical.split("/")[0] !== self.split("/")[0];
        push(
          "canonical_mismatch",
          crossHost ? "high" : "medium",
          page,
          {
            observation: `The ${label} declares canonical ${page.canonicalUrl}, which is not the page itself.`,
            inference:
              "Indexing systems are being told a different URL is the authoritative version of this content.",
            recommendation:
              "Verify the canonical target is correct; point it at the page itself unless this is a deliberate consolidation.",
          },
          { canonicalUrl: page.canonicalUrl, crossHost }
        );
      }
    }

    // 6. Sitemap coverage — only meaningful when a sitemap exists at all.
    if (input.sitemapFound && !page.inSitemap && AUTHORITY_KINDS.has(page.pageKind)) {
      push(
        "missing_from_sitemap",
        "low",
        page,
        {
          observation: `The ${label} was not found in any discovered sitemap.`,
          inference:
            "Sitemap absence is an observation about the site's own inventory, not proof the page cannot be indexed.",
          recommendation: "Add the page to the sitemap so the site's inventory names it.",
        },
        { discoveredVia: page.discoveredVia }
      );
    }

    // 7. Freshness — only with an observed date signal; no dates = unknown.
    if (
      AUTHORITY_KINDS.has(page.pageKind) &&
      page.latestYearReferenced != null &&
      page.latestYearReferenced <= input.currentYear - 2
    ) {
      push(
        "stale_authority_page",
        "low",
        page,
        {
          observation:
            `The most recent year referenced on the ${label} is ` +
            `${page.latestYearReferenced}; the current year is ${input.currentYear}.`,
          inference:
            "The page's visible evidence may read as dated. This is an update opportunity, not a verdict on the content.",
          recommendation:
            "Refresh the page with recent transaction evidence or market data where it genuinely exists.",
        },
        {
          latestYearReferenced: page.latestYearReferenced,
          sitemapLastmod: page.sitemapLastmod,
          freshnessVersion: FRESHNESS_VERSION,
        }
      );
    }
  }

  // 8. Orphans: authority pages with zero inlinks from the scanned pages.
  const exclude = new Set((input.orphanExcludeUrls ?? []).map(normalized));
  const inlinks = new Map<string, number>();
  for (const page of okPages) {
    const selfKeys = new Set([normalized(page.url), normalized(page.finalUrl ?? page.url)]);
    for (const link of page.outlinks) {
      const key = normalized(link.url);
      if (selfKeys.has(key)) continue; // self-links don't connect anything
      inlinks.set(key, (inlinks.get(key) ?? 0) + 1);
    }
  }
  for (const page of okPages) {
    if (!AUTHORITY_KINDS.has(page.pageKind)) continue;
    if (page.pageKind === ("homepage" as PageKind)) continue;
    const keys = [normalized(page.url), normalized(page.finalUrl ?? page.url)];
    if (keys.some((k) => exclude.has(k))) continue;
    const count = keys.reduce((max, k) => Math.max(max, inlinks.get(k) ?? 0), 0);
    if (count === 0 && okPages.length > 1) {
      push(
        "orphan_page",
        "medium",
        page,
        {
          observation:
            `The ${page.pageKind} page ${page.url} has zero internal links ` +
            `from the ${okPages.length} scanned pages.`,
          inference:
            "The site's internal structure only weakly represents the relationship between the team and this page's subject.",
          recommendation:
            "Add contextual links from related authority pages (team, market, neighborhood) where editorially relevant.",
        },
        { scannedPages: okPages.length, inlinkCount: count }
      );
    }
  }

  // 9. Structured data per ok page, aggregated per check type per page (the
  // dedup index allows one row per (scan, check, page)).
  for (const page of okPages) {
    const expectEntity =
      page.pageKind === "team" || page.pageKind === "agent" || page.pageKind === "homepage";
    const observations = checkStructuredData({
      blocks: page.jsonLd,
      parseError: page.jsonLdError,
      expectEntity,
      subjectNames: input.subjectNames,
    });
    const byKind = new Map<string, typeof observations>();
    for (const obs of observations) {
      if (obs.kind === "informational") continue;
      const list = byKind.get(obs.kind) ?? [];
      list.push(obs);
      byKind.set(obs.kind, list);
    }
    const CHECK_BY_KIND: Record<string, { checkType: string; severity: Severity }> = {
      missing: { checkType: "missing_entity_schema", severity: "medium" },
      invalid: { checkType: "invalid_structured_data", severity: "low" },
      inconsistent: { checkType: "inconsistent_entity_schema", severity: "medium" },
      incomplete: { checkType: "incomplete_entity_schema", severity: "low" },
    };
    for (const [kind, list] of byKind) {
      const mapping = CHECK_BY_KIND[kind];
      if (!mapping) continue;
      push(
        mapping.checkType,
        mapping.severity,
        page,
        {
          observation: `${page.pageKind} page ${page.url}: ${list.map((o) => o.note).join(" ")}`,
          inference:
            "Structured data is one machine-understanding signal; gaps here make the entity harder to read, not invisible.",
          recommendation:
            kind === "missing"
              ? "Add Person/Organization/RealEstateAgent structured data describing the team with its real, verifiable details."
              : "Correct the structured data using only values that are true and verifiable.",
        },
        { schemaCheckVersion: SCHEMA_CHECK_VERSION, observations: list.map((o) => o.observed) }
      );
    }
  }

  // 10. Intent coverage: monitored neighborhoods/buildings (spec 087 prompt
  // dimensions) with no matching owned page — one aggregated finding.
  const haystack = okPages.map((p) => ({
    url: p.url.toLowerCase(),
    title: (p.title ?? "").toLowerCase(),
  }));
  const uncovered = (values: string[]): string[] =>
    values.filter((value) => {
      const slug = slugOf(value);
      const lower = value.toLowerCase();
      return !haystack.some(
        (h) => h.url.includes(slug) || (lower.length > 3 && h.title.includes(lower))
      );
    });
  const missingNeighborhoods = uncovered(input.monitoredDimensions.neighborhoods);
  const missingBuildings = uncovered(input.monitoredDimensions.buildings);
  if (missingNeighborhoods.length > 0 || missingBuildings.length > 0) {
    const parts = [
      ...missingNeighborhoods.map((n) => `neighborhood "${n}"`),
      ...missingBuildings.map((b) => `building "${b}"`),
    ];
    push(
      "intent_coverage_gap",
      "medium",
      null,
      {
        observation:
          `Monitored high-intent dimensions with no matching owned page among ` +
          `the ${okPages.length} scanned pages: ${parts.join(", ")}.`,
        inference:
          "The measurement program probes these dimensions, but the site offers no dedicated page for an assistant to read about them.",
        recommendation:
          "Create or surface authority pages for these dimensions where the team has genuine, verifiable expertise.",
      },
      { missingNeighborhoods, missingBuildings, scannedPages: okPages.length }
    );
  }

  return findings.sort((a, b) => b.priorityScore - a.priorityScore);
}
