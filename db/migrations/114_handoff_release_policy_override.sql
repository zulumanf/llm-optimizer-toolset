-- Spec 139 follow-up: a founder-recorded, audited per-handoff exception to
-- the global FULFILLMENT_RELEASE_POLICY (e.g. one prospect receives the
-- private report without a video walkthrough). Read by the lane and by the
-- send-time recheck; never widens autonomy (the lane mode still decides).

-- +migrate up
alter table prospect_report_handoffs
  add column release_policy_override text check (release_policy_override in ('report_only', 'report_and_video')),
  add column release_policy_override_reason text,
  add column release_policy_override_by uuid references users(id),
  add column release_policy_override_at timestamptz;

-- +migrate down
alter table prospect_report_handoffs
  drop column release_policy_override_at,
  drop column release_policy_override_by,
  drop column release_policy_override_reason,
  drop column release_policy_override;
