# Spec 148 — Recipient Provenance Send Gate

> **Status:** implemented (2026-10-03).
>
> **Audience:** internal operators only. Nothing here reaches a client or prospect, except that it stops some emails from being sent to them.
>
> **Why:** the operational audit on 2026-10-03 found that outreach approval, scheduling, record-sent and transmission checked do-not-contact and suppression but never checked where the recipient's email came from. An `ai_inferred` (guessed) address could be approved and sent. This is the minimum safety fix before prospecting real businesses.

## Policy

The system already has one canonical definition of a send-ready contact. It was `SEND_READY_CONTACT_PROVENANCE = ["verified", "publicly_sourced"]` in `lib/prospects/t1-cohort.ts` (spec 042 labels), and it was already used by the T1 cohort and the supply engine's `contactability`.

That rule moves to `lib/prospects/constants.ts`; `t1-cohort.ts` re-exports it. It now also governs the outreach gates:

- **Allowed:** a recipient email whose provenance is `verified` or `publicly_sourced`.
- **Refused:** `ai_inferred`, `estimated`, `manual`, null or any unknown value. The gate fails closed.
  - `manual` stays refused because the canonical rule never included it. A hand-typed address is not evidence. If the operator has actually confirmed it, they label the contact `verified` or `publicly_sourced`.
- **Which provenance counts:** the email the send would actually use.
  - If the draft's contact has an email, that contact's `provenance` applies.
  - Otherwise the prospect's own email applies, with `prospects.field_provenance->>'email'`.
- **Wrong prospect:** a draft contact that does not belong to the draft's prospect blocks the send. Another prospect's verified contact can never satisfy this one.
- **No email at all** (phone-only, manual channel): nothing is gated by this rule, because there is no address to be wrong. The existing `recipient_email` check still refuses transmission without an email.

## Gates

One resolver (`resolveRecipient` in `lib/prospects/shared.ts`) and one verdict (`recipientEmailProvenanceVerdict`) feed every gate:

| Path | Function | Behaviour |
|---|---|---|
| Draft approval | `approveOutreachDraft` → `assertRecipientContactable` | throws "Verify this contact before sending…" |
| Schedule | `scheduleDraftSend` → `assertRecipientContactable` | throws (early feedback) |
| Record a manual send | `recordDraftSent` → `assertRecipientContactable` | throws |
| Every transmission | `sendProspectDraft` → `recipient_email_provenance` check | refusal is written to the ledger (`prospect-send-gate-v4`) |

`sendProspectDraft` is the only caller of `channel.dispatch`. It covers:
- the human "Send via Gmail" click;
- the scheduled drain (`drainScheduledSends`);
- follow-up touches T2/T3 (`scheduleDueFollowups` inserts them already approved, and the drain sends them);
- fulfillment hand-offs, assistant sends and scripts.

Because provenance is re-read at send time, a contact downgraded after approval refuses at transmission.

## Contact-verification state (bug fix)

`contactSupplyQueue` (`lib/prospects/enrichment.ts`) reported `verified_on_page` from `prospect_activities.kind = 'contact_verified'`. Nothing writes that kind. `scripts/supply-promote.ts` writes `kind = 'note'` and persists the real fact as contact provenance `publicly_sourced`.

The queue now reads the persisted contact provenance through the canonical rule:
- a prospect with a send-ready contact leaves the queue;
- `verificationStatus` derives from the best contact's provenance;
- `manual` is no longer treated as sendable, which matches the gate.

There is no second verification concept, and nothing depends on the log.

## Acceptance criteria

- [x] An `ai_inferred` recipient email cannot be approved, scheduled, recorded as sent, or transmitted, by a human or unattended.
- [x] Follow-up touches refuse at transmission when the sequence contact is not send-ready.
- [x] `verified` and `publicly_sourced` pass; `manual`, `estimated`, null and unknown fail closed.
- [x] A provenance downgrade after approval is caught at send time.
- [x] A contact from another prospect cannot satisfy the gate.
- [x] `contactSupplyQueue` recognises a `publicly_sourced` or `verified` contact without any activity-log entry, and keeps listing unverified ones.
- [x] Send caps, DNC, suppression, evidence release, QA and approval gates are unchanged.

## Slice 2 — keeping provenance honest at entry and edit (2026-10-03)

The gate is unchanged. This slice closes the ways a trusted label could attach to an address nobody checked.

- **Email edits invalidate the label.**
  - `updateContact`: a changed email (case-insensitive compare) without an explicit `provenance` in the same edit drops to `EMAIL_CHANGE_PROVENANCE` (`manual`).
  - `updateProspect`: a changed prospect email without an explicit `fieldProvenance.email` does the same.
  - Edits that don't change the email keep the label.
  - The audit entry records `emailChanged`, `provenanceBefore` and `provenanceAfter`.
- **Contact dialog.**
  - Three explicit choices (`CONTACT_ENTRY_PROVENANCE`): Manual / unverified (the default), Publicly sourced, Verified. Each has copy saying whether it is send-ready.
  - `ai_inferred` and `estimated` are not offered.
  - A send-ready choice needs an email and a Source. Source is stored in the contact's existing `notes` as `Source: …`, so no migration was needed.
  - The prospect page shows the label and a "verify before sending" badge on any non-send-ready email, plus the notes.
- **CSV import.**
  - Email addresses (`contact_email` and the prospect `email` column) get a separate `emailProvenance`, which defaults to `manual`. The file-level label still applies to every other fact.
  - Previously a public list's default `publicly_sourced` label made every address in it send-ready.
  - The assistant's `import_prospects_csv` tool does not expose `emailProvenance`, so AI-driven imports never produce send-ready emails.
- **Existing data is not rewritten.** `manual` contacts stay `manual` and keep failing closed until an operator re-labels them.

## Operational note

Live drafts or follow-up sequences whose recipient is a `manual` contact (or a prospect email without field provenance) will refuse at their next send. Each refusal is ledgered. Re-label confirmed contacts as `verified` or `publicly_sourced` to release them.
