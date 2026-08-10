# Spec 052 — Manual Outbound Safety

**Status:** Implemented — all acceptance criteria verified 2026-08-09 (operator-text fencing delivered on PR #24's branch)
**Branch:** `feat/052-outbound-safety` (stacked on `feat/051-value-loop`)
**Source:** Architecture gap audit 2026-08-09 (growth 7.5–7.7, 8.5, 8.7, 9.3, 10.5/10.7; security F17, F26–F29). Goal: make *manual* outbound truthful and safe without waiting for the automated acquisition engine — and without preempting the ESP decision.

## Why

The prospect audit page is the highest-persuasion surface the company ships, and outbound email is its most legally exposed act. Today: audit-page numbers carry no machine-checkable evidence binding; the opt-out footer lacks the physical postal address CAN-SPAM §7704(a)(5) requires and there is no sender-identity record at all; a missing `APP_URL` silently produces outreach without the audit link that is its entire proof; nothing stops contacting the same human under two prospects or hammering one brokerage; a "delete my data" reply has no code path; the territory conflict gate runs once at `outreach_ready` and never again at send; and a client login, once granted, can never be revoked through the product.

## Scope

### A. Evidence-bound audit numbers
- `scoredEntities` returns the `scores` row id per metric; the published snapshot's comparison rows carry `scoreIds`.
- `publishAudit` runs a new deterministic validator before freezing: every rate in the snapshot must match the referenced immutable score row (value + sample size). A mismatch refuses publication. "How do you know?" becomes machine-checkable on the prospect surface, same as client reports.
- The operator-text blocks (`humanFinding`/`adoptionStat` — spec 048, currently on PR #24) get required publisher+URL+date and `findProhibitedPhrase` fencing **as a commit on `feat/audit-pr-b`**, where that code lives.

### B. Compliant sender identity (migration 062) — fail-closed until configured
- `outreach_sender_identity`: sender_name, company_name, **postal_address**, reply_to_email; one active row (partial unique index); changes append a new row and deactivate the old, audited. Admin-set.
- The opt-out footer is built from the identity and includes the postal address. Cold email without a configured identity **refuses** — the missing operator decision blocks sends instead of producing non-compliant ones.
- System-generated outreach drafts refuse without an active sender identity (the compliant footer is embedded at generation time, so manual sends copied from a draft comply too), and refuse when a **published audit exists but `APP_URL` cannot resolve its link** — the silent no-link fallback was exactly how the first real email would have shipped without its proof (audit F17). A draft with no published audit remains the documented reply-first variant.
- The send gate gains a `sender_identity` check for transmitting channels; drafts embed the compliant footer at generation time so `manual` sends copied from the draft are compliant too.

### C. Re-contact guards (send gate)
- `recontact_person`: an allowed send to the same normalized email within `RECONTACT_PERSON_WINDOW_DAYS` (30) — for *any* prospect — refuses (audit 9.3: guards were per-prospect only).
- `recontact_brokerage`: ≥ `BROKERAGE_SEND_CAP_30D` (3) allowed sends to prospects of the same normalized brokerage affiliation in 30 days refuses.

### D. PII erasure (migration 062)
- `eraseProspectContactPii` (admin, reason required): suppresses the email globally (`erasure_request`) so the person can never be re-contacted, nulls the PII columns, stamps `pii_erased_at`, audits. `eraseProspectAccountPii` does the same for the prospect row's own email/phone/socials.
- Principle reconciliation (recorded in DECISIONS): measurement data (responses, mentions, scores) is immutable and contains no contact PII; contact PII is deletable on request — the suppression tombstone (a normalized hash-equivalent match key) is what must survive, and it does.
- `stalePiiReport(days)` lists contacts untouched beyond a retention window so retention is at least *visible* before a policy exists.

### E. Territory re-check at send (migration 062)
- `exclusivity_agreements.status` gains `reserved` — a pending-proposal hold that occupies the territory in conflict detection exactly like `active` (dates still govern the window).
- The send gate re-runs conflict detection at send time: a non-clear verdict refuses unless the prospect carries a recorded admin override (`conflict_status = 'override'`). This closes audit 10.7 — signing a new client agreement now suppresses conflicting in-flight sends without any sweep, because every send re-checks.

### F. Client access revocation
- `revokeClientAccess` (admin): removes the portal grant, audited. `setUserActive` (admin, never self): flips `users.active`, which auth already honors on the next request. Settings page lists portal users with revoke/deactivate actions.

## Out of scope
- Actual ESP integration and reply-mailbox ingest (needs the operator's sender/domain decision; the identity table is its prerequisite).
- Automated retention deletion (policy decision first; the report makes it visible).
- Prospect-side claims-ledger unification (bigger refactor; the score-binding validator covers the numbers now).

## Acceptance criteria
- [x] Snapshot comparison rows carry `scoreIds`; a tampered snapshot value refuses publication (test).
- [x] With no active sender identity, cold sends and draft generation refuse with a clear message (test); configuring one (admin, audited) unblocks; the footer contains the postal address (test).
- [x] Draft generation refuses when a published audit's link cannot resolve (APP_URL unset) instead of silently omitting it (test).
- [x] Same-email cross-prospect send within 30 days refuses; 4th brokerage send in 30 days refuses (tests).
- [x] Erasure: contact PII nulled + globally suppressed + audited; a post-erasure send to that email refuses on suppression (test). Stale report lists old contacts (test).
- [x] A `reserved` agreement produces a send-time refusal for a conflicting prospect; a recorded override passes; terminated does not conflict (tests).
- [x] Revoked portal grant loses access on next read; deactivated user refused by auth; self-deactivation refused (tests).
- [x] Migration 062 reversible; `npm test`, lint, typecheck green.
