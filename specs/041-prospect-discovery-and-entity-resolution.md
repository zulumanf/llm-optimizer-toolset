# Spec 041 — Provider-Based Prospect Discovery and Entity Resolution

Phase E of `docs/implementation-plan.md`. Target-pipeline requirements 3 and 5: a
provider-adapter layer through which prospects can be *discovered* (not just typed or
imported), with every fact wrapped in a provenance envelope and every candidate passing
human review before becoming a prospect; and prospect↔company entity resolution
(match / possible / none, confidence, reasons) where **a brokerage mention never
auto-counts as the agent or team**, plus a cross-launch duplicate surface.

## Principles applied

- **No adapter is "the" provider.** `ProspectSourceAdapter` is the contract; the
  registry ships a fixture-backed mock (guarded out of production exactly like the
  mock AI provider — reuse `mockProviderAllowed`). Licensed adapters slot in later
  without touching the flow.
- **Discovered ≠ trusted.** Adapter output lands as **candidates** in a review table
  with the full `SourceRecord` envelope; only an operator's approval creates a
  prospect — through `createProspect`, the one persistence path, so dedup, audit,
  and provenance rules cannot fork. Raw candidate payloads are kept.
- **Resolution reuses the platform's matcher.** `scoreNameMatch`/`bestMatch` and
  `normalizeEntityName` from `lib/knowledge/normalize.ts` — no second name-matching
  algorithm. Ambiguity stays ambiguous (two equal scores → possible, never a coin
  toss); nothing below a match auto-links.
- **Deviation from the plan sketch, recorded:** CSV/manual ingestion is *not*
  refactored onto `SourceRecord` — those paths already record `source` +
  `field_provenance` per fact (spec 032); wrapping them would churn shipped code for
  symmetry's sake. The envelope is the adapter contract.
- **Deferral, recorded:** discovery runs execute inline (the only adapter is the
  instant mock); when a real network adapter lands, execution moves onto the `jobs`
  queue per the job architecture.

## 1. Migration 047

```sql
create table prospect_discovery_runs (
  id, launch_id → market_launches, provider text, params jsonb,
  status queued|running|completed|failed, error text,
  candidate_count int, started_by, started_at, completed_at
);
create table prospect_discovery_candidates (
  id, discovery_run_id →, launch_id →,
  business_name text, payload jsonb,        -- the full RawProspect
  provider text, source_type text, source_url text,
  retrieved_at timestamptz, confidence numeric, provenance text,
  status pending|approved|dismissed|duplicate,
  resolution jsonb,                          -- CompanyResolution at review time
  created_prospect_id → prospects, reviewed_by, reviewed_at, created_at
);
```

## 2. `lib/prospects/providers/` — the adapter layer

```ts
interface SourceRecord<T> {
  data: T; provider: string; sourceType: string; sourceUrl?: string;
  retrievedAt: string; confidence: number;
  provenance: ProvenanceLabel;               // maps onto the platform's labels
}
interface RawProspect {
  businessName; prospectType?; teamLeader?; brokerageAffiliation?;
  website?; email?; phone?; neighborhoods?; specialties?; priceSegment?;
}
interface ProspectSourceAdapter {
  readonly id: string;
  discoverProspects(input: { marketName; segment?; limit? }): Promise<SourceRecord<RawProspect>[]>;
  validateConfiguration(): Promise<{ ok: boolean; detail: string }>;
}
```

Registry: `getProspectSource(id)`; `mock` refused outside tests/`ALLOW_MOCK_PROVIDER`.
The mock returns deterministic fixture teams for a market input (clearly fictional
names — fixtures, not fabrication).

## 3. Discovery flow — `lib/prospects/discovery.ts`

- `runProspectDiscovery(user, {launchId, provider, segment?, limit?})`: records the
  run, calls the adapter, stores each record as a pending candidate (envelope +
  payload), completes or fails the run honestly. Inline for the mock (deferral above).
- `reviewDiscoveryCandidate(user, {candidateId, decision: approve|dismiss, companyId?})`:
  approve → runs the resolver against tracked companies, then `createProspect`
  (`source='research'`, every populated fact labeled with the record's provenance,
  candidate's `source_url` recorded on an authority signal when present? — no:
  the URL stays on the candidate row; signals remain operator-curated). A duplicate
  (same name in launch) is recorded as `status='duplicate'`, not an error. The
  resolution verdict is stored on the candidate; `verdict='match'` auto-links
  `company_id`, `possible` leaves it null for the detail-page suggestion.

## 4. Entity resolution — `lib/prospects/resolve.ts` (pure) + reads

`resolveProspectCompany(input, companies)` where input = {businessName, website,
brokerageAffiliation, teamLeader} and companies carry {id, name, aliases, domain}:

- Signals: website-domain equality (0.95, decisive identity); name/alias via
  `scoreNameMatch` (exact 0.9 / probable 0.65 / ambiguous 0.45, best across
  name+aliases); +0.05 when domain and name agree; team-leader surname appearing in
  the company name +0.1.
- **Brokerage rule:** companies whose match is explained by the prospect's
  *brokerage affiliation* (affiliation matches the company at least as well as the
  business name does, and there is no domain tie) are excluded from candidacy and
  reported as `brokerageCollisions` with reasons — "Rivera Team at Compass" never
  resolves to the company "Compass".
- Verdict: top ≥ 0.85 → `match`; ≥ 0.5 → `possible`; else `none`. Equal top scores →
  `possible` with both listed (ambiguity surfaced, not resolved). Output always
  carries `reasons[]`.

Reads: `suggestCompanyForProspect(prospectId)` (detail-page suggestion when
`company_id` is null; confirm uses the existing `updateProspect`) and
`listProspectDuplicates()` — cross-launch pairs sharing a normalized business name,
website domain, or `company_id`, for the prospects page.

## 5. UI

- Prospects page: "Discover" dialog (launch + provider + segment/limit) → pending
  candidates section with per-candidate approve/dismiss, envelope shown (provider,
  source URL, retrieved date, confidence, provenance), resolution verdict displayed.
- Prospect detail: company-match suggestion card (verdict, confidence, reasons,
  one-click link) when no canonical company is set.
- Prospects page: cross-launch duplicates card.

## Acceptance criteria

- [x] Mock adapter is refused outside tests unless `ALLOW_MOCK_PROVIDER=1`; the flow
      is fully runnable keyless in CI.
- [x] Candidates persist the full envelope; approval creates a prospect through
      `createProspect` with per-fact provenance; dismissal and duplicate outcomes
      recorded; raw payload retained.
- [x] Resolver: exact/alias/domain matches, possible-verdict band, none-verdict,
      brokerage collision never proposed, tie → possible, reasons populated —
      all known-answer unit tests.
- [x] `match` auto-links company on approval; `possible` shows as a detail-page
      suggestion; confirming writes through `updateProspect` (audited).
- [x] Cross-launch duplicates listed by name/domain/company overlap.
- [x] Migration 047 up/down; full gates green.
