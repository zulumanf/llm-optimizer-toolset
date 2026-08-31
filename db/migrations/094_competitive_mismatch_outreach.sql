-- +migrate up
-- Spec 124: competitive-mismatch outreach template + reply classification.
--
-- evidence_snapshot: the exact facts a mismatch draft's body asserts
-- (production evidence signal ids, run id, OpenAI-only recommendation
-- counts and denominator, thresholds, template id), captured at generation
-- so the sent claim stays auditable even as newer data arrives. Frozen at
-- approval by the same trigger that freezes the body.
alter table outreach_drafts add column evidence_snapshot jsonb;

create or replace function forbid_approved_outreach_draft_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on an outreach draft is forbidden: drafts are versioned, not erased';
  end if;
  if old.status = 'approved' then
    if new.subject is distinct from old.subject
      or new.body is distinct from old.body
      or new.cta is distinct from old.cta
      or new.tone is distinct from old.tone
      or new.channel is distinct from old.channel
      or new.prospect_id is distinct from old.prospect_id
      or new.finding_id is distinct from old.finding_id
      or new.evidence_snapshot is distinct from old.evidence_snapshot
      or new.approved_by is distinct from old.approved_by
      or new.approved_at is distinct from old.approved_at then
      raise exception 'approved outreach drafts are immutable: edit by creating a new version (spec 032)';
    end if;
  end if;
  return new;
end;
$$;

-- Reply ledger (spec 124): the first record of what a reply actually said.
-- Insert-only — a misclassification is corrected by recording a new row,
-- never by rewriting history. Ingestion is operator-recorded today; an
-- automated Gmail path can insert here later without a schema change.
create table prospect_replies (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  contact_id uuid references prospect_contacts(id),
  send_id uuid references prospect_outreach_sends(id),
  body_text text not null check (char_length(body_text) <= 20000),
  received_at timestamptz not null,
  classification text not null check (classification in
    ('positive_interest', 'question', 'objection', 'proof_request',
     'referral', 'not_interested', 'unsubscribe', 'out_of_office', 'unclear')),
  classifier_version text not null,
  recorded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index prospect_replies_prospect_idx on prospect_replies (prospect_id, received_at);

create function forbid_prospect_reply_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'prospect_replies is insert-only: record a new row to correct a classification';
end;
$$;
create trigger prospect_replies_immutable
  before update or delete on prospect_replies
  for each row execute function forbid_prospect_reply_mutation();

-- +migrate down
drop trigger prospect_replies_immutable on prospect_replies;
drop function forbid_prospect_reply_mutation();
drop table prospect_replies;

create or replace function forbid_approved_outreach_draft_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on an outreach draft is forbidden: drafts are versioned, not erased';
  end if;
  if old.status = 'approved' then
    if new.subject is distinct from old.subject
      or new.body is distinct from old.body
      or new.cta is distinct from old.cta
      or new.tone is distinct from old.tone
      or new.channel is distinct from old.channel
      or new.prospect_id is distinct from old.prospect_id
      or new.finding_id is distinct from old.finding_id
      or new.approved_by is distinct from old.approved_by
      or new.approved_at is distinct from old.approved_at then
      raise exception 'approved outreach drafts are immutable: edit by creating a new version (spec 032)';
    end if;
  end if;
  return new;
end;
$$;

alter table outreach_drafts drop column evidence_snapshot;
