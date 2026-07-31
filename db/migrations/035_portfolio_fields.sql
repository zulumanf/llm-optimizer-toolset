-- +migrate up
-- Spec 030 (roadmap 2.7): portfolio operations fields. Both nullable — a
-- solo agency has no owner ambiguity, and tiers are optional vocabulary,
-- not required configuration.
alter table projects add column account_owner_id uuid references users(id);
alter table projects add column service_tier text
  check (service_tier in ('standard', 'premium', 'exclusive'));
create index projects_account_owner_idx on projects (account_owner_id)
  where account_owner_id is not null;

-- +migrate down
alter table projects drop column service_tier;
alter table projects drop column account_owner_id;
