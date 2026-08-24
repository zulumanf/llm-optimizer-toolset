# Spec 111 — Assistant Close the Loop (bulk import + promote to client)

> Status: done
> Depends on: specs/096, specs/107
> Branch: feat/111-assistant-close-the-loop

## Goal

The two ends of the prospect lifecycle reach chat: bulk-import a CSV of
prospects into a launch, and promote a won prospect to a client. Both
services exist and are fully gated; two thin belt wrappers only.

## API (assistant tools)

| Tool | Tier | Input (zod) | Backing call |
|---|---|---|---|
| `import_prospects_csv` | direct | `{ launch_id: uuid, csv: string ≤500k, provenance?: enum(PROVENANCE_LABELS) = 'publicly_sourced', source_url?: url }` | `importProspects` (`lib/prospects/service.ts:812`) |
| `promote_prospect_to_client` | confirm | `{ prospect_id: uuid, create_agreement?: bool = true, agreement_ends_on?: YYYY-MM-DD, grace_period_days?: int 0–3650 = 0 }` | `promoteProspectToClient` (`:2665`) |

Tier rationale: imported rows become ordinary prospects still behind
every downstream gate (findings, publish, outreach) — direct, capped at
200 rows by the parser with per-row error reporting. Promotion creates a
client project and (by default) an ACTIVE exclusivity agreement — the
platform's most consequential single act → confirm; the summary states
the prospect and whether an agreement is created.

Groups: both `prospecting`. Catalog regex gains `promote_` (confirm);
`import_` stays non-confirm (the `import_prompts` precedent).

## Non-goals

Token-level answer streaming — dropped by operator decision 2026-08-24:
spec 110's step streaming covers perceived latency, and the JSON loop
protocol would force an extra LLM call per turn.

## Edge cases

- Import: unknown launch → service `not_found`; per-row failures come
  back in the report, never silently dropped; >200 rows rejected by the
  parser cap.
- Promote: already-promoted → service conflict; the service's own
  stage/agreement guards surface verbatim.

## Acceptance criteria

- [ ] Both tools at the tiers above; catalog assertions extended
      (`promote_` confirm prefix) and ratchet still <11k.
- [ ] CSV import through the loop creates prospects on a seeded launch
      with a per-row report; promote mint+confirm sets
      `promoted_project_id`, re-promote conflicts (integration).
- [ ] Lint, typecheck, full suite pass.

## Definition of done

Criteria pass · tests green · lint/typecheck clean · docs/05 updated.
