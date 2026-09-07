/**
 * Technical scan orchestrator (spec 088) — runs as job `technical_scan`.
 * One engine: robots → sitemaps → important pages → per-page facts →
 * findings, all persisted so historical scans stay reproducible. Scope is
 * strictly the client's own domain, ranked by the onboarding crawler's
 * importance model, capped, and polite. Fetch deps and delay are injectable
 * so tests run against a fake site with no sleeps.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import type { SafeFetchDeps } from "@/lib/security/safe-fetch";
import { safeFetch } from "@/lib/security/safe-fetch";
import {
  CRAWLER_USER_AGENT,
  scoreUrlForAudit,
  shouldSkipUrl,
} from "@/lib/knowledge/sources/discover";
import { fetchRobotsReport } from "@/lib/discoverability/robots";
import { discoverSitemaps, type SitemapEntry } from "@/lib/discoverability/sitemap";
import { extractPageFacts } from "@/lib/discoverability/page-facts";
import { detectNoindex } from "@/lib/discoverability/page-facts";
import { classifyPage } from "@/lib/discoverability/classify-page";
import { deriveFindings, type ScannedPage } from "@/lib/discoverability/findings";
import {
  DEFAULT_SCAN_PAGES,
  MAX_SCAN_PAGES,
  PAGE_CLASSIFIER_VERSION,
  PAGE_FETCH_MAX_BYTES,
  PAGE_FETCH_TIMEOUT_MS,
  SCAN_VERSION,
} from "@/lib/discoverability/constants";
import { log } from "@/lib/logger";

const CRAWL_DELAY_MS = 1_200;

export interface TechnicalScanPayload {
  projectId: string;
  startedBy?: string | null;
  maxPages?: number;
}

export interface TechnicalScanDeps extends SafeFetchDeps {
  /** Inter-request delay; tests pass 0. */
  delayMs?: number;
  /** Injected clock so freshness findings are deterministic in tests. */
  now?: Date;
}

interface Candidate {
  url: string;
  via: "sitemap" | "crawl" | "homepage";
  lastmod: string | null;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

/** Monitored intent dimensions (spec 087 columns) for the coverage check. */
async function monitoredDimensions(
  projectId: string
): Promise<{ neighborhoods: string[]; buildings: string[] }> {
  const rows = await sql`
    select distinct p.neighborhood, p.building
    from prompts p
    join prompt_sets s on s.id = p.prompt_set_id
    where s.project_id = ${projectId}
      and s.archived_at is null and p.archived_at is null
  `;
  const neighborhoods = new Set<string>();
  const buildings = new Set<string>();
  for (const row of rows) {
    if (row.neighborhood) neighborhoods.add(row.neighborhood as string);
    if (row.building) buildings.add(row.building as string);
  }
  return { neighborhoods: [...neighborhoods], buildings: [...buildings] };
}

/**
 * Execute one technical scan. Called by the worker; tests call it directly
 * with injected fetch deps. Partial failures record what was seen — a scan
 * that saw three pages and then died reports three pages and 'failed'.
 */
export async function runTechnicalScan(
  payload: TechnicalScanPayload,
  deps: TechnicalScanDeps = {}
): Promise<{ scanId: string; pages: number; findings: number }> {
  const { projectId } = payload;
  const now = deps.now ?? new Date();
  const currentYear = now.getFullYear();
  const delayMs = deps.delayMs ?? CRAWL_DELAY_MS;

  const subject = await getSubjectCompany(projectId);
  if (!subject?.domain) {
    throw new Error("Project has no subject company with a domain — nothing to scan.");
  }
  const domain = subject.domain;
  const origin = `https://${domain}`;
  const subjectNames = [subject.name, ...(subject.aliases ?? [])].filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0
  );

  const [scan] = await sql`
    insert into site_scans (project_id, domain, scanner_version, started_by)
    values (${projectId}, ${domain}, ${SCAN_VERSION}, ${payload.startedBy ?? null})
    returning id
  `;
  const scanId = scan!.id as string;

