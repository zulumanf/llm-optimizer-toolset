-- +migrate up
-- Branded audit links (spec 076): /audit/<slug>/<key> where the slug is the
-- prospect's kebab-cased name (cosmetic) and the 16-char key (96 bits,
-- base64url) is the credential. The link points at the PROSPECT — it always
-- resolves to their current published audit, so supersede (057) and refresh
-- (075) never break an emailed link. Legacy /audit/<token> URLs are
-- untouched and permanent. One active link per prospect; revocation is a
-- tombstone (revoked_at), never a delete — burned links must stay burned.

create table prospect_audit_links (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  slug text not null,
  key text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index prospect_audit_links_key_unique on prospect_audit_links (key);
create unique index prospect_audit_links_one_active
  on prospect_audit_links (prospect_id) where revoked_at is null;
create index prospect_audit_links_prospect_idx on prospect_audit_links (prospect_id);

-- +migrate down
drop index prospect_audit_links_prospect_idx;
drop index prospect_audit_links_one_active;
drop index prospect_audit_links_key_unique;
drop table prospect_audit_links;
