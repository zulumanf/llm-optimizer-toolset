-- +migrate up
-- Interventions reach the client portal, but unlike tasks (031) they had no
-- visibility flag — internal work titles went out verbatim (production-
-- readiness plan 4.1). Same rule as tasks: nothing becomes client-facing
-- by accident; an operator flips each intervention deliberately.
alter table interventions add column client_visible boolean not null default false;

-- +migrate down
alter table interventions drop column client_visible;
