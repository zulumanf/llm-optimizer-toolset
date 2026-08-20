# Spec 092 — Email Open Tracking (and HTML outbound bodies)

**Status:** In progress
**Branch:** `feat/092-email-open-tracking`
**Source:** Operator request 2026-08-19 ("I want to see the number of email
opens too"), reversing spec 091's out-of-scope note that pixels would never
ship. The operator decision overrides that editorial stance; the reversal is
recorded in DECISIONS.md. The platform's answer to the noise problem is not
to refuse the metric but to present it honestly.

## Why

The audit-view signal (already live) tells us when a prospect clicks through;
the operator also wants the weaker upstream signal — did the email get opened
at all. The only mechanism the medium allows is a tracking pixel (JavaScript
never executes in mail clients), and a pixel requires an HTML body, which the
Gmail adapter does not yet produce (`outstandingWork`: plain text only). So
this spec ships two things: multipart HTML outbound mail, and per-send open
counting with the caveats surfaced in the UI, not hidden.

## Honesty constraints (non-negotiable)

- **Opens are an upper bound and the UI must say so.** Apple Mail prefetches
  images whether or not a human opened; Gmail proxies all image loads. The
  metric renders with the hint "inflated by mail-client prefetching — treat
  as an upper bound; audit views are the real intent signal."
- **Raw events are evidence.** `outreach_email_opens` is insert-only
  (forbid_mutation), storing `opened_at`, `ip`, `user_agent` as received.
  Interpretation (proxy flags, dedup) happens at read time and can be
  revised; the raw rows cannot.
- **The pixel changes nothing about gating.** `body_hash` remains the sha256
  of subject + the PLAIN-TEXT body — the human-approved artifact. The HTML
  part is a mechanical rendering of that exact text plus the pixel; it embeds
  no content of its own.
- **No tracking without a send ledger row.** The token is minted per send and
  stored on the ledger row at insert; an unknown or missing token records
  nothing (and still serves the pixel, leaking no validity signal).

## 1. Migration 087

```sql
alter table prospect_outreach_sends add column open_token text unique;
create table outreach_email_opens (
  id uuid primary key default gen_random_uuid(),
  send_id uuid not null references prospect_outreach_sends(id),
  opened_at timestamptz not null default now(),
  ip text,
  user_agent text
);
-- insert-only trigger; index on (send_id, opened_at)
-- down: drop table, drop column (open tokens are operational, not evidence;
-- the opens TABLE refuses to drop is wrong — evidence — so down refuses
-- while opens rows exist? No: migrations must be reversible; the guard is
-- the same as 086 — down is tested on empty schema, and prod never rolls
-- back through data-bearing evidence tables without a DECISIONS entry.)
```

`open_token` is set at insert time (the ledger stays insert-only — no UPDATE
ever). Existing rows keep null → their sends were never tracked; renders as
"not tracked", never as zero opens (AI rule: absence of data ≠ zero).

## 2. HTML multipart in the Gmail adapter

`encodeMessage` gains an optional `htmlBody`; when present it emits
`multipart/alternative` (text/plain first, text/html second, quoted layering
per RFC 2046). `email.create_draft` and `email.send_approved_message` accept
an optional `htmlBody` input and pass it through. Plain-text-only callers are
byte-for-byte unchanged. The adapter's `outstandingWork` note about plain
text drops.

## 3. Send path

- `sendProspectDraft`, for transmitting channels with a configured `APP_URL`:
  mint `open_token` (32 hex chars, crypto-random), build the HTML part —
  escaped plain body with `<br>` line breaks (shared `escapeHtml` moves to
  `lib/text/html.ts`; `lib/plans/export.ts` imports it — no duplication) plus
  `<img src="{APP_URL}/api/open/{token}" width="1" height="1" alt="">` — and
  pass both to the channel. The ledger insert stores the token.
- No `APP_URL` → send goes out untracked (plain text only, token null).
  Tracking is telemetry; it must never block or fail a send.
- `manual`/`mock` channels: unchanged, never tracked.

## 4. The pixel endpoint — `app/api/open/[token]/route.ts`

Route handler (public GET; the "route handlers only for webhooks/cron" rule
gets the same exception as `/audit/[token]` — an unauthenticated public
surface cannot be a server action; recorded in DECISIONS). Behavior:

- Always 200 with a 1×1 transparent GIF and `Cache-Control: no-store`
  (a cached pixel would swallow repeat opens).
- Token matches a ledger row → insert an open row (ip from
  `x-forwarded-for`, user agent as received). No match → serve the GIF and
  record nothing. Never an error, never a redirect.

## 5. Surfacing

- `listDrafts` gains `openCount` and `lastOpenedAt` (lateral join
  ledger → opens on the draft's sends).
- The draft card on the prospect page shows "opened N× · last {time}" when
  tracked and opened, "no opens recorded" when tracked and silent, and
  nothing when untracked — with the upper-bound hint on the metric.

## Out of scope

- Click tracking via link rewriting (the audit link IS the click signal, and
  rewriting links hurts deliverability and trust).
- Proxy/prefetch classification heuristics (raw UA is stored; a later read-
  time classifier can be added without touching evidence).
- Open tracking for the automation-layer sequences stack (same boundary as
  spec 091).

## Acceptance criteria

- [ ] A gmail send with APP_URL set transmits multipart/alternative whose
      text part is the approved body and whose HTML part carries the pixel
      URL with the ledger row's token (test, connector mocked).
- [ ] body_hash is computed on the plain-text body, unchanged from 091
      (test).
- [ ] Without APP_URL the send still transmits, untracked (test).
- [ ] GET /api/open/{token} serves the GIF and inserts an open row; an
      unknown token serves the GIF and inserts nothing (tests).
- [ ] Opens rows reject UPDATE/DELETE at the database level (test).
- [ ] listDrafts reports openCount/lastOpenedAt; untracked sends render as
      "not tracked", not zero (test + UI).
- [ ] Migration 087 reversible on an empty schema (rides the down/up cycle
      test).
- [ ] Lint, typecheck, full suite pass.
