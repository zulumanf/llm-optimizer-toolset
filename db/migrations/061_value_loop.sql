-- +migrate up
-- Spec 051: close the loop intervention → live verification → retest →
-- verdict → evidence → client report.

-- Live verification (audit F11): nothing checked that a shipped
-- intervention's URLs are actually live. Append-only — re-checks add rows,
-- latest-per-URL is the current state; history is evidence.
create table url_verifications (
  id uuid primary key default gen_random_uuid(),
  intervention_id uuid not null references interventions(id),
  url text not null,
  ok boolean not null,
  http_status int,
  note text,
  checked_at timestamptz not null default now()
);
create index url_verifications_intervention_idx
  on url_verifications (intervention_id, url, checked_at desc);
create trigger url_verifications_immutable
  before update or delete on url_verifications
  for each row execute function forbid_mutation();

-- Lifecycle fields (audit F1): who owns it and what it cost. Nullable —
-- historical interventions predate the record.
alter table interventions add column owner_id uuid references users(id);
alter table interventions add column cost_usd numeric;

-- Accuracy findings stop self-certifying (audit F10): 'corrected' was set
-- at task CREATION, before anyone touched anything. fix_in_progress is the
-- honest intermediate state; corrected now requires the linked task done.
alter table accuracy_findings drop constraint accuracy_findings_status_check;
alter table accuracy_findings add constraint accuracy_findings_status_check
  check (status in ('open', 'acknowledged', 'dismissed', 'fix_in_progress', 'corrected'));

-- Delivery ledger (audit F28): "was this report ever sent, to whom, when"
-- had no answer. The operator's mail client stays the transport (no ESP
-- decision preempted — same pattern as the prospect manual channel); the
-- ledger is insert-only because a delivery record is a receipt.
create table report_deliveries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports(id),
  channel text not null check (channel in ('manual_email', 'portal', 'other')),
  recipient text not null,
  note text,
  delivered_by uuid references users(id),
  delivered_at timestamptz not null default now()
);
create index report_deliveries_report_idx on report_deliveries (report_id);
create trigger report_deliveries_immutable
  before update or delete on report_deliveries
  for each row execute function forbid_mutation();

-- +migrate down
drop table report_deliveries;
update accuracy_findings set status = 'corrected' where status = 'fix_in_progress';
alter table accuracy_findings drop constraint accuracy_findings_status_check;
alter table accuracy_findings add constraint accuracy_findings_status_check
  check (status in ('open', 'acknowledged', 'dismissed', 'corrected'));
alter table interventions drop column cost_usd;
alter table interventions drop column owner_id;
drop table url_verifications;