  try {
    // 1. robots.txt — per-crawler access + sitemap refs.
    const robots = await fetchRobotsReport(origin, deps);

    // 2. Sitemaps.
    const sitemaps = await discoverSitemaps(origin, robots.sitemapRefs, deps);
    const lastmodByUrl = new Map<string, string | null>(
      sitemaps.entries.map((e: SitemapEntry) => [e.url, e.lastmod])
    );

    // 3. Candidate pages: homepage + sitemap URLs; crawl fallback fills from
    // homepage links when no sitemap exists (added after the homepage fetch).
    const maxPages = Math.min(payload.maxPages ?? DEFAULT_SCAN_PAGES, MAX_SCAN_PAGES);
    const candidates = new Map<string, Candidate>();
    candidates.set(`${origin}/`, { url: `${origin}/`, via: "homepage", lastmod: null });
    const ranked = [...lastmodByUrl.keys()]
      .filter((url) => {
        try {
          return new URL(url).host.replace(/^www\./, "") === domain.replace(/^www\./, "");
        } catch {
          return false;
        }
      })
      .filter((url) => !shouldSkipUrl(url))
      .sort((a, b) => scoreUrlForAudit(b).score - scoreUrlForAudit(a).score);
    for (const url of ranked) {
      if (candidates.size >= maxPages) break;
      if (!candidates.has(url)) {
        candidates.set(url, { url, via: "sitemap", lastmod: lastmodByUrl.get(url) ?? null });
      }
    }

    // 4. Fetch loop.
    const pages: ScannedPage[] = [];
    const queue = [...candidates.values()];
    let fetched = 0;
    while (queue.length > 0) {
      const candidate = queue.shift()!;
      if (fetched > 0) await sleep(delayMs);
      fetched += 1;
      let page: ScannedPage;
      try {
        const result = await safeFetch(
          candidate.url,
          {
            timeoutMs: PAGE_FETCH_TIMEOUT_MS,
            maxBytes: PAGE_FETCH_MAX_BYTES,
            headers: {
              "user-agent": CRAWLER_USER_AGENT,
              accept: "text/html,application/xhtml+xml",
            },
          },
          deps
        );
        const html = result.ok ? result.bytes.toString("utf8") : "";
        const facts = extractPageFacts(html, result.finalUrl || candidate.url, currentYear);
        const xRobotsTag = result.headers.get("x-robots-tag");
        page = {
          url: candidate.url,
          finalUrl: result.finalUrl || null,
          discoveredVia: candidate.via,
          httpStatus: result.status,
          ok: result.ok,
          pageKind: classifyPage(candidate.url, facts.title),
          importance: scoreUrlForAudit(candidate.url).score,
          title: facts.title,
          canonicalUrl: result.ok ? facts.canonicalUrl : null,
          metaRobots: result.ok ? facts.metaRobots : null,
          xRobotsTag,
          noindex: result.ok ? detectNoindex(facts.metaRobots, xRobotsTag) : null,
          inSitemap: lastmodByUrl.has(candidate.url),
          sitemapLastmod: candidate.lastmod,
          textLength: result.ok ? facts.textLength : null,
          latestYearReferenced:
            result.ok && facts.yearsReferenced.length > 0
              ? facts.yearsReferenced[facts.yearsReferenced.length - 1]!
              : null,
          outlinks: result.ok ? facts.links : [],
          jsonLd: result.ok ? facts.jsonLd : [],
          jsonLdError: result.ok ? facts.jsonLdError : null,
        };
        // Crawl fallback: no sitemap → widen from the homepage's own links.
        if (!sitemaps.found && candidate.via === "homepage") {
          const extra = facts.links
            .map((l) => l.url)
            .filter((url) => !shouldSkipUrl(url))
            .sort((a, b) => scoreUrlForAudit(b).score - scoreUrlForAudit(a).score);
          for (const url of extra) {
            if (candidates.size >= maxPages) break;
            if (!candidates.has(url)) {
              const entry: Candidate = { url, via: "crawl", lastmod: null };
              candidates.set(url, entry);
              queue.push(entry);
            }
          }
        }
      } catch (err) {
        page = {
          url: candidate.url,
          finalUrl: null,
          discoveredVia: candidate.via,
          httpStatus: null,
          ok: false,
          pageKind: classifyPage(candidate.url, null),
          importance: scoreUrlForAudit(candidate.url).score,
          title: null,
          canonicalUrl: null,
          metaRobots: null,
          xRobotsTag: null,
          noindex: null,
          inSitemap: lastmodByUrl.has(candidate.url),
          sitemapLastmod: candidate.lastmod,
          textLength: null,
          latestYearReferenced: null,
          outlinks: [],
          jsonLd: [],
          jsonLdError: null,
        };
        page.fetchError =
          err instanceof Error ? err.message.slice(0, 300) : "fetch failed";
      }
      pages.push(page);
    }

    // 5. Persist pages.
    const pageIdByUrl = new Map<string, string>();
    for (const page of pages) {
      const [row] = await sql`
        insert into site_pages
          (scan_id, project_id, url, final_url, discovered_via, http_status,
           ok, fetch_error, page_kind, classifier_version, importance, title,
           canonical_url, meta_robots, x_robots_tag, noindex, in_sitemap,
           sitemap_lastmod, text_length, latest_year_referenced, outlinks,
           jsonld, jsonld_error)
        values
          (${scanId}, ${projectId}, ${page.url}, ${page.finalUrl},
           ${page.discoveredVia}, ${page.httpStatus}, ${page.ok},
           ${page.fetchError ?? null},
           ${page.pageKind}, ${PAGE_CLASSIFIER_VERSION}, ${page.importance},
           ${page.title}, ${page.canonicalUrl}, ${page.metaRobots},
           ${page.xRobotsTag}, ${page.noindex}, ${page.inSitemap},
           ${page.sitemapLastmod}, ${page.textLength},
           ${page.latestYearReferenced},
           ${sql.json(page.outlinks as unknown as Parameters<typeof sql.json>[0])},
           ${sql.json(page.jsonLd as unknown as Parameters<typeof sql.json>[0])},
           ${page.jsonLdError})
        on conflict (scan_id, url) do nothing
        returning id
      `;
      if (row) pageIdByUrl.set(page.url, row.id as string);
    }

    // 6. Derive + persist findings.
    const dimensions = await monitoredDimensions(projectId);
    const drafts = deriveFindings({
      domain,
      robots,
      sitemapFound: sitemaps.found,
      pages,
      subjectNames,
      monitoredDimensions: dimensions,
      currentYear,
    });
    for (const draft of drafts) {
      await sql`
        insert into site_findings
          (project_id, scan_id, page_id, check_type, severity, observation,
           inference, recommendation, detail, priority_score, priority_band,
           scanner_version)
        values
          (${projectId}, ${scanId},
           ${draft.pageUrl ? (pageIdByUrl.get(draft.pageUrl) ?? null) : null},
           ${draft.checkType}, ${draft.severity}, ${draft.observation},
           ${draft.inference}, ${draft.recommendation},
           ${sql.json(draft.detail as unknown as Parameters<typeof sql.json>[0])},
           ${draft.priorityScore}, ${draft.priorityBand}, ${SCAN_VERSION})
        on conflict do nothing
      `;
    }

    await sql`
      update site_scans set
        status = 'completed',
        robots = ${sql.json({
          fetchStatus: robots.fetchStatus,
          present: robots.present,
          fetchError: robots.fetchError,
          sitemapRefs: robots.sitemapRefs,
          crawlerAccess: robots.crawlerAccess,
        } as unknown as Parameters<typeof sql.json>[0])},
        sitemaps = ${sql.json({
          found: sitemaps.found,
          documents: sitemaps.documents,
          truncated: sitemaps.truncated,
          urlCount: sitemaps.entries.length,
        } as unknown as Parameters<typeof sql.json>[0])},
        pages_fetched = ${pages.length},
        completed_at = now()
      where id = ${scanId}
    `;
    log("info", "discoverability.scan_completed", {
      scanId,
      projectId,
      pages: pages.length,
      findings: drafts.length,
    });
    return { scanId, pages: pages.length, findings: drafts.length };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "scan failed";
    await sql`
      update site_scans set status = 'failed', error = ${message},
        completed_at = now()
      where id = ${scanId}
    `;
    throw err;
  }
}
