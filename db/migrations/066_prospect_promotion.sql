-- +migrate up
-- Spec 057: the close finally has a side effect. Records which client
-- project a contracted prospect became — the promotion converts the
-- benchmark project in place (kind prospect -> client), so the pre-signing
-- baseline is the client's first comparable prior instead of an orphan.
alter table prospects add column promoted_project_id uuid references projects(id);
create index prospects_promoted_idx
  on prospects (promoted_project_id) where promoted_project_id is not null;

-- +migrate down
drop index prospects_promoted_idx;
alter table prospects drop column promoted_project_id;
