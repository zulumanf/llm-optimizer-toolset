# Spec 040 — Market Packs and City-Specific Prompt Generation

Phase D of `docs/implementation-plan.md`. Target-pipeline requirements 2, 6, 7: a
normalized geographic hierarchy down to county/ZIP, reusable per-city market packs as
**data**, and deterministic generation of high-intent, city- and neighborhood-specific
prompts from templates. Adding a future city must mean adding a data entry, never
changing core logic.

## Principles applied

- **Packs are code-versioned data, installed idempotently** — the vertical-pack
  precedent (`lib/verticals/packs.ts`): a pack is a reviewable TS data structure;
  `installMarketPack` materializes its geography into the existing `markets` tree
  (matching by name/alias under the same parent — re-install updates, never
  duplicates) and records the install with a snapshot (`market_pack_installs`) for
  provenance. No second geo model: the exclusivity `markets` tree is *the* hierarchy.
- **Generation is deterministic and idempotent.** Same pack version + same options →
  same prompts in the same order; texts already in the target set are skipped and
  counted, never duplicated. No LLM.
- **Lineage is stored.** Every generated prompt records `source='expansion'`,
  `template_ref` (`<pack>@v<version>:<template-key>`), `audience`, and `price_tier`
  alongside the existing category/tier. (Frozen snapshots keep their current shape;
  extending `FrozenPrompt` with audience/price-tier is deferred until a consumer
  exists — recorded deliberately.)
- **Ambiguous place names are excluded from expansion, with reasons**, not silently
  dropped: a "Downtown" prompt measures nothing attributable.

## 1. Migration 046

- Widen `markets.kind` check: + `country`, `state`, `metro`, `county`, `zip`
  (constant `MARKET_KINDS` in `lib/exclusivity/constants.ts` updated to match; the
  exclusivity containment logic is kind-agnostic and unchanged).
- **Cycle guard**: trigger on `markets` insert/update-of-parent walking the parent
  chain (depth cap 50), raising on a cycle — the conflict detector recurses over this
  tree and the audit flagged the missing guard (§10).
- `market_pack_installs`: pack_key, version, root_market_id → markets, definition
  jsonb snapshot, installed_by/at; unique (pack_key, version).
- `prompts` + `audience text`, `price_tier text`, `template_ref text` (nullable;
  populated by generation, allowed on manual prompts too).

## 2. `lib/markets/packs.ts` — the pack registry

```ts
interface MarketPackDefinition {
  key: string; version: number; cityName: string;
  hierarchy: GeoNode;              // {name, kind, aliases[], children[]} down to neighborhoods
  zipCodes: string[];              // data for filtering/prompting; not materialized as rows
  propertyTypes: string[]; priceTiers: string[];
  buyerSegments: string[]; sellerSegments: string[];
  terminology: Record<string, string>;
  brokerages: string[]; publications: string[];
  excludedPlaceNames: { name: string; reason: string }[];
  templates: MarketPromptTemplate[];   // {key, text, category, tier, audience, scope, expandPropertyType?, expandPriceTier?}
}
```

Five packs ship: `nyc`, `jersey-city` (Hudson County), `miami`, `chicago`, `boston` —
each with hierarchy (country → state → metro → city → boroughs/counties →
neighborhoods), 8–12 neighborhoods, sample ZIPs, property types, price tiers, buyer and
seller segments, local terminology, prominent brokerages, local publications, and
exclusions. Templates cover the eleven target categories (best local / listing / buyer
agent, luxury, neighborhood specialist, property-type, price-tier, relocation,
investor, international buyer, new development) — a shared standard-template builder
plus per-pack extras (e.g. Tribeca lofts, Brickell condos), so packs stay data.
ZIP-level market rows are deliberately not materialized (hundreds of rows nobody
prompts against); `kind='zip'` exists for future need.

## 3. `lib/markets/install.ts`

`installMarketPack(user, {packKey})` — walks the hierarchy top-down; per node, finds an
existing market under the same parent by lower(name) or alias intersection, else
creates it (audited, reusing the exclusivity service conventions); merges aliases;
records the install snapshot. Returns `{rootMarketId, created, matched}`. Re-install is
a no-op except alias merges.

## 4. `lib/markets/generate.ts`

`expandMarketPack(pack, options)` (pure): for each selected template, areas = [city]
(city scope) or neighborhoods minus exclusions; × property types / price tiers when the
template asks; fills `{area}/{city}/{propertyType}/{priceTier}`; emits
`{text, category, tier, audience, priceTier, templateRef}` in deterministic order,
capped (`MAX_MARKET_PROMPTS = 60`) with an explicit `skipped` count — no silent
truncation.

`generateMarketPrompts(user, {projectId, setId, packKey, templateKeys?, neighborhoods?,
cap?})` (service): expands, skips texts already in the set (case-insensitive), inserts
the rest through the existing prompt path with `source='expansion'` + lineage columns,
returns `{created, skippedExisting, skippedByCap}`.

## 5. UI

"Generate from market pack" dialog on the project prompts page: pack select, target
set select, result summary. (City packs are for prospect-benchmark projects, but any
project may use one.)

## Acceptance criteria

- [x] Geo: installed hierarchy has correct parent-child (country→…→neighborhood)
      verified via the exclusivity `geoRelation`; aliases resolve; re-install
      duplicates nothing; cycle guard rejects a parent cycle.
- [x] Generation: deterministic (same input → identical output), per-city fixture
      assertions (e.g. "Who should I use to sell a condo in Brickell?"), excluded
      names never appear, cap reported not silent, idempotent into a set.
- [x] Lineage: generated prompts carry source/template_ref/audience/price_tier/tier.
- [x] All five packs validate structurally (placeholders known, exclusions exist in
      hierarchy, weights/tiers legal) via a registry test.
- [x] Migration 046 up/down; full gates green.
