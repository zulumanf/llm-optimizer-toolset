# Spec 004 — Response Classification & Review

> Status: done (2026-07-27)
> Depends on: specs/003 · docs/06 (confidence) · docs/12 (parser design) · docs/13 (MENTION_PARSER_V1)
> Branch: feat/004-response-classification
>
> Implementation notes: parser v1 is deterministic-heuristic only
> ("mention-parser-v1+heuristic") — the LLM refinement stage becomes a new
> parser_version once provider keys exist (see DECISIONS.md); ambiguity maps
> to lowered confidence so uncertain rows reach human review. Scores carry a
> `provider` column ('all' = cross-provider aggregate) — docs/03 updated.
> Parse state lives in a `response_parses` ledger (responses are immutable).
> Re-parse appends retraction revisions for companies that no longer match.
> The accuracy corpus is hand-written realistic text (22 labeled cases,
> precision 0.958 / recall 1.0); real captured fixtures accumulate once real
> provider runs exist. The fuzzy alias tier is deliberately absent from the
> heuristic parser (too false-positive-prone without an LLM check).

## Goal
Turn raw responses into structured `mentions` (mentioned/recommended/position/sentiment/citations) with per-field confidence, route low-confidence parses to a human review queue, and compute the first scores (mention rate, recommendation rate) behind the review gate. Includes `companies` management (Parva + aliases) and the accuracy harness.

## User stories
- As the system, every captured response is parsed automatically after its run completes.
- As an operator, I manage the company registry (canonical name, aliases, domain, `is_self`).
- As an operator, I work a review queue of low-confidence mentions, confirming or correcting against the highlighted raw text.
- As an operator, once a run's queue is clear, I see mention rate and recommendation rate for it.

## UI

Review queue (`/projects/[id]/review`):
```
│ Review queue — 7 items                       run: [All ▾]    │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Parva · conf 0.62 (fuzzy alias) · run W31 · openai rep 3 │ │
│ │ "…for smaller teams, **Parva's** planner is decent…"     │ │
│ │ mentioned [✓]  recommended [ ]→[?]  pos [–] sent [neu ▾] │ │
│ │            [Confirm as parsed]  [Save correction]        │ │
│ └──────────────────────────────────────────────────────────┘ │
│  Right drawer: full raw response, brand hits highlighted     │
```
Companies settings page: table of companies with aliases (tag input), domain, is_self badge. Run detail gains a "Scores" tab: mention/recommendation rate per company per provider, with N, coverage, scoring version — or "blocked: 7 items awaiting review".

## Database changes
Migration `004_classification.sql`: `companies`, `mentions`, `scores`, `sources` per `docs/03`, plus:
- Partial unique index enforcing exactly one `is_self = true` company.
- `mentions` revision model: unique `(response_id, company_id, revision)`; current = max revision.
- Trigger: `mentions` rows are insert-only (corrections = new revision; originals immutable).
- `scores` unique `(run_id, company_id, metric, scoring_version)`.

## `lib/parsing/` + `lib/scoring/`
Per `docs/12`: deterministic pre-pass (alias scan incl. word-boundary + fuzzy tiers, URL extraction, list detection) → `MENTION_PARSER_V1` LLM call (Zod-validated JSON; excerpt must be verbatim substring or confidence penalty + review) → confidence formula per `docs/06` → rows written with `parser_version = 'mention-parser-v1+<model-id>'`. Scoring v1.0: `mention_rate`, `recommendation_rate` per `docs/06` (per provider + aggregate), computed by `compute_scores` job only when the run's review queue is empty (or 72h timeout exclusion, flagged in coverage).

## API

| Action | Input | Auth | Audit |
|---|---|---|---|
| `upsertCompany` | `{ id?, name, aliases: string[], domain?, isSelf? }` | operator (isSelf change: admin) | `company.upsert` |
| `archiveCompany` | `{ id }` | admin | `company.archive` |
| `reviewMention` | `{ mentionId, verdict: 'confirm' \| 'correct', corrections?: {mentioned?, recommended?, listPosition?, sentiment?} }` | operator | `mention.review` |
| `reparseRun` | `{ runId }` (after parser/alias updates; writes new revisions) | admin | `run.reparse` |

Jobs: `parse_response` (per response, enqueued on run completion), `compute_scores` (per run, enqueued when queue empties).

## Validation rules
- Company name unique (case-insensitive); aliases non-empty strings, deduped, no alias may equal another company's name/alias (collision → block with pointer to the conflict).
- Exactly one `is_self` company must exist before any parse job runs (parse refuses and alerts otherwise).
- `reviewMention` only on current-revision rows with `needs_review = true` (or spot-check flag); correction writes revision+1 copying unmodified fields, sets `reviewed_by/at`, confidence 1.0.
- Scores computed only under the review gate; every score row records N and scoring_version.

## Edge cases
- Response with zero brand mentions → valid; one "no mentions" marker per company is NOT written — absence of a mention row for the current parser revision means not-mentioned; denominators come from response counts, not mention rows.
- Alias collision discovered later ("Parva" matches an unrelated "Parva Labs") → operator narrows aliases → `reparseRun` for affected runs → new revisions; old scores stand (new scoring rows computed from new revisions get the same scoring_version but later `computed_at`? **No** — re-scoring after re-parse writes rows only if none exist for that (run, metric, version); if they exist, re-scoring requires an explicit new scoring version. Keep v1 simple: re-parse before scoring, or accept and annotate.)
- Refusal-flagged responses → parsed as no-mentions, counted in N (a refusal is a real answer users would see); coverage notes refusal count.
- Non-English response to an English prompt → parser handles it (model is multilingual); language recorded; no special casing in v1.
- Parser JSON invalid twice → all companies for that response flagged `needs_review` with confidence 0.
- 72h timeout → excluded items flagged; if later reviewed, scores for that run are NOT retroactively updated (immutable); the review lands in the next scoring context. Report coverage shows the exclusion.

## Acceptance criteria
- [ ] Completing a run auto-enqueues parsing; every response gets current-revision mention rows (or none, meaning no brands) with parser_version + confidence.
- [ ] Excerpts are verbatim substrings of response_text (validated in tests over the fixture corpus).
- [ ] Confidence <0.7 rows appear in the queue; confirming/correcting writes an immutable new revision with reviewer identity.
- [ ] Scores appear only after the run's queue is empty; blocked state is visible on the run.
- [ ] Mention rate & recommendation rate match hand-computed values on a seeded fixture run, per provider and aggregate.
- [ ] Accuracy harness runs in CI against the labeled fixture corpus; precision on `mentioned` ≥ 0.90 gate.
- [ ] Alias collision is blocked at company save with a clear message.

## Test cases
- **Unit:** alias matcher tiers (exact/alias/fuzzy/word-boundary; "Parva" vs "Parvati" no-hit), confidence formula fixtures, scoring known-answers (incl. N=0, all-refusals), excerpt-substring validator.
- **Integration:** parse pipeline over recorded fixtures through the real queue; revision immutability trigger; review gate blocks scoring; exactly-one-is_self constraint.
- **E2E:** run completes (mock provider) → queue shows low-confidence item → correct it → scores tab renders rates with N.
- **Harness:** `npm run test:parser-accuracy` over `tests/fixtures/responses/labeled/`.

## Definition of done
Per `specs/_TEMPLATE.md`, plus: parser accuracy report committed with the PR, and 20+ labeled real fixtures in the corpus.
