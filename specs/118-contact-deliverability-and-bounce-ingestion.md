# Spec 118 — Contact Deliverability Guards & Bounce Ingestion

> Status: draft
> Depends on: specs/079 (Perplexity enrichment), specs/091 (Gmail send channel), specs/104-106 (outreach spine), specs/116 (draft QA gate)
> Branch: feat/118-deliverability-and-bounces

## Goal

Sent outreach stops silently dying on bad addresses. Three real failures from
the 2026-08-25 batch motivate three layers: (1) Perplexity fabricated
`patrick@southern.properties` — the domain does not exist, and the cited
source page actually published `southern@serhant.com`; (2)
`dale.fior@bhsusa.com` was a `first.last@` pattern guess whose mailbox does
not exist; (3) `info@kghometeam.com` was correctly sourced but is a Google
Group that rejects external mail — only detectable after sending. When this
spec is done: fabricated domains cannot be approved, AI-found addresses must
be corroborated against their cited source (or explicitly overridden),
dispatch re-checks the domain, and hard bounces are ingested from the Gmail
inbox automatically — marking the contact, halting the sequence, and
surfacing in the cockpit. No send is ever treated as delivered when the
mailbox told us otherwise.

## Non-goals

- SMTP RCPT-TO probing or third-party verification APIs (ZeroBounce etc.) —
  reputational risk and a new vendor for marginal gain over the layers here.
  Catch-all domains that accept-then-drop remain undetectable pre-send; the
  bounce loop is the compensating control. Note in `docs/14-future-ideas.md`.
- Reply ingestion (human replies driving stage moves) — related but separate;
  this spec touches only DSN/bounce messages.

## User stories

- As an operator, I cannot approve an enrichment email proposal whose domain
  has no MX/A record, so fabricated domains die at the door.
- As an operator, when an `ai_inferred` email is not literally present on its
  cited source page, the proposal is flagged `uncorroborated` and requires my
  explicit override with a reason, so pattern guesses stop sailing through.
- As an operator, a scheduled send whose recipient domain no longer resolves
  fails QA at dispatch instead of transmitting.
- As an operator, when a send hard-bounces, the contact is marked
  do-not-contact with the bounce reason, pending sends to that contact are
  cancelled, and the prospect shows a `bounced` badge in the cockpit — so a
  follow-up never chases a message that never arrived.

## Design

### Layer 1 — deliverability check at contact write

New module `lib/prospects/deliverability.ts`:

- `checkEmailDomain(email): Promise<DomainCheck>` — `node:dns/promises`
  `resolveMx`, falling back to `resolveA`/`resolveAaaa` (RFC 5321 A-record
  fallback). Outcomes: `ok` | `no_mx` | `nxdomain` | `dns_error` (timeout /
  SERVFAIL — indeterminate, never blocks alone). 5s timeout, one retry.
- `corroborateOnSource(email, sourceUrl): Promise<SourceCheck>` — fetch the
  cited page (reuse the spec-090 link-health fetcher: same UA, redirect and
  SSRF guards, timeout), case-insensitive search for the literal address in
  the raw HTML. Outcomes: `found` | `not_found` | `unreachable` (403/timeout
  — bhsusa.com blocks bots today, so unreachable must be a soft outcome).

Call sites — every path that writes an email onto `prospect_contacts`:
`approveEnrichmentProposal` (contact_email kind), `addContact` (manual +
assistant tool). Rules:

| Provenance | nxdomain / no_mx | not_found on source | unreachable / dns_error |
|---|---|---|---|
| `ai_inferred` | hard block | block, overridable with reason | warn, overridable |
| all others | hard block | n/a (no source claim) | warn |

Results are stored on the contact (`email_check` jsonb + `email_checked_at`)
so the audit trail shows what was known at approval time.

### Layer 2 — dispatch-time re-check

Extend the spec-116 QA gate (`qaDraft`): before a `gmail`-channel transmit,
re-run `checkEmailDomain` (domains die between approval and send; checks are
stale after `DELIVERABILITY_RECHECK_HOURS = 24`). `nxdomain`/`no_mx` → QA
failure, send not attempted, draft parked exactly like any other QA failure.
`dns_error` → proceed (fail open on infrastructure flake, log it).

