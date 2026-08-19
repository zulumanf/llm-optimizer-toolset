# Spec 091 — Gmail Send Channel + Scheduled Dispatch

**Status:** In progress — operator decisions resolved 2026-08-19: mailbox is
`francisco@recommendedfirst.com` (Google Workspace on the business domain);
daily cap starts at 25 (`GMAIL_DAILY_SEND_CAP`)
**Branch:** `feat/091-gmail-send-channel`
**Source:** Operator request 2026-08-19 ("connect the prospecting pipeline to my
gmail so it can send the emails or schedule them out"). Resolves the deferred
half of roadmap 3.2 (spec 043: "A real ESP/Gmail channel slots in after live
verification — interface first, credentials later") and the open ESP decision
spec 052 scoped out. The ESP decision resolves as: **Gmail API is the ESP.**

## Why

Every layer of the send path already exists and is fail-closed — the gate chain
and insert-only send ledger (spec 043), sender identity + recontact + territory
re-check at send (spec 052), suppression, the sequences engine with
`next_send_at` scheduling (`lib/outreach/sequences.ts`), and a complete Gmail
connector adapter (`lib/connectors/adapters/google.ts`) with
`email.create_draft` / `email.send_approved_message`, encrypted credential
storage, and token refresh. What is missing is exactly three joins:

1. **No way to mint the credential.** Nothing outside the refresh path calls
   `storeCredential`; there is no OAuth consent flow, so no Gmail connection
   can exist.
2. **No transmitting channel.** `lib/prospects/channels.ts` has only `manual`
   and `mock`; the send ledger's check constraint allows only those two.
3. **No consumer of the schedule.** `dueSequences()` exists and nothing calls
   it — scheduled messages are computed and never transmitted.

## Principles applied

- **Software suggests. Humans approve (PRINCIPLES #8).** Nothing in this spec
  creates autonomous outreach. A Gmail transmission happens only for a message
  a human explicitly approved — either "send now" (a click) or "approved with a
  scheduled send time" (a click that names the time). Scheduling defers the
  *transmission* of a confirmed action; it never originates one. The full send
  gate re-runs at transmission time (spec 052 §E), so an approval that has
  since become unsafe (new suppression, territory conflict, erasure) refuses
  instead of sending. Record this reconciliation in DECISIONS.md.
- **Credentials before code, fail-closed.** No connection → the channel
  refuses with a clear message; nothing silently falls back to `manual`.
- **The ledger is evidence.** Gmail sends write the same insert-only
  `prospect_outreach_sends` row with gate verdict, body hash, and now a real
  `provider_message_id` (the Gmail message id).

## Operator decisions (blocking — record answers in DECISIONS.md)

1. **Which mailbox.** Sending cold outreach from a personal `@gmail.com`
   address has poor deliverability and sits awkwardly next to the CAN-SPAM
   sender identity (company name + postal address footer over a personal
   Gmail). **Recommendation:** a Google Workspace address on the business
   domain (e.g. `francisco@recommendedfirst.com`), which also closes the open
   ".co email domain" decision. Personal Gmail is acceptable for a low-volume
   pilot; the spec is agnostic — the address is `sendAsAddress` in the
   connection config, verified by the adapter before every send.
2. **Daily volume cap.** Gmail hard limits: ~500/day (consumer), 2 000/day
   (Workspace). Cold outreach should sit far below both while the address
   warms. **Recommendation:** `GMAIL_DAILY_SEND_CAP = 25` as a named constant,
   enforced in the send gate (count of ledger rows with `channel='gmail'` in
   the trailing 24 h), operator-raisable by config later.

## 1. Credential mint — `scripts/connect-gmail.ts`

One-time CLI (single-operator agency; a full in-app OAuth connect surface is
deliberately out of scope — the connector page already displays connection
health once the row exists).

Prerequisite (operator, manual): a Google Cloud project with the Gmail API
enabled and an OAuth client (type: Web application, redirect
`http://localhost:8791/callback`); consent screen may stay in Testing mode with
the sending account as a test user — note Testing-mode refresh tokens expire
after 7 days of inactivity, Production-mode ones do not, so publish the consent
screen before relying on weekly scheduled sends.

The script:

1. Reads `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` from env
   (never argv — argv leaks into shell history), `--project <id>` and
   `--send-as <address>` from argv.
2. Starts a loopback listener, prints the consent URL for scopes
   `gmail.readonly gmail.compose gmail.send` with `access_type=offline` and
   `prompt=consent` (forces a refresh token), waits for the code.
3. Exchanges the code, then inside one transaction:
   - `insertConnection` (`db/connectors.ts`): provider `gmail`,
     `external_account_id` = the authorized email (from the tokeninfo/profile
     endpoint), config `{ userId: "me", sendAsAddress, clientId, clientSecret }`
     — the adapter's `googleRefresh` reads client id/secret from connection
     config by design.
   - `storeCredential` (`lib/connectors/credentials.ts`): kind `oauth2`,
     access token + refresh token + expiry. Encryption is the credential
     boundary's job; the script never writes ciphertext itself.
4. Immediately executes the adapter's health/verify capability (the
   `sendAsAddress` verification) and prints the result. A failed verify exits
   non-zero and marks the connection `error` — a half-connected mailbox must
   be visible, not latent.

Re-running the script for the same account rotates the credential on the
existing connection (the `(project_id, provider, external_account_id)` unique
index makes this natural), never duplicates.

## 2. Migration 086 — ledger channel + scheduled approvals

```sql
-- up
alter table prospect_outreach_sends drop constraint <channel_check>;
alter table prospect_outreach_sends add constraint <channel_check>
  check (channel in ('manual', 'mock', 'gmail'));
alter table outreach_drafts
  add column scheduled_send_at timestamptz,      -- the human's named time
  add column scheduled_by uuid references users(id),
  add column scheduled_business_purpose text,    -- their stated basis, verbatim
  add column send_attempts int not null default 0,
  add column send_claimed_at timestamptz,        -- in-flight marker (see §4)
  add column last_send_error text;
-- down: restore the two-value check (refuses if gmail rows exist — correct:
-- evidence rows must not be orphaned by a rollback), drop the columns.
```

The scheduling columns are deliberately outside migration 038's
approved-draft immutability list: the approved TEXT stays frozen; when and
whether it transmits is operational state. `scheduled_send_at` is set only
through `scheduleDraftSend` (§4); it is the human's named time, never a
system inference.

## 3. `gmail` channel — `lib/prospects/channels.ts`

```ts
const gmailChannel: EmailChannel = {
  id: "gmail",
  transmits: true,
  async dispatch(message) {
    // resolve the active gmail connection; ClassifiedError("validation",
    // "No Gmail connection…run scripts/connect-gmail.ts") when absent
    // executeCapability email.send_approved_message → { providerMessageId }
  },
};
```

- Requires `recipientEmail` and `subject` (transmitting channel; the gate
  already asserts opt-out presence and appends the footer).
- The daily cap check (decision 2) lives in the gate chain in
  `sendProspectDraft`, not in the channel — channels stay dumb dispatchers.
- The adapter's send path prefers draft-id sends ("sending the exact reviewed
  artifact"); the channel passes subject/to/body and lets the adapter own the
  RFC 2822 assembly it already implements.
- No change to the gate chain order: every existing check (approval state,
  DNC, suppression, prohibited phrases, sender identity, recontact, territory
  re-check, business purpose) runs before dispatch exactly as today.

## 4. Scheduled dispatch

**Scheduling is a second explicit human act** (`scheduleDraftSend`), separate
from approval — approval freezes the text, scheduling names the time (future,
capped at `SCHEDULED_SEND_MAX_DAYS_AHEAD = 30` days) and records the stated
business purpose that will go on the ledger. Approving a newer version
supersedes the old draft AND clears its schedule; a scheduled draft can be
cancelled (audited), except while the worker holds a claim on it.

**Worker lane** (`drainScheduledSends` in `lib/prospects/scheduled-sends.ts`,
riding `runAutomationTick`'s existing 10-minute cadence — email does not need
minute-level granularity, and the tick is the platform's one clock):

1. Claim due drafts (`status = 'approved' and sent_recorded_at is null and
   scheduled_send_at <= now()`, `for update skip locked`, small batch) by
   committing `send_claimed_at` + incrementing `send_attempts` BEFORE
   dispatch.
2. Each goes through `sendProspectDraft(user = the scheduling human, {
   draftId, channel: 'gmail', businessPurpose: <recorded at scheduling> })`
   — the same single entry point human clicks use. No parallel send path
   exists, and attribution stays with the human whose confirmation the
   worker executes.
3. A gate refusal at send time **parks** the draft (schedule cleared,
   `last_send_error` set, refusal ledgered, audited — visible on the
   prospect detail, never silently retried). A clean transport failure
   clears the claim and retries next tick, up to
   `SCHEDULED_SEND_MAX_ATTEMPTS = 3`, then parks.
4. A claim that never recorded an outcome (worker died mid-dispatch) is
   **ambiguous — the mail may have left** — after
   `SCHEDULED_SEND_STALE_CLAIM_MINUTES = 15` it parks with instructions to
   verify in the Gmail Sent folder, and is never auto-retried.

## Out of scope

- **The sequences engine's `dueSequences()` drain** (lib/outreach). Its
  messages transmit through the automation layer's own gate
  (`assertSendAllowed`: autonomy levels, approval-to-body-hash binding) —
  wiring a drain there means composing that machinery correctly, which is
  its own spec. This spec's pipeline is the prospect-draft stack, which is
  what the operator's /prospects surface drives.
- Reply-mailbox ingest / opt-out automation via `gmail.readonly` (the scope is
  granted by this spec so the *next* spec needs no re-consent, but inbound
  parsing is its own spec — reply-based opt-out remains manual recording onto
  the suppression list for now).
- In-app OAuth connect surface (CLI mint suffices for one operator).
- Open/click tracking (deliberately never — no tracking pixels in outreach;
  aligns with the truthfulness posture).
- Multi-mailbox rotation, sending-domain warmup automation.

## Acceptance criteria

- [x] `gmail` channel refuses with an actionable message when no active
      connection exists (test), and nothing is recorded as sent.
- [x] A gmail send writes a ledger row with `channel='gmail'`, the full gate
      verdict (`prospect-send-gate-v2`, including `daily_send_cap`), body
      hash, and the Gmail message id; the transmitted body carries the
      compliant footer (test, connector layer mocked at `executeCapability`).
- [x] Daily cap: the send past `GMAIL_DAILY_SEND_CAP` in 24 h refuses with a
      ledgered refusal, before any dispatch (test).
- [x] `scheduleDraftSend` stores schedule + scheduler + purpose, audited;
      refuses past times, >30 days, and unapproved drafts; superseding a
      scheduled draft clears its schedule; cancel clears it but refuses while
      the worker holds a claim (tests).
- [x] The drain transmits a due approved draft through `sendProspectDraft`
      with the scheduler as sender of record; a send-time gate change
      (suppression added after scheduling) parks the draft with a ledgered
      refusal and never dispatches (tests).
- [x] Clean transport failures retry then park at the attempt cap; a stale
      claim parks as ambiguous without dispatching; nothing but approved,
      unsent drafts is ever picked up (tests).
- [x] Migration 086 is reversible (rides the full down-and-up cycle test in
      projects.test.ts); down refuses while gmail ledger rows exist by
      design.
- [x] Lint, typecheck, full test suite pass.
- [ ] `scripts/connect-gmail.ts` run against the real mailbox
      (`francisco@recommendedfirst.com`) and the health check passes —
      operator step, needs the Google Cloud OAuth client.
- [ ] First live send verified end-to-end (operator; flips the adapter's
      `implemented_unverified` standing in practice).
