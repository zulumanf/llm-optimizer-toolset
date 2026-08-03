# Target Pipeline — Real-Estate AI Visibility Prospecting

How the target user flow maps onto the **existing** architecture. Rule of thumb: the measurement core (specs 002–004, 033) and the prospect slice (spec 032/038) are kept as-is; new capabilities are added as `lib/` modules + migrations that *compose* them. Nothing here proposes a second scoring system, second entity registry, or second outreach stack — the audit (`docs/qa/current-state-audit.md` §8) shows we already have too many near-duplicates.

## Flow → owner map

```text
Choose city and prospect criteria            → markets tree (032) + market_launches (038) + listProspects filters [extend]
Build the local agent/team universe          → createProspect / CSV import (042, in flight) / ProspectSourceAdapter [new]
Collect sales, reputation, contact evidence  → prospect_authority_signals (038) + prospect_contacts (042) [wire]
Generate high-intent city-specific prompts   → market packs [new] → lib/verticals/expand.ts [extend] → prompts (source='expansion')
Run repeated AI visibility tests             → runs/responses (003, immutable) via prospect-owned projects (041) — unchanged
Resolve agent/team/brokerage entities        → lib/parsing + lib/mentions review queue [reuse] + prospect↔company resolver [new]
Measure valuable AI visibility               → lib/scoring/metrics.ts [extend: weighted metric, new scoring_version]
Diagnose why each prospect is missing        → diagnosis module over response_citations + gap machinery [new]
Calculate fixability                         → lib/prospects/fixability.ts [new], subscores + hard flags stored
Add buying signals and contactability        → prospect_buying_signals [new] + contacts-derived contactability score
Rank prospects                               → configurable-weights composite → prospects.qualification_score [wire existing column]
Generate evidence-backed mini-audit          → publishAudit (038) — unchanged, snapshot extended with new scores
Human QA                                     → finding review + stage ladder + mention queue (existing)
Approve personalized outreach                → outreach drafts + approve gate (038) + suppression bridge [in flight]
Track replies, meetings, conversions         → stage ladder + prospect_stage_history now; funnel analytics (roadmap 3.7)
Use outcomes to improve scoring              → lib/outcomes + learnings [reuse]; recommendations only, never auto-reweight
```

## Stage detail

### 1. Market selection
`markets` (self-referencing tree with aliases) gains kinds `country|state|metro|county|zip` alongside the existing five; hierarchies are seeded per market pack (NYC, Jersey City/Hudson County, Miami, Chicago, Boston) as **data**, not code. Prospect filtering extends `listProspects` with stage/market/type/segment/score predicates — no new route, same page.

### 2. Universe building
Three ingestion paths, one persistence function (`createProspect`), so provenance and dedup rules cannot fork:
- Manual entry (exists).
- CSV import (in flight): `parseProspectImport` → per-row create with `source='csv'`, `field_provenance` on every populated fact, optional contact row, per-row created/duplicate/error report. Never partial-writes a row.
- `ProspectSourceAdapter` (future): `discoverProspects` / `fetchProspectDetails` / `validateConfiguration`, returning `SourceRecord`-wrapped raw prospects into a review-then-persist queue. No adapter is hard-coded as "the" provider; CSV and manual remain first-class.

### 3. Evidence collection
`prospect_authority_signals` already carries kind/label/value/source URL/provenance/confidence. Additions: `retrieved_at` + `verification_status` columns (audit §6 row 11), and signal kinds distinguish **local** volume/rank from global. Every audit-visible claim keeps its signal id.

### 4. Prompt generation
Market packs are data records (per city): geography refs into `markets`, neighborhoods, ZIPs, property categories, price tiers, buyer/seller segments, local terminology, relevant brokerages, local publications, ambiguous-name exclusions, and prompt templates. `lib/verticals/expand.ts` consumes them exactly as it consumes vertical packs today (deterministic cartesian expansion, tier-ordered, capped). Generated prompts store market/neighborhood/category/tier/audience/price-tier + template lineage. Branded vs non-branded stays `PromptCategory`. The two intent-value models (`IntentTier` vs `CATEGORY_VALUE`) are unified into the tier before weighted visibility ships.

### 5–6. Execution & entity resolution
Unchanged: frozen prompt-set versions → runs → immutable raw responses → parsed mentions with confidence-routed human review. Repeated runs are already supported (each run is a new row; stability labels come from `lib/evidence/stability.ts`). The execution environment stays honestly labeled (API model + search mode, not the consumer app — `docs/07`).
New: a prospect↔company resolution pass (normalized name, aliases, brokerage, website domain, team members, geography) returning match/possible/no-match + confidence + reasons; low-confidence lands in the existing review-queue pattern. A brokerage-company mention never auto-counts for an agent/team prospect — resolution is by `company_id` identity, not name echo.

### 7. Valuable visibility
A new metric family under a new `scoring_version` (old scores stay, per AI rules): weighted mention rate = Σ over cells of (intent-tier weight × position factor × recommendation strength × market/specialty relevance) / weighted denominator, plus recommendation rate, mean position, high-intent visibility, citation share, stability. Raw metrics remain side-by-side; null stays "not measured."

### 8–10. Gap, diagnosis, fixability
- **Authority score:** computed from verified signals only, evidence list attached; global volume excluded from local authority.
- **Visibility gap** = authority score − weighted visibility, both components + evidence always shown.
- **Diagnosis:** typed findings (missing-from-cited-sources, weak neighborhood content, entity confusion, thin reviews, …) each with evidence, confidence, affected prompts, competitors, cited sources, suggested action — derived from `response_citations`/`sources` classification (036) + parsing output.
- **Fixability:** 6 subscore categories (20/20/15/20/15/10) with per-subscore evidence, `adjusted = raw × data_confidence`, hard flags that downgrade-and-explain rather than delete.

### 11–13. Rank, audit, QA
Final score = configurable weights (single weights mechanism, stored + versioned, not a fifth hardcoded table) over authority/gap/adjusted-fixability/competitor-advantage/buying-signals/contactability, written to `prospects.qualification_score` with a component breakdown the UI explains. Mini-audit (`publishAudit`) snapshot gains the new score sections; immutability and token access unchanged. QA stays the existing ladder + review queues; score overrides record a reason.

### 14–16. Outreach & feedback
First outreach is never auto-sent (unchanged). Approval path now checks, fail-closed: prospect DNC → contact DNC → `suppression_entries` match on normalized contact identifiers → prohibited phrases → evidence claims. Replies/meetings/conversions ride the stage ladder; funnel analytics and reply ingest are roadmap Phase 3. Outcomes feed `lib/learnings` recommendations — weight changes always go through human approval.

## Invariants carried forward

- Raw responses immutable; re-runs are new rows; re-scoring is a new version.
- Every displayed number traces to stored evidence rows.
- Failed runs recorded as failed; nulls never rendered as zeros.
- No consumer-chat scraping; API execution honestly labeled.
- Mock providers guarded out of production; the app runs keyless end-to-end.
