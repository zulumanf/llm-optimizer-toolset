# Spec 088 — Technical Discoverability Engine

> Status: done
> Depends on: specs/087 (priority bands, playbooks, prompt dimensions), specs/027 (robots compliance), specs/060 (citation acquisition), docs/10 (safe egress)
> Branch: feat/088-technical-discoverability

## Goal

One cohesive engine that answers: can AI/search systems discover, crawl,
understand, and connect the client's authority pages? It scans the client's
own domain (robots.txt, sitemaps, important pages), persists page-level facts
(status, canonical, noindex, JSON-LD, internal links, freshness signals,
real-estate page kind), derives evidence-backed findings in the
OBSERVATION → INFERENCE → RECOMMENDATION shape, and promotes them into the
existing task queue with the existing priority-band vocabulary. Deterministic
checks only — no LLM, no autonomous site edits.

## What is reused (audit result — do not rebuild)

- `safeFetch` (SSRF guards, redirect re-validation, size caps) — the only
  egress path; the scan never uses raw fetch.
- `parseRobots` / `isPathAllowed` (`lib/knowledge/discovery/robots.ts`) —
  evaluated once per crawler token for the AI-crawler roster.
- `scoreUrlForAudit` / `shouldSkipUrl` + crawl politeness constants
  (`lib/knowledge/sources/discover.ts`) for page importance and skip rules.
- Job queue: unconstrained `jobs.type` + one new key in `workers/core.ts`
  `handlers`. No new orchestration.
- Task queue: `suggestTask` (evidence-gated), `priorityBand`
  (do_now/do_next/test/low_priority), source playbooks, intervention types
  (`technical_accessibility_fix`, `crawler_access_change`,
  `internal_linking_changed`, `schema_updated` — already present, previously
  undetectable).
- Prompt dimensions from spec 087 (neighborhood/building/property_type) for
  the intent-coverage check.
- Scan root: `projects.subject_company_id → companies.domain` (the
  onboarding precedent).
- Epistemics: observation (counted) / inference (hedged) / recommendation.

## Database changes

Migration `083_technical_discoverability.sql`:

1. `site_scans` — one row per scan: project, domain, status
   (running/completed/failed), `scanner_version`, `robots jsonb` (fetch
   status, per-crawler root access, sitemap refs), `sitemaps jsonb`,
   pages_fetched, notes, error, started_by, timestamps.
2. `site_pages` — per-page facts: url, final_url, discovered_via
   (sitemap/crawl/homepage), http_status, ok, page_kind +
   `classifier_version`, title, canonical_url, meta_robots, x_robots_tag,
   `noindex` (null = unknown), in_sitemap, sitemap_lastmod, text_length,
   latest_year_referenced, `outlinks jsonb` (same-host, capped, with
   anchors), `jsonld jsonb` (compact relevant blocks), jsonld_error.
   Unique (scan_id, url).
3. `site_findings` — scan-scoped findings (gap_findings is run-scoped by
   design, so this mirrors its shape rather than distorting it): check_type,
   severity (critical/high/medium/low/info — technical wrongness),
   observation/inference/recommendation, detail jsonb (priority inputs +
   formula version), priority_score + priority_band (business priority,
   separate from severity), scanner_version, status
   (open/task_created/dismissed), task_id. Dedup unique
   (scan_id, check_type, coalesce(page_id, nil-uuid)).
4. `evidence.kind` CHECK widened with `'site_page'`, `'site_scan'` so
   technical tasks satisfy the evidence gate with real refs.

## Engine (`lib/discoverability/`, versioned)

- `constants.ts` — `SCAN_VERSION = "technical-scan-v1"`, AI crawler roster
  (Googlebot, GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot), caps
  (max pages default 25 / hard 50, sitemap docs ≤ 5, urls ≤ 500, per-page
  2 MB / 10 s), authority page kinds.
- `robots.ts` — fetch via safeFetch; per-crawler evaluation using the
  existing parser (root allowed? via a group naming the crawler or the
  wildcard?); `Sitemap:` directive extraction. Unreachable robots is
  reported as an observation, never treated as prohibition or as a finding
  of blocking.
- `sitemap.ts` — parse `<url><loc><lastmod>` blocks and bare `<loc>` lists;
  one level of sitemap-index nesting; caps; keeps (url, lastmod, source).
- `page-facts.ts` — pure regex extraction (repo convention: no DOM parser):
  title, canonical, meta robots, same-host links with anchors, JSON-LD
  blocks, visible-text length, years referenced.
