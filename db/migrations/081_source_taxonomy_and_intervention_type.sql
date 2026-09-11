-- Spec 086: real-estate source taxonomy + intervention action taxonomy.
--
-- Observation provenance itself (collection method, surface, measurement
-- tier, purpose) is DERIVED from facts already stored — responses vs
-- client_validation_observations, request_params, projects.kind,
-- runs.trigger, intervention_runs.role — so it needs no columns
-- (lib/runs/provenance.ts). This migration covers the two facts that are
-- not derivable.

-- +migrate up

-- 1. Widen the citation-source taxonomy for the real-estate vertical.
-- v1 folded RealTrends into 'news'/'other', erasing exactly the distinction
-- the authority-vs-visibility diagnosis runs on: an industry ranking is
-- independent authority evidence; local press is the acquirable third-party
-- surface competitors get cited from.
alter table sources drop constraint sources_source_type_check;
alter table sources add constraint sources_source_type_check check (source_type in (
  'client_site', 'brokerage', 'portal', 'news', 'directory', 'social',
  'video', 'review', 'government', 'industry_ranking', 'local_press', 'other'
));

-- 2. Intervention action taxonomy. Nullable: legacy rows stay unlabeled,
-- never guessed. Lets learnings/action_outcomes group by what KIND of GEO
-- action shipped, which the learning loop needs before it can say anything
-- about which action types appear to work.
alter table interventions add column intervention_type text check (intervention_type in (
  'entity_page_created', 'schema_updated', 'authority_page_created',
  'citation_acquired', 'third_party_profile_updated', 'press_mention_acquired',
  'ranking_page_inclusion', 'local_content_created',
  'neighborhood_content_created', 'building_content_created',
  'review_profile_updated', 'internal_linking_changed',
  'technical_accessibility_fix', 'crawler_access_change', 'other'
));

-- +migrate down
alter table interventions drop column intervention_type;
-- Rows classified with the v2-only types return to unclassified (never
-- silently remapped to a v1 type they are not).
update sources
  set source_type = null, classifier_version = null, classified_at = null
  where source_type in ('industry_ranking', 'local_press');
alter table sources drop constraint sources_source_type_check;
alter table sources add constraint sources_source_type_check check (source_type in (
  'client_site', 'brokerage', 'portal', 'news', 'directory', 'social',
  'video', 'review', 'government', 'other'
));
