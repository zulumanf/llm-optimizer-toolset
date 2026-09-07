# Spec 134 — Private report access: invitation → session → clean URL

## Problem
Private prospect reports are opened at `/audit/<slug>/<16-char key>`. The key in the
address bar reads as a tracking link and is the only thing standing between the
report and the public. Forwarding works (any holder of the key gets in) but the
credential stays visible for the whole visit, and "viewed" is a page-load count.

## Access model
PRIVATE INVITATION → AUTHORIZED SESSION → CLEAN REPORT URL

- **Invitation** = the existing branded key (`prospect_audit_links.key`, 96 bits,
  one active per prospect, burned by `revokeAudit`) or a legacy 43-char audit
  token. Route: `GET /report/<slug>/<key>`.
- **Exchange**: validate key → published, unexpired audit → not revoked → below the
  session allowance → mint a session (random 256-bit token, SHA-256 stored) →
  `Set-Cookie` (HttpOnly, Secure in prod, SameSite=Lax, path `/report/<slug>`) →
  303 to `/report/<slug>`. The key never appears after the redirect.
- **Clean URL** `GET /report/<slug>` renders only with a valid session for THAT
  prospect; otherwise the generic private-report state (404). Sub-pages
  `/answers` and `/walkthrough` follow the same rule.
- **Sharing**: a forwarded invitation activates its own session in the new browser.
  Allowance = `prospect_audit_links.session_allowance` (default
  `REPORT_SESSION_ALLOWANCE`, 5). Only sessions that reached the report count; a
  session that is never used expires in 15 minutes (mail scanners).
- **Revocation**: `revokeAudit` also revokes sessions. New operator action
  `revokeReportAccess` burns the invitation + sessions while the audit stays
  published so a fresh invitation can be minted.
- **Expiry**: audit `expires_at` (existing) gates every request; sessions expire
  `REPORT_SESSION_TTL_DAYS` (30) after activation.

## Slugs
`prospects.report_slug` — unique, lowercase, URL-safe, presentation only. Base =
kebab-cased business name; collision → `-<market>`; still colliding → `-2`, `-3`.
Backfilled by migration 107 for every prospect with an audit.

## Legacy
`/audit/<token>` and `/audit/<slug>/<key>` (plus `/answers`, `/walkthrough`) keep
working: they validate as before, then redirect through the exchange to the clean
URL. Nothing is resent; historical drafts and sends are untouched.

## Analytics
`prospect_audit_views.session_id` ties each view to its session. Events table
`prospect_report_access_events` (insert-only): `invitation_opened`,
`access_granted`, `session_created`, `access_refused`. Metrics per prospect:
`reportDeliveredAt`, `firstExternalAccessAt`, `firstExternalViewAt`,
`externalSessionCount`, `totalExternalViews`, `lastExternalViewAt`. Internal =
staff session at exchange time or an `INTERNAL_VIEW_IPS` address; internal
sessions never count toward the allowance or the metrics.

## Headers / leakage
`/report/*` and `/audit/*`: `X-Robots-Tag: noindex, nofollow, noarchive`,
`Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`. Structured
logs redact any `/audit/…/<key>` or `/report/…/<key>` path segment.

## Email
Report delivery (spec 129) links to the invitation URL. Gmail sends already emit
multipart/alternative; the HTML part renders the invitation as
"Private report for <business>", the text part keeps the full URL. Cold T1/T2/T3
templates are untouched.

## Out of scope
Passwords, codes, accounts, fingerprinting, client-portal auth changes.
