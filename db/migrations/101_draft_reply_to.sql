-- Spec 128: a human-composed reply to a specific recorded reply. Naming the
-- reply lets the scheduled-send worker transmit it past the "no unattended
-- send after a reply" gate (it continues the conversation the prospect
-- started, not a sequence past it) and lets dispatch thread it under the
-- prospect's own message.

-- +migrate up
alter table outreach_drafts add column reply_to_id uuid references prospect_replies(id);

-- +migrate down
alter table outreach_drafts drop column reply_to_id;
