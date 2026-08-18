/** GEO action taxonomy (spec 086) — mirrors the migration-081 CHECK. Lets
 * the learning loop group outcomes by what KIND of action shipped. Optional
 * on creation; legacy interventions stay unlabeled, never guessed. Pure
 * constants: importable from client components. */
export const INTERVENTION_TYPES = [
  "entity_page_created",
  "schema_updated",
  "authority_page_created",
  "citation_acquired",
  "third_party_profile_updated",
  "press_mention_acquired",
  "ranking_page_inclusion",
  "local_content_created",
  "neighborhood_content_created",
  "building_content_created",
  "review_profile_updated",
  "internal_linking_changed",
  "technical_accessibility_fix",
  "crawler_access_change",
  "other",
] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];
