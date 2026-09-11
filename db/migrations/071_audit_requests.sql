-- +migrate up
-- Spec 061: audit requests from the public marketing site. The platform's
-- only anonymous write surface: insert-only lead capture, reviewed by an
-- operator before any analysis happens (the site says so). Not a prospect
-- row — promotion into the prospects pipeline is a deliberate operator act.
create table audit_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  website text,
  market text not null,
  specialization text,
  status text not null default 'new'
    check (status in ('new', 'reviewed', 'promoted', 'declined')),
  source text not null default 'marketing_site',
  created_at timestamptz not null default now()
);

create index audit_requests_status_created_idx
  on audit_requests (status, created_at desc);

-- +migrate down
drop table audit_requests;
