# Spec 165 — An ambiguous send failure is checked, never resent blind

> Status: implemented (2026-10-26), not committed
> Depends on: specs/091, specs/137
> Branch: feat/162-workflow-send-gates
> Audience: operator (internal). Affects prospect email delivery.

## Problem

A Gmail send that times out or gets a 5xx may still have been accepted.
`connectorFetch` retried such POSTs up to twice in-process, and the drain
retried them on later ticks. Only report-handoff drafts carried a Message-ID
fingerprint, so Touch 1 and follow-ups could not be reconciled: a duplicate
email to a prospect was possible.

## Decisions

- **D1 — No blind in-process retry.** `ConnectorHttpRequest.idempotent =
  false` disables retries on 5xx, timeout and network errors; a 429 (an
  explicit refusal) still retries. The Gmail `messages/send` call sets it.
- **D2 — Every scheduled send has a fingerprint.** At claim (a committed
  transaction, before dispatch) the drain sets `send_message_id` to
  `sendMessageIdFor(draftId, senderDomain)` when it is empty. The adapter
  already stamps it as the RFC 5322 Message-ID.
- **D3 — Check before every retry.** A claimed draft with a prior attempt runs
  `reconcileStaleClaim` first: found → ledgered as reconciled, not resent;
  search failed → parked for a human; not found → sent.

## Acceptance criteria

- [x] `idempotent: false`: one call on 503 and on a network error; a 429
      still retries.
- [x] A failed drain attempt stores and sends a `<rf-…@domain>` fingerprint;
      when the next attempt finds it in the mailbox, the draft is reconciled
      and not resent.
- [x] Existing retry-then-park behaviour holds when the mailbox has no match.
- [x] typecheck, lint, full suite pass; `DECISIONS.md` entry.
