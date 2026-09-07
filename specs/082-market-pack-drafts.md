# Spec 082 — Market-Pack Drafts: A New City in Minutes, Reviewed

> Status: implemented — acceptance criteria verified 2026-08-17
> Depends on: specs/040 (market packs + install), specs/079 (perplexityResearch), specs/080 (discovery — the step after), spec 027 (found ≠ true)
> Branch: feat/082-market-pack-drafts

## Why

The Jersey City pack — geography, neighborhoods, brokerages, publications,
prompt templates — was hand-built in code; it is the slowest step of
opening a market, and packs-as-code means only a developer can add one.
Perplexity can draft the research half (neighborhoods, prominent
brokerages, local publications) in one call; the platform already has the
installer, the geo-tree upsert, and the standard prompt templates that
only need a city name.

## Design

- `lib/markets/research.ts` — `draftMarketPack(user, {cityName, state},
  caller?)`: ONE `sonar` call (ledgered `market-pack-draft-v1`) asking for
  the city's notable residential neighborhoods, prominent brokerages, and
  local real-estate publications. The result is assembled into a full
  `MarketPackDefinition`: hierarchy = city node + neighborhood children,
  `templates = standardTemplates()` (exported from packs.ts — the same
  battle-tested set every hand-built pack uses), COMMON tiers/segments,
  empty zips/terminology (hand-pack refinements, not research facts).
  Stored in `market_pack_drafts` (payload + citations + confidence,
  insert-only, status pending/installed/rejected).
- `installMarketPackDraft(user, {draftId, priceSegment?})`: the reviewed
  act — refactors `installMarketPack` so registry packs and approved
  drafts share one `installPackDefinition` (no duplicate logic), then
  opens the launch exactly like quick-start. The installed pack records
  `pack_key = draft:<city-slug>` so provenance survives.
- `rejectMarketPackDraft(user, {draftId})`.
- UI: a "Draft new market" dialog beside Quick start on the prospects page
  — city input → research → the draft renders (neighborhoods, brokerages,
  publications, citations) → Install & open launch / Reject.
- Next step after install is spec 080 discovery — deliberately separate:
  geography is cheap to verify at a glance; teams need per-item review.

## Out of scope

Zip codes, terminology, excluded-place curation (operator refinements on
the installed tree); non-US phrasing; auto-install.

## Acceptance criteria

- [x] Draft assembly: research output → valid MarketPackDefinition
      (hierarchy shape, standard templates, city name threading) (unit,
      fake caller).
- [x] Draft → install creates the market tree (city + neighborhoods),
      records the install with draft provenance, opens the launch;
      reject installs nothing (integration).
- [x] Registry packs still install byte-identically through the shared
      path (existing install tests pass unchanged).
- [x] Calls ledger under `market-pack-draft-v1`; failures store failed
      drafts (integration).

## Definition of done

Criteria pass · suites green · lint/typecheck clean · migration
reversible · docs/05 + DECISIONS updated · demoed with a real city draft.
