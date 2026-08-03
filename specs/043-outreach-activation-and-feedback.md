# Spec 043 — Outreach Activation and the Acquisition Feedback Loop

Phase G of `docs/implementation-plan.md`; roadmap Phase 3 items 3.1 (done — see the
DECISIONS.md reconciliation entry), a credential-free slice of 3.2 (the send bridge),
3.7 (funnel analytics), and the target's requirement 21 (outcomes → scoring
recommendations, human-approved only).

## Principles applied

- **The two outreach stacks finally join.** The audit's finding §8.5: prospect drafts
  (spec 032) bypassed the platform's send gate entirely. `sendProspectDraft` is the
  bridge — every dispatch runs the full fail-closed chain (approval state → account
  DNC → contact DNC → suppression on normalised identifiers → prohibited phrases →
  stated business purpose → opt-out present) and writes an **insert-only send ledger**
  with the gate verdict and the exact body hash.
- **First touch stays human.** Channels are dispatch mechanisms behind a human click;
  `manual` records a send the human made from their own mailbox (now with the full
  gate ledger); `mock` exists for CI and is refused in production by the same guard
  as every other mock. A real ESP/Gmail channel slots in after live verification
  (roadmap 3.2's remaining half) — interface first, credentials later, per repo rule.
- **Cold email carries an opt-out.** Platform dispatches append a standard footer
  (sender identity + reply-to-opt-out instruction); the gate refuses bodies with no
  opt-out mention. Reply-based opt-out is the mechanism (a functioning return path),
  and any opt-out reply is recorded on the suppression list — which the gate then
  enforces forever.
- **The feedback loop recommends; humans reweight.** Outcome analysis compares score
  components between converted (reached `replied` or beyond) and unconverted cohorts,
  refuses to conclude below a minimum cohort size, and emits *recommendations* —
  weight changes happen only through `scoring_weight_sets` by a human (spec 039).

## 1. Migration 049 — the send ledger

```sql
create table prospect_outreach_sends (
  id, draft_id → outreach_drafts, prospect_id → prospects,
  channel text check in ('manual','mock'),        -- real channels appended later
  recipient_email text,                            -- normalised at write
  body_hash text not null,                         -- sha256 of subject+body as sent
  business_purpose text not null,                  -- stated legitimate interest
  gate_verdict jsonb not null,                     -- every check, passed or failed
  provider_message_id text, sent_by, sent_at
);
-- insert-only (forbid_mutation trigger): the ledger is evidence.
```

## 2. `lib/prospects/channels.ts` + `sendProspectDraft` (service)

`EmailChannel { id, dispatch(message): Promise<{providerMessageId}> }` with `manual`
(no external call — the human already sent it) and `mock` (guarded). `sendProspectDraft
(user, {draftId, channel, businessPurpose})`:

1. Draft must be `approved` and not already sent (`sent_recorded_at` is the ledger's
   summary flag, kept in sync).
2. Recipient gates: the Phase-A chain (account DNC → contact DNC → `checkSuppression`
   on normalised email/phone). Platform channels additionally **require** a recipient
   email; `manual` tolerates none (the human used their own address book).
3. Prohibited-phrase re-check on the exact outgoing text; opt-out footer appended for
   platform channels and its presence asserted.
4. `businessPurpose` required (≥ 10 chars), recorded on the ledger row.
5. Dispatch via the channel, write the ledger row (full check list, pass or fail —
   refusals are recorded too), stamp the draft, log activity, audit.

`recordDraftSent` (Phase A) remains for backward compatibility; the UI's record-send
now routes through `sendProspectDraft(channel: 'manual')` so every send gets a ledger.

## 3. `lib/prospects/funnel.ts` — acquisition funnel (3.7, derived on read)

Pure `computeFunnel(prospects)` over the stage ladder using `prospect_stage_history`
(+ current stage): per stage — ever-reached count, conversion from the previous
stage; exits (closed_lost / waitlisted / conflict_blocked) counted separately. Read
`acquisitionFunnel(launchId?)`; rendered as a funnel section on `/prospects` with
sample sizes always visible.

## 4. `lib/prospects/score-feedback.ts` — outcomes → recommendations (req. 21)

Pure `scoreOutcomeReport(rows)` where rows carry each scored prospect's breakdown
components + converted flag (ever reached `replied` or beyond):

- Below `MIN_COHORT = 5` in either cohort → an explicit insufficient-data report,
  never a thin conclusion.
- Otherwise per component: converted mean vs unconverted mean, delta, and a
  recommendation sentence for the biggest positive/negative deltas — each carrying
  its sample sizes and the fixed epilogue that weights change only via
  `scoring_weight_sets` (human).
- Surfaced as a card on `/prospects`; nothing is written anywhere automatically.

## Deferrals (recorded)

Live Gmail/ESP verification, OAuth redirect flow, reply ingest + classification
(3.2's live half, 3.4) — blocked on funded credentials, not on architecture; the
channel interface and send ledger are the seam they plug into. Deal economics (3.5)
and prospect→client conversion (3.6) remain roadmap items.

## Acceptance criteria

- [ ] `sendProspectDraft`: refuses unapproved/already-sent drafts, DNC recipients,
      suppressed identifiers (normalised), missing business purpose; mock channel
      requires a recipient email and appends+asserts the opt-out footer; every
      dispatch (and refusal) leaves a ledger row with body hash + gate verdict;
      draft stamped; mock refused outside tests.
- [ ] Funnel: known-answer pure tests (reached counts, conversions, exits); renders
      with sample sizes; launch filter works.
- [ ] Feedback: insufficient-data below cohort floor; direction of recommendations
      matches the deltas; epilogue always present; no writes.
- [ ] Migration 049 up/down; ledger is insert-only (mutation refused).
- [ ] Full gates green.
