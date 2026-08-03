# Spec 011 — Outreach CRM (Media & Rankings)

> Status: draft (ready after 010)
> Depends on: specs/008 · specs/010 · docs/15 (red-level rules)

## Goal
Third-party authority work with the strictest human gate in the system:
journalist intelligence and pitch preparation, plus ranking-submission
packages — the system **drafts and packages; a human sends and submits,
always**.

## Shape
- **Journalist registry** (small, curated — never scraped at scale):
  name, publication, beat, markets, recent relevant articles, thresholds,
  contact preference, pitch/response history, do-not-contact flag.
- **Story detection**: notable events from the knowledge base (new claims,
  transactions where the vertical pack defines them) scored for
  newsworthiness (agent supplies rationale; scoring deterministic).
- **Matching agent**: reporter–story fit scores with reasons; below-threshold
  reporters explicitly listed as do-not-pitch.
- **Pitch drafting agent**: verified facts only (claim ids), one angle, one
  referenced recent article; output is a draft object — with Gmail connected
  it becomes a Gmail *draft*, never a send.
- **Follow-up rules engine** (deterministic): max one follow-up, hard stop on
  decline/request, no parallel outreach to the same reporter, all state
  transitions audited.
- **Ranking submissions** (vertical packs define eligibility rules engines,
  e.g. RealTrends/TRD for real estate): deterministic rule filter →
  classification agent → independent ledger verifier → human-approved
  submission package. The system never submits.

## Red-level invariants (human-only decision, machine-enforced execution)
Superseded wording — see DECISIONS.md 2026-08-02 ("Spec-011 reconciliation").
This section originally read "no code path may exist" for sending email,
submitting rankings, contacting anyone, disclosing client identities. The
recorded reconciliation: the *intent* stands — no automation contacts the
outside world without a human decision — but it is enforced by
`assertSendAllowed` (fail-closed gate: suppression, tenant match, recipient
authorization, artifact-hash-bound approval, opt-out) plus per-message human
dispatch for first-touch outreach. "No code path exists" now applies only to
fully autonomous sends.

## Database sketch
`journalists`, `journalist_articles`, `story_opportunities`, `pitches`
(status: drafted → approved → sent_by_human → responded/declined),
`outreach_events` (append-only), `ranking_submissions` + package jsonb.