### Layer 3 — bounce ingestion worker

New gmail adapter capability `email.list_dsn` (readonly scope already
granted): Gmail query `from:(mailer-daemon OR postmaster) newer_than:{n}d`,
metadata fetch of `X-Failed-Recipients`, `Subject`, `Date`, snippet.

New worker task `ingest-bounces` (same cadence family as scheduled sends;
runs hourly while any send is < 72h old): match failed recipients
case-insensitively against `prospect_outreach_sends` rows from the last 7
days. On match:

1. `prospect_outreach_sends.delivery_status = 'bounced'`, `bounced_at`,
   `bounce_reason` (snippet, truncated).
2. Contact: `do_not_contact = true`,
   `do_not_contact_reason = 'hard_bounce: <reason>'`.
3. Cancel scheduled/approved undispatched drafts targeting that contact
   (existing cancel path, audit-logged `outreach.bounce_autocancel`).
4. Activity log entry on the prospect; cockpit list shows a `bounced` badge.

A DSN with no ledger match is recorded in the worker log and skipped —
never guessed at. Idempotent: processed Gmail message ids are remembered
(`outreach_bounce_events` table), re-runs are no-ops.

## UI

Cockpit prospect row, contact chip area (existing badge slot per docs/04):

```
┌─────────────────────────────────────────────────────────────┐
│ Properties by Southern        [bounced]  stage: contacted   │
│   ✉ patrick@southern.properties — hard bounce (domain not   │
│     found) · do-not-contact · 2 pending sends cancelled     │
└─────────────────────────────────────────────────────────────┘
```

Enrichment proposal review, uncorroborated state:

```
┌─────────────────────────────────────────────────────────────┐
│ contact_email · dale.fior@bhsusa.com                        │
│ ⚠ Not found on cited source (bhsusa.com/…/dale-fior)        │
│ [Approve with override…]  [Reject]                          │
│   └ override requires a reason (logged)                     │
└─────────────────────────────────────────────────────────────┘
```

Loading/empty/error states follow existing proposal-review patterns; the
DNS check renders inline (`Checking domain…` → result) and never blocks the
page render.

## Database changes

Migration `094_contact_deliverability_and_bounces.sql` (next free number —
verify at implementation time):

- `prospect_contacts`: add `email_checked_at timestamptz`,
  `email_check jsonb` (shape: `{domain, mx, source, checkedBy}`).
- `prospect_outreach_sends`: add
  `delivery_status text not null default 'accepted'
   check (delivery_status in ('accepted','bounced'))`,
  `bounced_at timestamptz`, `bounce_reason text`.
- New table `outreach_bounce_events` (`id`, `gmail_message_id text unique`,
  `failed_recipient text`, `send_id uuid null references
  prospect_outreach_sends(id)`, `raw_subject text`, `snippet text`,
  `observed_at timestamptz`, `created_at timestamptz default now()`).
  Insert-only; this is raw evidence and follows the immutability rule.
- Rollback: drop table, drop added columns. `delivery_status` data is
  re-derivable from `outreach_bounce_events` if ever re-applied.

## API (server actions / routes)

- `approveEnrichmentProposal` — extended input: optional
  `{ overrideUncorroborated: { reason: string } }` (Zod, reason min 10
  chars). Result union gains `{ ok: false, error: 'email_undeliverable' |
  'email_uncorroborated' }`. Audit: `prospect.contact_add` payload gains the
  check results and any override.
- `addContact` — same check + result variants; assistant-belt tool surfaces
  the block verbatim (ok-with-error convention).
- Worker task `ingest-bounces` — no user-facing action; audit events
  `outreach.bounce_recorded`, `outreach.bounce_autocancel`.
- Adapter: `email.list_dsn` handler on `gmailConnector`, input
  `{ newerThanDays: number ≤ 14 }`, capability-gated like existing handlers.

## Validation rules

- Email syntax already validated (spec 079); this spec never relaxes it.
- Hard block (`nxdomain`/`no_mx`) is not overridable by anyone — a domain
  with no mail routing cannot receive mail, there is nothing to argue.