- `classify-page.ts` — `PAGE_CLASSIFIER_VERSION = "page-classifier-v1"`:
  url+title → team/agent/market/neighborhood/building/property_type/
  transaction/case_study/press/authority/blog/contact/homepage/generic
  (extends the discover.ts pattern table; persisted this time).
- `schema-check.ts` — `SCHEMA_CHECK_VERSION = "schema-check-v1"`: JSON-LD
  blocks vs the real-estate-relevant types (Person, Organization,
  RealEstateAgent, LocalBusiness, WebSite, WebPage, BreadcrumbList,
  Article, FAQPage); classify missing/invalid/incomplete/inconsistent/
  informational; never invents values; name inconsistency only against the
  subject company's known name/aliases.
- `findings.ts` — pure derivation over a completed scan: robots blocks AI
  crawler; noindexed / erroring / redirected important pages; canonical
  mismatch; important page absent from discovered sitemaps (observation
  phrasing, no indexability claim); orphaned authority pages (zero inlinks
  from scanned pages, homepage + configured exclusions exempt); missing/
  incomplete entity schema; stale authority page (latest year referenced ≥ 2
  years behind, "update opportunity" phrasing; no dates → unknown → no
  finding); intent-coverage gap (monitored neighborhoods/buildings from the
  087 prompt dimensions with no matching owned page). Severity ≠ priority:
  `SITE_PRIORITY_VERSION = "site-priority-v1"` reuses the gap formula shape
  (commercial 0.30 / severity 0.25 / execution 0.20 / attainability 0.15 /
  speed 0.10) with per-check factors, then the shared `priorityBand`.
- `scan.ts` — orchestrator run by job `technical_scan`: resolve domain →
  robots → sitemaps → candidate pages (sitemap ∪ homepage; crawl fallback
  from homepage links) ranked by `scoreUrlForAudit` → polite fetch loop
  (injectable fetch deps + delay for tests) → persist pages → derive +
  persist findings → complete scan. Partial failure records what it saw.
- `service.ts` — `requestTechnicalScan` (enqueue + audit),
  `createTaskFromSiteFinding` (suggestTask + evidence refs + playbook
  actions), `dismissSiteFinding` / `reopenSiteFinding`.

## UI (minimal)

- New project section `/technical` (added to the Findings tab set): latest
  scan summary stats, findings grouped by priority band with severity
  badges, per-finding Create task / Dismiss, Run scan button. Existing page
  primitives only. No audit-page changes in this spec (prospect-facing
  technical section deferred until real scans exist to calibrate copy).

## Edge cases

- No subject company or no domain → scan refused with a clear message,
  nothing queued.
- robots.txt unreachable → observation "could not be fetched", crawlers
  reported as "no policy observed", no blocking finding.
- No sitemap found → crawl fallback; `missing_from_sitemap` findings are
  suppressed entirely (nothing to be absent from).
- Page with no date signals → freshness unknown, no staleness finding.
- Redirect to another host → recorded via final_url; page facts come from
  the final response; finding notes the redirect.
- Fetch failure on one page → row recorded with error; scan continues.
- Re-scan → new scan row; historical scans and their findings untouched.

## Acceptance criteria

- [ ] Migration applies and rolls back cleanly.
- [ ] Robots rules evaluated per AI crawler; explicit blocks reported with
      the matched group; unreachable robots never becomes a blocking claim.
- [ ] Sitemap parsing captures url + lastmod + source; nested index followed
      one level; caps enforced.
- [ ] noindex, canonical, status, redirects extracted and persisted with the
      page row as evidence.
- [ ] Schema findings never invent values and retain the observed block.
- [ ] Internal-link edges recorded; orphan detection excludes homepage and
      configured exclusions; findings state "from the N scanned pages".
- [ ] Unknown data (no dates, no robots, no sitemap) produces no negative
      finding.
- [ ] Findings carry observation/inference/recommendation, severity separate
      from priority band, and formula inputs in detail.
- [ ] createTaskFromSiteFinding produces an evidence-backed task in the
      existing queue; finding links to the task; intervention linkage works
      through the existing tasks → interventions path.
- [ ] End-to-end scan against an injected fake site produces the expected
      pages, findings, and task.
- [ ] `npm run lint`, `npm run typecheck`, targeted vitest suites green.

## Definition of done

Acceptance criteria pass · migration up/down tested · DECISIONS.md entry ·
P1 items (crawler logs, entity footprint, redirect chains, duplicate
content) explicitly deferred.
