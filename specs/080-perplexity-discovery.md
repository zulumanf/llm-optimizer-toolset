# Spec 080 — Perplexity Prospect Discovery Adapter

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/041 (source adapter contract + registry guard), specs/079 (perplexityResearch — the one transport), spec 027 (found ≠ true)
> Branch: feat/080-perplexity-discovery

## Why

Opening a new market starts from a blank prospect list; the registry has
carried only the guarded mock since spec 041 ("CSV import and manual entry
are the working universe sources until a real adapter ships"). Perplexity
can propose a market's notable teams with citations for about a cent per
sweep — and the platform already has the exact containment this needs: the
adapter contract, the SourceRecord provenance envelope, the discovery
candidates review queue, and the duplicate detector. This spec ships the
adapter; everything downstream is untouched.

## Design

`lib/prospects/providers/perplexity.ts` — `createPerplexityProspectSource
(caller?)` (injectable transport for tests, docs/09) + the default
instance registered as `perplexity` in the registry. The Discover dialog
lights up in production automatically once a non-mock adapter exists.

- **One call per sweep** (`perplexityResearch`, model `sonar`, capped
  output, ledgered as `prospect-discovery-v1`): "List up to {limit} of the
  most productive residential real-estate teams/agents in {market}
  {segment}" → strict-JSON array of {businessName, prospectType,
  teamLeader, brokerageAffiliation, website, neighborhoods, specialties} +
  per-item sourceUrl where the model cites one.
- **Envelope honesty**: `provenance: "ai_inferred"` (a search answer, not
  a verified fact), `sourceType: "search"`, `confidence` from the model's
  own field, `retrievedAt` = now, `sourceUrl` = the item's citation or the
  sweep's first citation. Emails are NOT requested here — contact digging
  is spec 079's per-prospect job with its validity gate; discovery stays
  cheap and shallow.
- **validateConfiguration**: key present → ok; absent → fail-closed detail.
- Everything found lands as review candidates through the UNCHANGED
  `runProspectDiscovery` flow — dedupe, review queue, approve-to-prospect.

## Out of scope

Auto-enrichment of approved candidates (operator runs spec-079 research
after approval); pagination beyond one call; other verticals' prompts.

## Acceptance criteria

- [x] Adapter satisfies the contract; registry serves it; mock stays
      guarded (unit).
- [x] Mapping: model output → SourceRecord envelope with ai_inferred
      provenance, search sourceType, citations (unit, fake caller).
- [x] End-to-end through `runProspectDiscovery`: candidates staged for
      review, duplicates handled by the existing flow, nothing becomes a
      prospect without approval (integration, fake caller).
- [x] Missing key: validateConfiguration fails closed; discovery returns a
      clear operator error (integration).
- [x] Every sweep ledgers under `prospect-discovery-v1` (integration).

## Definition of done

Criteria pass · full suite green · lint/typecheck clean · docs/05 +
DECISIONS.md updated · first real sweep on a fresh market run and reported.
