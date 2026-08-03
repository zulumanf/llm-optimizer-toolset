# Spec 038 — Prospect Authority Score, Valuable Visibility, and the Numeric Gap

Phase B of `docs/implementation-plan.md`. Requirements 10–12 of the target pipeline
(`docs/architecture/target-pipeline.md`): a 0–100 local-authority score computed from
verified evidence, an intent-weighted ("valuable") AI-visibility score computed from a
linked benchmark run, and their difference — the visibility gap — shown with both
components and the evidence behind each.

## Principles applied

- **Derived on read, never stored.** Like spec 036's win rates and spec 032's benchmark
  deltas, these are computations over data the platform already trusts (`prospect_authority_signals`,
  current-revision `mentions`, frozen prompt snapshots). Storing them would create a
  second copy that can drift. Each computation carries a code version constant displayed
  with the number (`authority-v1`, `valuable-visibility-v1`).
- **No new weights mechanism.** Weights are named constants in the owning module (the
  existing `AUTHORITY_WEIGHTS` pattern). Phase C introduces the single configurable
  weights table; these constants migrate into it then.
- **One commercial-intent model.** The duplicate identified in the audit
  (`IntentTier` vs `CATEGORY_VALUE` in `lib/gaps/detect.ts`) is unified into
  `lib/scoring/intent.ts`. Gap detector outputs are byte-identical after the move
  (the category table relocates verbatim; tiers take precedence only in the new code path).
- **Null is never zero.** No signals → authority is null. No organic responses →
  visibility is null. The gap exists only when both components do.

## 1. Migration 044 — signal scope and retrieval date

```sql
alter table prospect_authority_signals
  add column scope text not null default 'local'
    check (scope in ('local', 'global')),
  add column retrieved_at timestamptz;
```

- `scope`: "Global sales volume must not automatically count as local authority."
  Global-scope signals are **excluded from the authority score** and listed with the
  reason, not silently discounted. Default `'local'` matches every existing row's
  intent (signals are recorded against a prospect inside a market launch).
- `retrieved_at`: when the fact was read from its source (freshness display lands in
  Phase F; capturing the date starts now so history exists).
- **Not added:** `verification_status`. The provenance label already carries the
  verification axis (`verified` requires a source URL, enforced in `addAuthoritySignal`);
  a second column would duplicate the concept — exactly the audit's §8 criticism.

## 2. `lib/scoring/intent.ts` — one commercial-intent value

- `INTENT_TIER_WEIGHTS = {1: 1.0, 2: 0.8, 3: 0.6, 4: 0.4}` (tier semantics from
  `lib/verticals/types.ts`).
- `CATEGORY_INTENT_VALUE` moves verbatim from `lib/gaps/detect.ts`
  (recommendation 1.0, problem 0.9, comparison 0.8, branded 0.6, how-to 0.4).
- `commercialIntentWeight({tier, category})`: tier weight when the prompt has a tier,
  category value otherwise, `0.5` for unknown categories.
  `lib/gaps/detect.ts` imports the category table from here; its numbers do not change.

## 3. `lib/prospects/authority.ts` — local authority profile (pure)

Input: the prospect's signals (`id, kind, provenance, scope, confidence`).
Output:

```ts
interface AuthorityProfile {
  version: "authority-v1";
  score: number | null;        // 0–100; null when nothing counted
  confidence: number | null;   // 0–1 data confidence
  components: { key; label; points; maxPoints; signalIds: string[] }[];
  excluded: { signalId; reason: string }[];
}
```

Components (max points sum to 100), fed by signal kinds:

| Component | Max | Kinds (points per kind) |
|---|---|---|
| Sales evidence | 30 | transaction_volume 12 · transaction_count 8 · avg_deal_value 4 · notable_sale 3 · notable_listing 3 |
| Market recognition | 25 | ranking 15 · award 10 |
| Reputation & tenure | 20 | review_footprint 12 · years_in_market 4 · team_size 4 |
| Media & content | 15 | press_mention 8 · market_report 4 · video_content 2 · speaking 1 |
| Specialization | 10 | specialization 10 |

