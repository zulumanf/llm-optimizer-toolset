# Spec 103 — Assistant Review Loop ("what's waiting on me?")

> Status: done
> Depends on: specs/080, specs/081, specs/096, specs/102
> Branch: feat/103-assistant-review-loop

## Goal

The assistant can *create* staged review work but cannot see or decide it:
`run_discovery` stages candidates and `enrich_prospect` stages proposals,
yet listing, approving, or rejecting them lives only in the UI (and
`approve_enrichment` exists without its reject twin). Four thin-wrapper
tools close the loop: list discovery candidates, review one (approve or
dismiss), list a prospect's enrichment proposals, reject one. No new
services, no migration — every backing function already exists.

## User stories

- As an operator, I can ask "what discovery candidates are waiting?" and
  see the pending queue (per launch or overall) with confidence, source,
  and resolution.
- As an operator, I can approve or dismiss a candidate from chat (confirm
  click); approval creates the prospect through the existing
  provenance-stamped path.
- As an operator, I can ask "what did enrichment find for X?" and see the
  prospect's pending/failed proposals with payloads and citations.
- As an operator, I can reject a bad proposal from chat (confirm click)
  with an optional reason, completing the approve/reject pair.

## UI

None. All four tools ride the existing assistant dock; confirm-tier tools
reuse the pending-action card.

## Database changes

None.

## API (assistant tools)

| Tool | Tier | Input (zod) | Backing call |
|---|---|---|---|
| `list_discovery_candidates` | read | `{ launch_id?: uuid, status?: enum('pending','approved','dismissed','duplicate','all') = 'pending', limit?: int 1–50 = 20 }` | `listDiscoveryCandidates` (`lib/prospects/discovery.ts:145`) |
| `review_discovery_candidate` | confirm | `{ candidate_id: uuid, decision: enum('approve','dismiss'), company_id?: uuid }` | `reviewDiscoveryCandidate` (`lib/prospects/discovery.ts:182`) |
| `list_enrichment_proposals` | read | `{ prospect_id: uuid }` | `listEnrichmentProposals` (`lib/prospects/enrichment.ts`) |
| `reject_enrichment_proposal` | confirm | `{ proposal_id: uuid, reason?: string ≤500 }` | `rejectEnrichmentProposal` (`lib/prospects/enrichment.ts`) |

Tier rationale: the lists are pure reads. Reviewing a candidate is
confirm-tier both ways — approval creates a prospect (the
`approve_enrichment` precedent) and dismissal discards staged research;
one tool mirrors the one service function. Rejecting a proposal is the
same consequence class as approving one.

The candidate list returns compact rows (name, launch, provider, source
URL, confidence, provenance, status, resolution) — never the raw payload,
which can blow the 6,000-char transcript budget.

## Validation rules

- All ids UUID-validated at the tool boundary; services re-validate.
- `status: 'all'` maps to no filter; the service's own 200-row cap stays.
- Candidate review guards are the service's: only `pending` decides;
  anything else conflicts. Same-name collisions record `duplicate`.
- Catalog invariant extended: `review_` and `reject_` prefixes must be
  confirm-tier (source-level assertion alongside `cancel_`/`retry_`).

## Edge cases

- Approve with an ambiguous company resolution: the service stores the
  resolution and leaves linking as a suggestion — the assistant reports
  the outcome verbatim, never forces a link.
- Reviewing an already-decided candidate → the service's `conflict`
  surfaces to the model (not retryable in-loop).
- `list_enrichment_proposals` shows only `pending`/`failed` rows (the
  service's contract) — the description says so, so the model never
  claims an approved proposal "disappeared".
- Rejecting a missing proposal → `not_found` surfaces verbatim.

## Acceptance criteria

- [ ] The four tools are in the belt at the tiers above; catalog
      assertion covers `review_`/`reject_` prefixes.
- [ ] `review_discovery_candidate` invoked by the model stages a pending
      action and executes nothing; a confirm click approves the candidate
      and creates the prospect (integration).
- [ ] Confirmed `reject_enrichment_proposal` flips the proposal to
      `rejected` with the audit row the service writes (integration).
- [ ] Both list tools return through the loop with compact rows
      (integration; candidate rows carry no raw payload).
- [ ] Lint, typecheck, full suite pass.

## Test cases

- Unit (`assistant-tools.test.ts`): tiers for all four; extended prefix
  regex; `describeSchema` render of `review_discovery_candidate`.
- Integration (`assistant-operator.test.ts`): seed a discovery run +
  pending candidate + enrichment proposal; list both through the loop;
  mint + confirm the approve (prospect exists after, candidate
  `approved`); mint + confirm the reject (proposal `rejected`); minting
  alone mutates nothing.

## Definition of done

All acceptance criteria pass · tests green · lint and typecheck clean ·
`docs/05` updated · `DECISIONS.md` entry for the tier calls · demoed
against seeded data.