- `not_found` override requires a non-empty reason; stored in audit payload
  and `email_check.checkedBy.override`.
- `delivery_status` transitions: `accepted → bounced` only. Never back.
- Bounce matching requires exact case-insensitive equality between
  `X-Failed-Recipients` and `recipient_email` — no fuzzy matching.

## Edge cases

- **Source page blocks bots (403)** — `unreachable`, warn-not-block; the
  proposal card says the source could not be machine-checked and asks the
  operator to eyeball it. (Real case: bhsusa.com.)
- **Address obfuscated on source page** (`name [at] domain`, JS-rendered)
  — reads as `not_found`; the override path exists precisely for this.
  Override reason is the operator's attestation they saw it.
- **DSN for a recipient not in the ledger** (personal mail in the same
  inbox) — logged to `outreach_bounce_events` with `send_id null`, no
  further action.
- **Soft bounces / out-of-office** — Gmail DSNs matched only when a
  `X-Failed-Recipients` header exists; vacation replies lack it → ignored.
- **Group-rejection DSN (Geralis case)** carries the header → treated as a
  hard bounce even though the address "exists"; correct, since mail cannot
  get through as configured.
- **Multiple sends to one address in the 7-day window** — all matching
  ledger rows marked bounced; cancellation still runs once per contact.
- **DNS flake at dispatch** — `dns_error` proceeds and logs; only
  authoritative negatives (`nxdomain`, empty MX+A) block.
- **Worker offline for days** — `newerThanDays` window (default 3, max 14)
  plus the unique `gmail_message_id` makes catch-up runs safe.

## Acceptance criteria

- [ ] Approving an `ai_inferred` email proposal whose domain has no MX and
      no A record fails with `email_undeliverable`; no contact row written.
- [ ] Approving an `ai_inferred` proposal whose address is absent from the
      fetched source page fails with `email_uncorroborated`; succeeds when
      retried with an override reason, which appears in the audit log.
- [ ] `publicly_sourced`/`manual` contacts skip source corroboration but
      still hard-block on `nxdomain`.
- [ ] A scheduled gmail send to a domain that stops resolving after
      approval fails QA at dispatch; nothing is transmitted; the draft is
      parked with the QA issue visible.
- [ ] `ingest-bounces` on a fixture inbox containing the three real
      2026-08-25 DSNs marks all three ledger rows `bounced`, sets
      `do_not_contact` with reasons, and cancels a staged follow-up draft
      for one of them.
- [ ] Re-running `ingest-bounces` on the same inbox changes nothing
      (idempotency via `gmail_message_id`).
- [ ] A DSN for an unknown recipient creates an `outreach_bounce_events`
      row with `send_id null` and touches nothing else.
- [ ] Cockpit shows the `bounced` badge and the bounce reason on an
      affected prospect; keyboard-navigable, dark mode correct.
- [ ] Migration 094 applies and rolls back cleanly.

## Test cases

- Unit, `deliverability.test.ts`: mocked DNS — MX present / A-only /
  NXDOMAIN / timeout → the four outcomes; timeout produces `dns_error`
  never `nxdomain`.
- Unit: `corroborateOnSource` against fixture HTML — plain address, HTML-
  escaped address inside JSON (the real Serhant page shape), absent
  address, 403 response.
- Unit: approval matrix table-test (provenance × outcome → block/override/
  warn) exactly as specified above.
- Integration: enrichment proposal approve → blocked → override → contact
  written with `email_check` populated.
- Integration: dispatch QA re-check parks the draft, ledger untouched.
- Integration: bounce worker against captured DSN fixtures (snapshot the
  three real 2026-08-25 DSN metadata payloads) → assertions per acceptance
  criteria, including cancellation and idempotency.
- Migration up/down test.

## Definition of done

All acceptance criteria pass · tests written and green · `npm run lint` and
`npm run typecheck` clean · migration applies and rolls back · docs/05
feature list updated, DECISIONS.md entry for "no SMTP probing / no
verification vendor" · demoed against seeded data plus the real DSN
fixtures.
