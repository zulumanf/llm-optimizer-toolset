# Spec 125 — Open-signal classification + reply visibility

## Problem
1. Open metrics count every beacon fire; ~17 sends are "opened" only by security
   scanners (bare `Mozilla/5.0` UA), inflating open rate from ~54% to 70%.
2. `prospect_replies` is operator-recorded and has zero rows; replies sitting in
   the Gmail inbox are invisible to every surface.

## Part 1 — read-time open classification
Raw rows stay immutable (migration 087 contract). Interpretation moves into a
view created by migration 097:

- `outreach_open_signal` = `outreach_email_opens` + `signal_class`:
  - `scanner` — UA null or exactly `Mozilla/5.0` (security gateways/link checkers)
  - `proxy` — UA contains `GoogleImageProxy`/`ggpht` (Gmail fetches on open → credible)
  - `browser` — anything else (real client UAs)
- A "signal open" is `signal_class <> 'scanner'`.
- All read paths that count opens (prospects dashboard, prospect detail,
  assistant tools) count signal opens via the view. Raw rows remain queryable.
- `OPEN_SIGNAL_VERSION = 'open-signal-v1'` in `lib/prospects/constants.ts`
  documents the heuristic version (future revisions bump it; history unchanged).

Out of scope (future v2): cross-send burst/sweep detection (e.g. the
2026-08-24 20:19Z 10-send Google-proxy burst).

## Part 2 — reply visibility (minimum viable)
`scripts/reply-check.ts` (reusable, not dated):
- Loads all distinct recipient emails from allowed gmail sends.
- Uses the platform Gmail connection to search the inbox for messages from
  those addresses (default `newer_than:14d`, override with `--days N`).
- Prints each candidate reply matched to prospect/contact/latest send.
- `--record` fetches the plain-text body and records each via
  `recordProspectReply` (spec 124 auto-classification + unsubscribe
  suppression), skipping messages already recorded (same prospect, received_at
  within ±3 min).
- Also surfaces mailer-daemon bounces (report only).

Real fix (Gmail ingestion worker, spec 099) remains open; this closes the
blind spot until then.

## Acceptance
- Migration 097 up/down clean.
- Dashboard/detail/assistant open counts exclude scanner-only opens.
- `npx tsx scripts/reply-check.ts` lists inbox replies; `--record` writes
  `prospect_replies` rows idempotently.