Rules:
- Effective points per signal = kind points × provenance factor × (signal confidence ?? 1).
  Provenance factors: verified 1.0 · publicly_sourced 0.85 · manual 0.6 · estimated 0.4 ·
  ai_inferred 0.25.
- **Max per kind, not sum** — five press mentions score once (the best one); stuffing
  cannot inflate the score. The count still shows in the UI via signalIds.
- `scope = 'global'` → excluded entirely, reason attached. `kind = 'other'` → excluded
  (unclassifiable evidence earns display, not points).
- Confidence = 0.5 × (mean provenance factor of counted signals) + 0.5 × (components
  with evidence ÷ 5).
- Score = Σ min(component points, component max); null when no signal counted.

## 4. Valuable visibility — `lib/scoring/valuable.ts` (pure) + `valuableVisibility(runId, companyId)` in `lib/prospects/benchmark.ts`

Data per valid, non-holdout response of the linked run, for the prospect's company:
frozen tier/category (snapshot `jsonb_to_recordset`, the gaps-service pattern),
`promptNamedCompany` (alias-token match on prompt text — same exclusion the gap
detector uses: echo is not visibility), and the current-revision mention
(`mentioned`, `recommended`, `list_position`).

Per-response credit ∈ [0, 1]: `0.5·mentioned + 0.35·recommended + 0.15·top3`
(top3 = listed at position ≤ 3; an unlisted mention simply isn't in that numerator —
the `first_position_rate` convention from docs/06).

Over **organic** cells only (prompt did not name the prospect), each weighted by
`commercialIntentWeight`:

```ts
interface ValuableVisibility {
  version: "valuable-visibility-v1";
  score: number | null;                 // 100 × Σ(w·credit) / Σw
  weightedMentionRate: number | null;   // Σ(w·mentioned) / Σw
  weightedRecommendationRate: number | null;
  highIntentMentionRate: number | null; // plain rate over cells with w ≥ 0.8; null if none
  organicResponses: number;             // sample size (repetitions are cells)
  brandedExcluded: number;              // cells dropped because the prompt named the prospect
}
```

Null score when there are no organic cells. Repetitions aggregate naturally: every
response is one cell, so 2 prompts × 3 reps = 6 cells in the denominator — asserted
explicitly in tests.

## 5. The gap

`visibilityGap = authority.score − valuable.score`, computed at render only when both
are non-null. Surfaces:

- **Prospect detail** (`app/prospects/[id]`): new "Authority vs AI visibility" section —
  both scores with version labels, the gap, authority components with their signal
  evidence, excluded signals with reasons, visibility sub-metrics with sample size.
- **Audit snapshot** (`publishAudit`): optional `authorityGap` field added to
  `AuditSnapshot` (additive; old published audits render unchanged). Public page
  (`app/audit/[token]`) renders the section only when present: scores, gap, and the
  counted signal statements with provenance labels and source URLs — no internal ids.
- `addAuthoritySignal` accepts `scope` (default local) and `retrievedAt`; the signal
  dialog gets a scope select.

## Acceptance criteria

- [x] Authority: known-answer fixtures per component; global-scope and `other` signals
      excluded with reasons; provenance discounts applied; max-per-kind enforced;
      empty → null score; confidence formula verified.
- [x] Valuable visibility: branded/holdout cells excluded; tier weighting applied;
      tier precedence over category; repeated-run aggregation (N reps = N cells);
      no-organic-cells → null; credit composition verified.
- [x] Gap renders on prospect detail with both components + evidence; absent when either
      side is null (never rendered as 0).
- [x] `publishAudit` snapshot carries `authorityGap` when computable; previously
      published audits are untouched (immutability preserved).
- [x] `lib/gaps/detect.ts` outputs byte-identical findings after the intent-value move
      (existing `gap-detect` tests unchanged and green).
- [x] Migration 044 up and down; existing signals readable with `scope='local'`.
- [x] Full suite, typecheck, lint, build green.

## Test plan

`tests/unit/prospect-authority.test.ts`, `tests/unit/valuable-visibility.test.ts`
(pure, known-answer); `tests/integration/prospect-authority-gap.test.ts` (scored mock
run → signals → profile/visibility/gap through the real read path; snapshot field on
publish; old-audit compatibility). Existing `gap-detect` and `prospects` suites must
pass unmodified.
