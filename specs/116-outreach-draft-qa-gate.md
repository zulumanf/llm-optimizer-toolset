# Spec 116 — Deterministic outreach draft QA gate

## Why

The 2026-08-25 send batch was saved only by a manual QA sweep that caught,
minutes before scheduling: (1) every Wilmington draft citing "512 monitored
responses" beside a finding counting "0 of 354"; (2) two prospects with
@compass.com contacts and NULL `brokerage_affiliation`, silently bypassing
the 3-per-brokerage/30-day recontact cap; (3) audits whose reply CTA mailed
the operator's login instead of the sender identity. All three are
mechanically checkable. Machine-checkable failures must be blocked by code,
not by an operator remembering to run a script (automation-quality operating
model: deterministic gates for deterministic failures; the LLM sense-check
(spec 077) remains the layer for subjective quality).

## What

`lib/prospects/draft-qa.ts`:

- `qaDraftContent(input): DraftQaIssue[]` — **pure**, unit-tested. Checks:
  - **artifacts**: `null` / `undefined` / `{{` / `[object` in subject or body;
    subject length 10–90.
  - **compliance footer**: sender identity postal address AND the word
    "unsubscribe" present in the body.
  - **greeting**: `Hi X,` where X is "there" or appears in the bound
    contact's name / prospect team leader.
  - **audit link**: any in-body audit URL must equal the prospect's branded
    link URL (or legacy token URL) for a published, non-expiring (≥7 days)
    audit.
  - **count consistency**: every `N of M` and `(K monitored responses)`
    pattern in the body must agree on one M, and M must equal the published
    snapshot's `keyFinding.metrics.sampleSize`.
  - **prepared-by**: snapshot `preparedBy.email` equals the active sender
    identity `reply_to_email`.
  - **brokerage honesty**: if the contact email's domain is a known
    brokerage domain (`BROKERAGE_EMAIL_DOMAINS`), the prospect must have a
    recorded `brokerage_affiliation` — the recontact cap depends on it.
- `qaDraft(draftId): Promise<DraftQaIssue[]>` — assembles inputs from the
  DB and calls the pure core.

## Enforcement points

1. `approveOutreachDraft` — refuses approval listing every issue (same
   pattern as the prohibited-phrase gate). Catches problems while a human
   is looking.
2. `sendProspectDraft` — one aggregated `draft_qa` row in the existing
   check chain, so every dispatch (human or worker) re-verifies against
   the *current* audit state and the refusal is ledgered. A draft approved
   against audit v1 cannot transmit stale numbers after a republish.

## Non-goals

- No LLM calls. Subjective copy quality stays with the audit sense-check.
- No retroactive re-checking of sent mail; the ledger is immutable.

## Acceptance

- Unit tests: fixture per check (mismatched sample, missing footer,
  brokerage-domain-without-affiliation, greeting mismatch, URL mismatch,
  clean pass).
- All 23 drafts scheduled for 2026-08-25 pass `qaDraft` unchanged.
- `npx tsc --noEmit` and lint clean.

Note: inert on prod until the web/worker deploy picks it up; active
immediately for operator scripts, which approve everything today.
