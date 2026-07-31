-- +migrate up
-- Phase 0.4 (docs/implementation-roadmap.md): the 2026-07-31 audit found
-- three tables aggregating data ACROSS clients on globally-unique natural
-- keys. `sources.citation_count` and `brand_candidates.hit_count` blended
-- every client's runs into one counter, and `evidence` — the table every
-- evidence_ids[] array points into — had no tenant column at all, so a
-- cross-client evidence attachment was unconstrained and undetectable.
--
-- Each table gains a nullable project_id. Nullable is deliberate: historical
-- rows whose project cannot be derived with certainty stay null ("legacy,
-- unattributed") rather than being guessed — a wrong tenant label is worse
-- than an honest missing one. New writes always carry the project.

-- ---------------------------------------------------------------- evidence
alter table evidence add column project_id uuid references projects(id);
create index evidence_project_idx on evidence (project_id);

-- Backfill from what each ref actually points at. Every kind except 'url'
-- resolves to a project through its parent chain; 'url' evidence (claims
-- citing the web) is reached only through project-scoped claims, so it is
-- backfilled through the claims that reference it.
update evidence e set project_id = r.project_id
  from responses resp join runs r on r.id = resp.run_id
  where e.kind = 'response' and e.ref_id = resp.id;
update evidence e set project_id = r.project_id
  from mentions m join responses resp on resp.id = m.response_id
    join runs r on r.id = resp.run_id
  where e.kind = 'mention' and e.ref_id = m.id;
update evidence e set project_id = r.project_id
  from scores s join runs r on r.id = s.run_id
  where e.kind = 'score' and e.ref_id = s.id;
update evidence e set project_id = rep.project_id
  from reports rep where e.kind = 'report' and e.ref_id = rep.id;
update evidence e set project_id = c.project_id
  from claims c
  where e.project_id is null and e.id = any(c.evidence_ids);

-- ------------------------------------------------------------------ sources
alter table sources add column project_id uuid references projects(id);

-- A URL is attributed to a project only when exactly one project's current
-- mentions cite it. Ambiguous or never-attributed URLs stay null.
with owners as (
  select s.id as source_id, r.project_id
  from sources s
  join mentions m on s.url = any(m.cited_urls)
  join responses resp on resp.id = m.response_id
  join runs r on r.id = resp.run_id
  group by s.id, r.project_id
), unique_owners as (
  select source_id, min(project_id::text)::uuid as project_id
  from owners
  group by source_id
  having count(distinct project_id) = 1
)
update sources s set project_id = u.project_id
  from unique_owners u where s.id = u.source_id;

-- Per-project registry going forward: the same URL may exist once per
-- project, each with its own counter. Legacy null-project rows keep their
-- historical (cross-client) counts but no longer absorb new citations —
-- the parse upsert now targets (project_id, url).
alter table sources drop constraint sources_url_key;
create unique index sources_project_url_unique
  on sources (project_id, url) where project_id is not null;
create index sources_project_idx on sources (project_id);

-- --------------------------------------------------------- brand_candidates
alter table brand_candidates add column project_id uuid references projects(id);

-- first_seen_run_id names the run — and therefore the client — whose
-- responses first surfaced the candidate.
update brand_candidates b set project_id = r.project_id
  from runs r where b.first_seen_run_id = r.id;

alter table brand_candidates drop constraint brand_candidates_normalized_key;
create unique index brand_candidates_project_normalized_unique
  on brand_candidates (project_id, normalized) where project_id is not null;
create index brand_candidates_project_idx on brand_candidates (project_id);

-- +migrate down
-- Lossy by necessity: multiple projects may now hold the same URL or
-- normalized name, which the old global unique constraints forbid. The down
-- migration keeps one row per natural key (lowest id) so the constraint can
-- be restored; the dropped rows' counters are lost, as recorded here.
delete from sources s using sources keep
  where s.url = keep.url and keep.id < s.id;
alter table sources drop column project_id;
alter table sources add constraint sources_url_key unique (url);

delete from brand_candidates b using brand_candidates keep
  where b.normalized = keep.normalized and b.id <> keep.id
    and keep.id < b.id;
alter table brand_candidates drop column project_id;
alter table brand_candidates add constraint brand_candidates_normalized_key unique (normalized);

alter table evidence drop column project_id;
