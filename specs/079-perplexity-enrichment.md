# Spec 079 — Perplexity Enrichment: Found, Cited, Staged — Never Trusted

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/041 (source registry doctrine), specs/074 (verified production shape), specs/078 (magnitude-aware scoring — the consumer of found values), spec 027 (a search result is a lead, never evidence), docs/12-ai-guidelines.md
> Branch: feat/079-perplexity-enrichment

## Why

Six of fourteen audit prospects have no contact email; two have no
production evidence; every future market starts from zero. The platform's
own discovery section says "CSV import and manual entry are the working
universe sources until a real adapter ships." Perplexity's search-grounded
API can find both — emails and RealTrends/production data with citations —
for fractions of a cent per prospect. What it finds must enter the
platform the constitutional way: as a staged, cited proposal the operator
approves, never as a silently-trusted fact.

## Goal

One click per prospect (or a batch sweep) asks Perplexity ONE combined
question covering exactly the fields that prospect is missing, and stages
what comes back — email, production volume/sides/rank — as proposals with
citations on the prospect page. Approving materializes a real contact or a
properly-provenanced authority signal (feeding spec-078 magnitude
scoring). Spend is minimized structurally and visible in the LLM ledger.

## Design

### Token efficiency (the operator's explicit requirement)

1. **One call, both questions** — a single `sonar` request per prospect
   asks only for its missing fields; a fully-known prospect costs zero.
2. **Cheapest capable model** — base `sonar` (per-token pricing already in
   lib/ai/pricing.ts); `sonar-pro` escalation is out of scope until the
   cheap pass demonstrably under-delivers.
3. **Freshness window** — a prospect with any proposal newer than
   `ENRICHMENT_FRESHNESS_DAYS` (30) is skipped by the sweep; re-running is
   an explicit per-prospect act.
4. **Bounded output** — prompt-contracted strict JSON validated by zod
   (the runAgent pattern; one retry max), `max_tokens` capped (700); a
   persistent schema miss records a failure rather than burning credits.
5. **Ledger** — every call lands in `llm_calls` (agent version
   `prospect-enrichment-v1`, model `sonar`) under the daily spend ceiling.

### The call (`lib/ai/perplexity.ts` gains `perplexityResearch`)

HTTP stays confined to lib/ai (docs/11). Input: system + user + zod
schema + maxTokens; output: parsed JSON + `citations[]` + usage; failure
throws a ClassifiedError. The existing OpenAI-compatible client is reused.

### The service (`lib/prospects/enrichment.ts`)

- `enrichProspect(user, {prospectId}, caller?)`: assemble the known state
  (has a contact with email? has volume / sides / rank signals with
  values?), build the missing-fields-only question (name, team leader,
  brokerage, market as anchors), call `perplexityResearch`, and stage
  results in `enrichment_proposals` (insert-only rows; prior `pending`
  proposals for the prospect flip to `superseded`). A failed call stores a
  failure row (docs/12 §1). Nothing else changes.
- `approveEnrichmentProposal(user, {proposalId, overrides?})`:
  - `contact_email` → existing `addContact` (name from payload, provenance
    `ai_inferred`; the operator can correct fields at approval).
  - `authority_signal` → existing `addAuthoritySignal` (kind, label,
    valueNumber, sourceUrl = the citation, provenance `publicly_sourced`
    when a citation URL exists, else `ai_inferred`; scope local).
  Approval is the ONLY path from proposal to platform fact (spec 027:
  found ≠ true; the citation is a lead the operator eyeballs).
- `rejectEnrichmentProposal(user, {proposalId, reason?})`.
- `listEnrichmentProposals(prospectId)` / open count for the sweep.
- `sweepEnrichment(user, {launchId})`: batch over the launch's
  non-archived prospects honoring skip rules; returns per-prospect
  outcomes (enriched / skipped-fresh / skipped-complete / failed).

### Table: `enrichment_proposals` (migration, next free number)

`id`, `prospect_id → prospects`, `kind` ('contact_email' |
'authority_signal'), `payload jsonb` (email/name or
kind/label/valueNumber/etc.), `citations jsonb` (URLs), `confidence
numeric`, `model text`, `agent_version text`, `status` ('pending' |
'approved' | 'rejected' | 'superseded' | 'failed'), `error text`,
`created_by/at`, `decided_by/at`. Index on (prospect_id, status).
Rollback: drop table.

### Operator surface

Prospect page: an "Enrich (Perplexity)" button + proposals panel —
payload, citation links, confidence, Approve / Reject per proposal
(client component, sense-check-panel pattern). Prospects index: an
"Enrich launch" button beside Discover when the key is configured.

### Honesty rules restated

- Emails are `ai_inferred` until a human verifies; outreach only ever uses
  operator-approved contacts (unchanged send flow).
- Signals from citations are `publicly_sourced`, never `verified` —
  RealTrends facts become `verified/independent` only through the existing
  spec-074 flow when the operator confirms the source page.
- No auto-approval of anything, at any confidence.

## Out of scope

- sonar-pro escalation; a discovery adapter for NEW prospects (registry
  seam noted, separate spec); e2e for the panel (unit + integration with
  an injected fake caller cover the logic; no network in tests, docs/09).

## Acceptance criteria

- [x] A fully-known prospect makes zero API calls; a partially-known one
      asks only for its missing fields (unit on the question builder +
      integration).
- [x] Proposals stage with citations, model, version; approval
      materializes contact/signal via the existing services with the
      provenance rules above; rejection and supersede work; a failed call
      stores a failure row (integration, fake caller).
- [x] Sweep honors the freshness window and reports per-prospect outcomes
      (integration).
- [x] Every real call ledgers under `prospect-enrichment-v1` (integration
      asserts the ledger row with the fake caller path bypassed... the
      ledger write is asserted via the service seam).
- [x] Missing PERPLEXITY_API_KEY fails closed with a clear operator
      message; nothing half-runs (unit/integration).

## Definition of done

All criteria pass · tests green · lint/typecheck clean · migration
reversible · docs/05 + DECISIONS.md updated · first real production
enrichment run executed for the data-thin prospects and reported.
