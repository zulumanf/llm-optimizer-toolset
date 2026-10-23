-- Spec 155: client self-service onboarding and question review. Additive.
--
-- client_onboardings is working state only (what the operator prepared, what
-- the client changed, which step they reached). The outcome lands in the
-- existing ledgers: engagement_context_items and engagement_client_decisions.
-- client_question_reviews is the append-only per-question review trail.

-- +migrate up
create table client_onboardings (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null unique references client_engagements(id),
  project_id uuid not null references projects(id),
  status text not null default 'draft' check (status in ('draft', 'ready', 'completed')),
  prepared_priorities jsonb not null default '{}'::jsonb,
  prepared_contacts jsonb not null default '{}'::jsonb,
  client_priorities jsonb,
  client_contacts jsonb,
  prepared_by uuid references users(id),
  ready_at timestamptz,
  priorities_confirmed_at timestamptz,
  priorities_confirmed_by uuid references users(id),
  completed_at timestamptz,
  completed_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_onboardings_ready_stamped check (status = 'draft' or ready_at is not null),
  constraint client_onboardings_completed_stamped check (
    status <> 'completed' or (completed_at is not null and completed_by is not null and priorities_confirmed_at is not null)
  )
);

create or replace function client_onboarding_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'client_onboardings rows are never deleted (spec 155)';
  end if;
  if old.status = 'completed' then
    raise exception 'a completed client onboarding is immutable (spec 155)';
  end if;
  return new;
end $$;
create trigger client_onboardings_guard
  before update or delete on client_onboardings
  for each row execute function client_onboarding_guard();

create table client_question_reviews (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  prompt_set_version_id uuid not null references prompt_set_versions(id),
  prompt_id uuid not null,
  decision text not null check (decision in ('approved', 'edit_requested', 'removed')),
  comment text not null default '',
  decided_by uuid not null references users(id),
  client_actor text not null check (length(trim(client_actor)) > 0),
  decided_at timestamptz not null default now()
);
create index client_question_reviews_idx
  on client_question_reviews (prompt_set_version_id, prompt_id, decided_at desc);
create trigger client_question_reviews_immutable
  before update or delete on client_question_reviews
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger client_question_reviews_immutable on client_question_reviews;
drop table client_question_reviews;
drop trigger client_onboardings_guard on client_onboardings;
drop function client_onboarding_guard();
drop table client_onboardings;
