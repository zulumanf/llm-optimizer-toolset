-- +migrate up
-- Spec 060 chore: the gap view always orders by (acvs desc nulls last,
-- domain) within a project; without this index every page load sorts the
-- project's full opportunity set.
create index citation_opportunities_project_acvs_idx
  on citation_opportunities (project_id, acvs desc nulls last, domain asc);

-- +migrate down
drop index citation_opportunities_project_acvs_idx;
