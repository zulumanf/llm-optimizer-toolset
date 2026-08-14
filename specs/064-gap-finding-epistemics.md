# Spec 064 — Gap Finding Epistemics: Confidence, Classification, Evidence Linkage

## Why

The 2026-08-12 whole-OS audit found the client-side diagnosis engine
epistemically weaker than the prospect-side one it predates: spec 009
promised `gap_findings` confidence and evidence links and migration 009
shipped neither, while `prospect_findings` carries confidence, evidence
arrays, and a DB CHECK that approval requires evidence. Concretely:

- A gap finding asserts "X appears in 4% of answers vs Y at 38%" with no
  confidence, no epistemic label, and no way to click through to what was
  counted. The platform's core principle — observation vs supported finding
  vs hypothesis must live in the data model, not prompt wording — is
  unimplemented exactly where client work starts.
- Traceability breaks twice at this table: findings point at no evidence,
  and task promotion stores no task id (only `status = 'task_created'`), so
  the chain evidence → finding → task → intervention cannot be walked.
- Worse, `createTaskFromFinding` attaches the run's **first score row of
  any company, any metric** as the task's "evidence" — a placeholder link
  that satisfies the tasks CHECK constraint while evidencing nothing.

This spec closes all three, and unblocks the QA-gate consolidation (a gate
can only check "claims have evidence" once findings carry evidence).

## 1. Schema (migration 073, additive, reversible)

`gap_findings` gains:

- `confidence numeric` CHECK 0..1, nullable — legacy detector-v1 rows stay
  null and render "not classified", never a fabricated number.
- `classification text` CHECK in
  `('observation','supported_finding','working_hypothesis','unknown')`,
  nullable for legacy rows. The four platform-wide epistemic labels
  (docs/12), now as data.
- `evidence_ids uuid[] not null default '{}'` — pointers into the
  `evidence` registry (spec 007), same convention as `tasks.evidence_ids`.
- `task_id uuid references tasks(id)` — set at promotion; closes the
  finding → task break.

No backfill invents values: absent epistemics on old rows is the honest
state.

## 2. Detector changes (`gap-detector-v1.1`)

Severity and opportunity-score math are untouched (byte-identical scores);
v1.1 adds epistemics, so re-analysis of already-analyzed runs still no-ops
on the dedup index and historical v1 rows keep their version.

Each finding now emits:

- `classification` per detector: `citation` and `source_target` are
  **observations** (counted facts about the run: zero own-domain citations;
  which domains were cited); `entity`, `branded_recognition`,
  `recommendation`, `category_share` are **supported findings** (counted
  rates plus an interpretive comparison). `working_hypothesis` is reserved
  for the future LLM enrichment detector; the enum admits it now.
- `confidence` from one pure function `sampleConfidence(n)` over the
  finding's own denominator: n ≥ 30 → 0.9, n ≥ 10 → 0.7, else 0.5.
  Deterministic detectors are certain about their arithmetic; what varies
  is how much sample stands behind it.
- `evidence`: typed refs the service resolves to `evidence` rows —
  `score` refs for the stored rates the finding compares (subject and
  competitor `mention_rate`/`recommendation_rate` score ids, now carried on
  `CompanyOutcome.scoreIds`), and `response` refs for findings derived from
  payload scans (sampled contributing response ids, capped, carried on
  `PromptOutcome.sampleResponseIds` and `DomainCitation.sampleResponseIds`).
  Every note states what the ref evidences; responses are immutable rows,
  so the pointers age well.

## 3. Service changes

- `analyzeRun` inserts each finding, then its evidence rows, then sets
  `evidence_ids` — all in the existing transaction; a deduped (skipped)
  finding creates no orphan evidence.
- `createTaskFromFinding` attaches the finding's **own** evidence rows to
  the task (no duplication, no placeholder first-score row; the legacy
  fallback remains only for pre-064 findings with empty evidence), and
  records `task_id` on the finding.
- `suggestTask` gains optional `evidenceIds` (existing registry rows,
  verified to exist in the project) alongside the current create-new
  `evidence` specs; at least one of the two must be non-empty, preserving
  the tasks CHECK semantics.

## 4. Surface

Gaps page: classification and confidence badges per finding, evidence
count with the finding, "not classified" for legacy rows. Control-tower
queue source unchanged (it already ranks by opportunity score).

## Testing

- Unit (`gap-detect.test.ts` extended): per-detector classification,
  `sampleConfidence` bands, evidence refs present and pointing at the
  supplied score/response ids; scores byte-identical to v1 fixtures.
- Integration (`gaps.test.ts` extended): analyzed run produces findings
  whose `evidence_ids` resolve to real evidence rows with the right kinds;
  task promotion reuses those ids verbatim and sets `task_id`; dedup
  re-analysis creates no duplicate evidence.
- Migration 073 up → down → up on the local database.

## Acceptance criteria

- [ ] New findings carry confidence, classification, and ≥1 evidence id;
      legacy rows render honestly unlabeled.
- [ ] Evidence rows' refs point at the exact score/response rows the
      detector used; notes say what each evidences.
- [ ] Task promotion reuses finding evidence (no placeholder score row) and
      sets `task_id`; the chain evidence → finding → task is queryable both
      directions.
- [ ] Detector v1.1 scores are byte-identical to v1 on the same inputs.
- [ ] Lint, typecheck, full suite, migration both directions green.

## Out of scope

QA-gate consolidation itself (next slice; now unblocked), FK-ifying the
platform's other `uuid[]` evidence pointers, the LLM enrichment detector,
`affected_models`/prompt-family columns (needs per-provider detector pass),
immutability triggers on findings (they are mutable working state by
design; evidence rows themselves are already append-only).
