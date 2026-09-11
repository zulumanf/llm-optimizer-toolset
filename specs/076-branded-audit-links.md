# Spec 076 — Branded Audit Links

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/032 (prospect acquisition; token = the access control), specs/057 stable audit links, specs/075 (refresh queue — links must survive supersede)
> Branch: feat/076-branded-audit-links

## Why

The operator is about to email 14 Jersey City prospects a link to their
audit. Today that link is `/audit/<43 random characters>` — secure, but the
first thing a recipient reads is noise. A link that leads with *their own
name* reads as "this was made for me", which is the audit's whole pitch.

A pure vanity URL (`/audit/nk-real-estate-group`) is forbidden by the
security model: the high-entropy token IS the access control (spec 032,
docs/10), and a guessable path would let anyone enumerate team names and
read competitive claims about businesses that never consented. The design
below keeps the lock and adds the name.

## Goal

Every published audit can carry a branded link:

```
/audit/nk-real-estate-group/kJ8fQ2xLmN4pR7sT        (slug + 16-char key)
```

The slug is cosmetic; the 16-character key (96 bits, base64url) is the
credential. Legacy 43-character `/audit/[token]` links keep working
unchanged, forever. The branded link always resolves to the prospect's
**current published audit**, so spec-075 refreshes and spec-057 supersedes
never break an emailed link.

## Design

### Table: `prospect_audit_links` (migration, next free number)

- `id uuid pk`, `prospect_id → prospects`, `slug text not null`,
  `key text not null` (16 base64url chars from 12 random bytes),
  `created_by → users`, `created_at`, `revoked_at timestamptz`.
- Unique on `key` (global — key alone identifies the prospect). Partial
  unique on `(prospect_id) where revoked_at is null` — one active branded
  link per prospect. Index on `prospect_id`.
- Slug: kebab-cased business name (`[a-z0-9-]`, collapsed, trimmed, ≤80
  chars). NOT unique — identity lives in the key; two "Smith Team"s in
  different markets may share a slug harmlessly.
- Rollback: drop table. Links are access artifacts, not measurements.

### Resolution (`lib/prospects/links.ts`)

`resolveAuditLink(key)` → the active link row joined to the prospect's
current published audit's `access_token`, or null. The branded route then
renders **through the existing `getAuditByToken` path** — same expiry
check, same view logging, same operator-view labeling; one implementation
of "show an audit", two front doors.

- Wrong or stale slug with a valid key → **permanent redirect to the canonical
  slug**, key preserved. A renamed team never strands an emailed link.
- Valid slug with wrong key → 404. The slug grants nothing.

### Lifecycle

- **Mint** — `mintAuditLink(user, {prospectId})`: requires a currently
  published audit; revokes any prior active link for the prospect
  (replacing, not accumulating); inserts; audit-logs. Also **auto-minted
  inside `publishAudit`** for a prospect's FIRST publication (isolated,
  non-fatal — a mint failure must never fail a publish); supersedes keep
  the existing link by construction (it points at the prospect).
- **Burn** — `revokeAudit` (spec 032 burn-the-link) also revokes the
  prospect's active branded links in the same transaction. A burned link
  must not resurrect via republish under either format.
- **Expiry** — enforced by the audit row (`expires_at`) through
  `getAuditByToken`, identically for both formats.

### Routes

`app/audit/[slug]/[key]/page.tsx` and `.../answers/page.tsx`: thin wrappers
(resolve → redirect-if-wrong-slug → render) that DELEGATE to the existing
`[token]` page components with the resolved token — zero lines of the
900-line prospect-facing renderer moved or duplicated, and its `metadata`
(incl. `robots: noindex`) re-exported. One renderer, two front doors.

Next.js note: `/audit/[slug]/[key]` and `/audit/[token]` coexist — one vs
two path segments never collide.

### Operator surface

- `audit-actions.tsx` "Copy link" copies the **branded** URL when an active
  link exists, else the legacy token URL (label says which).
- Outreach draft generation (`lib/prospects/urls.ts` consumers) prefers the
  branded URL the same way.
- Backfill: `scripts/mint-audit-links.ts` (dry-run default, APPLY=1) mints
  links for every prospect with a published audit and prints the full URL
  list for the operator's emails.

## Out of scope

- Shortening or re-minting legacy 43-char tokens (immutable on published
  rows by trigger; they simply continue to work).
- Custom slugs chosen per-link in the UI (the generated name is the point;
  revisit on demand).
- Rate limiting on the audit route (unchanged posture; 96-bit keys keep
  online guessing infeasible).

## Acceptance criteria

- [x] A minted link `/audit/<slug>/<key>` renders the same snapshot as the
      legacy token URL, logs a view identically, and honors expiry
      (integration).
- [x] Wrong slug + right key 301s to canonical; right slug + wrong key
      404s; revoked link 404s even after a republish mints a new token
      (integration).
- [x] `publishAudit` auto-mints on first publication only; supersede keeps
      the same branded link; a mint failure does not fail the publish
      (integration).
- [x] `revokeAudit` revokes active branded links in the same transaction
      (integration).
- [x] One active link per prospect: re-minting replaces (unit/integration).
- [x] Slug generation handles punctuation, unicode, length (unit,
      known-answer).
- [x] Legacy `/audit/[token]` behavior byte-identical (existing e2e
      `audit-page.spec.ts` passes unchanged).
- [x] Copy-link control prefers the branded URL when one exists (e2e).

## Test cases

Unit: slugify fixtures; key length/alphabet. Integration: full mint →
resolve → view-log → expiry → revoke → republish matrix on the real
pipeline. E2E: branded URL renders the seeded audit; copy control shows it.

## Definition of done

All acceptance criteria pass · tests green · lint/typecheck clean ·
migration reversible · docs/05 + DECISIONS.md updated · backfill script
ready for the operator's 14 links.
