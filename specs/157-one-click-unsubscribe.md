# Spec 157 — One-click unsubscribe for outreach email

> **Status:** implemented (2026-10-21), not deployed. Branch `feat/157-one-click-unsubscribe`, stacked on `feat/151-platform-v2`.

## Why

Prospect outreach goes out through Gmail. Today a recipient can opt out only by **replying "unsubscribe"**.

- Gmail and Yahoo require bulk senders to support **one-click unsubscribe** (RFC 8058: `List-Unsubscribe` plus `List-Unsubscribe-Post` headers, honoured with an HTTP POST).
- Without it, mail is more likely to land in spam, and the "Unsubscribe" button that mail clients show next to the sender never appears.
- The Gmail adapter can already write both headers (`lib/connectors/adapters/google.ts`), but nothing passes it a URL.

## Audience

| Surface | Audience | Visibility |
|---|---|---|
| `POST /api/unsubscribe/[token]` | Mail providers acting for the recipient (RFC 8058 one-click) | Public, unauthenticated; token is the credential |
| `GET /api/unsubscribe/[token]` | Older mail clients that open the header URL in a browser | Redirects to the page; never unsubscribes |
| `/unsubscribe/[token]` | The prospect (recipient) | Public page; confirm button; reveals nothing about the token |

Prospect-facing copy follows `prospect-voice`.

## Behaviour

1. **Token issue.** For every **allowed** Gmail send, the send path issues a fresh random token (32 hex characters).
   - It is stored in a new insert-only table `outreach_unsubscribe_tokens` (token, normalized recipient email, prospect, draft, created_at).
   - The token is written **outside** the send transaction and **before** dispatch. The link in a delivered message must keep working even if the ledger transaction later rolls back.
2. **Headers.** The Gmail channel passes `unsubscribeUrl = APP_URL/api/unsubscribe/<token>`. The adapter then emits:
   - `List-Unsubscribe: <url>`
   - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
3. **Gate.** A new send-gate check, `one_click_unsubscribe`, applies to the Gmail channel, the only real transmitting channel. The CI-only `mock` channel is not gated.
   - It passes only when `APP_URL` is configured, because without it no working link can be built.
   - The gate version moves to `prospect-send-gate-v5`.
   - Manual and mock channels are unaffected.
   - This reverses spec 092's "no APP_URL → send untracked, never blocked" for Gmail: without APP_URL a compliant link is impossible, so the send refuses.
4. **Redemption (POST).** A POST with a known token adds a **global email suppression** with reason `opt_out` and detail `One-click unsubscribe (spec 157).`.
   - This is the same `suppress()` path the reply classifier uses (spec 124), audited with no user.
   - It is idempotent: a second POST is a no-op.
   - Every subsequent send to that address is refused by the existing `suppression` gate check, follow-ups included.
5. **No oracle.** Known, unknown and malformed tokens get the **same** response.
   - RFC 8058 one-click: `200 text/plain`.
   - Browser form: `303` to `/unsubscribe/<token>?done=1`.
   - A redemption failure is logged and still returns the same response.
6. **GET never unsubscribes.** Link scanners and prefetchers issue GETs. `GET /api/unsubscribe/<token>` returns `303` to `/unsubscribe/<token>`.
7. **The page.** `/unsubscribe/<token>` shows one sentence and a single confirm button (a plain HTML form POST, no client JS).
   - After confirming (`?done=1`) it shows a confirmation.
   - It never shows the recipient's address or anything about the token's validity.
8. **Public paths.** `/unsubscribe` and `/api/unsubscribe` are added to the middleware's public prefixes.

## Out of scope

- Changing the approved body text or footer. The reply-"unsubscribe" instruction stays, and body hashes and approvals are unchanged.
- Unsubscribe for client-facing mail. There is none on this path.
- Lifting suppressions: staff already have `liftSuppression`.

## Schema

`db/migrations/135_outreach_unsubscribe_tokens.sql` (additive, reversible).

- Table `outreach_unsubscribe_tokens`:
  - `token text primary key` (checked to be 32 hex characters);
  - `recipient_email text not null`;
  - `prospect_id uuid` and `draft_id uuid`, as provenance **without foreign keys**. The send transaction holds the draft row `for update`, so a foreign-key check from this independent insert would wait on it: a self-deadlock, reproduced during implementation;
  - `created_at timestamptz not null default now()`.
- An insert-only trigger (no UPDATE, no DELETE).
- The down section uses `rf_refuse_destructive_down`: it refuses while tokens exist, unless run with `--allow-destructive-down`.

## Acceptance criteria

- [x] An allowed Gmail send issues a token and passes `unsubscribeUrl`; the outgoing message carries both RFC 8058 headers.
- [x] A token row survives a rollback of the send transaction.
- [x] A Gmail send without `APP_URL` is refused by `one_click_unsubscribe`, and the refusal is ledgered.
- [x] POST with the one-click body suppresses the address globally (`opt_out`, audited); a repeat POST is a no-op; the next send to that address is refused by `suppression`.
- [x] Unknown and malformed tokens get the same status and body as a valid one, and nothing is written.
- [x] GET never suppresses; it redirects to the page.
- [x] The page renders without a session, shows no address, and its form posts to the endpoint.
- [x] Migration 135 applies, rolls back (refusing while tokens exist) and re-applies.
- [x] tsc, lint and the affected test suites pass.
