-- Spec 088: technical discoverability. Persists what the own-site crawler
-- always threw away — per-page facts (status, canonical, noindex, JSON-LD,
-- internal links, freshness signals, page kind) — plus scan-scoped findings.
-- gap_findings stays run-scoped by design (a technical scan is not a
-- measurement run), so findings get their own table mirroring its shape and
-- promoting into the SAME task queue.

-- +migrate up

create table site_scans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  domain text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  scanner_version text not null,
  -- Fetch status, per-crawler root access, sitemap refs — the robots facts
  -- the findings were derived from, frozen with the scan.
  robots jsonb,
  sitemaps jsonb,
  pages_fetched int not null default 0,
  notes text[] not null default '{}',
  error text,
  started_by uuid references users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index site_scans_project_idx on site_scans (project_id, created_at desc);

create table site_pages (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references site_scans(id),
  project_id uuid not null references projects(id),
  url text not null,
  final_url text,
  discovered_via text not null
    check (discovered_via in ('sitemap', 'crawl', 'homepage')),
  http_status int,
  ok boolean not null default false,
  fetch_error text,
  -- page-classifier-v1 output; free text + version so the enum can evolve
  -- without a migration (the jobs.type precedent).
  page_kind text,
  classifier_version text,
  importance int,
  title text,
  canonical_url text,
  meta_robots text,
  x_robots_tag text,
  -- null = unknown (page not fetched / not HTML), never a guessed negative.
  noindex boolean,
  in_sitemap boolean not null default false,
  sitemap_lastmod text,
  text_length int,
  latest_year_referenced int,
  -- Same-host outlinks [{url, anchor}], capped at scan time. Inlink counts
  -- and the orphan check are DERIVED on read from these edges.
  outlinks jsonb not null default '[]'::jsonb,
  -- Compact JSON-LD blocks relevant to the real-estate taxonomy; raw enough
  -- to reproduce the schema findings, never the whole HTML body.
  jsonld jsonb,
  jsonld_error text,
  checked_at timestamptz not null default now(),
  unique (scan_id, url)
);
create index site_pages_project_idx on site_pages (project_id, checked_at desc);

create table site_findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  scan_id uuid not null references site_scans(id),
  page_id uuid references site_pages(id),
  check_type text not null,
  -- Severity = how wrong the technical condition is. Priority (below) = how
  -- worth fixing it is. Deliberately separate (spec 088).
  severity text not null
    check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  observation text not null,
  inference text,
  recommendation text not null,
  detail jsonb not null default '{}'::jsonb,
  priority_score numeric not null,
  priority_band text not null
    check (priority_band in ('do_now', 'do_next', 'test', 'low_priority')),
  scanner_version text not null,
  status text not null default 'open'
    check (status in ('open', 'task_created', 'dismissed')),
  task_id uuid references tasks(id),
  created_at timestamptz not null default now()
);
create index site_findings_project_idx on site_findings (project_id, status);
-- One finding per check per page per scan (scan-level checks have no page).
create unique index site_findings_dedup on site_findings
  (scan_id, check_type,
   coalesce(page_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Technical tasks must clear the same evidence gate as every other task —
-- with real refs, so the kinds vocabulary learns the two scan objects.
-- Base list = 007 plus 'url' (added by 008 — claims cite the web).
alter table evidence drop constraint evidence_kind_check;
alter table evidence add constraint evidence_kind_check check (kind in
  ('response', 'mention', 'score', 'source', 'report', 'url',
   'site_page', 'site_scan'));

-- +migrate down
delete from evidence where kind in ('site_page', 'site_scan');
alter table evidence drop constraint evidence_kind_check;
alter table evidence add constraint evidence_kind_check check (kind in
  ('response', 'mention', 'score', 'source', 'report', 'url'));
drop table site_findings;
drop table site_pages;
drop table site_scans;
