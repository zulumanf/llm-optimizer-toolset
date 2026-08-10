# Spec 050 — Truth Hardening

**Status:** In progress
**Branch:** `feat/050-truth-hardening`
**Source:** Architecture gap audit 2026-08-09 (P0 findings: mock-scoring bypass, unversioned classification instrument, unrecorded sampling config, invisible agent spend, designed-in entity false-merge, no accuracy measurement of the production classifier).

## Why

The platform's promise is "every number is reproducible from stored raw records." The audit found five places where that promise is currently false or bypassable:

1. `ALLOW_MOCK_PROVIDER=1` — the standard local-dev flag — both permits the mock provider *and* folds its fabricated captures into real score rows (`lib/scoring/compute.ts`). One stray env var in a deployed process yields fabricated client metrics, insert-only, undeletable.
2. The production classifier is an unversioned instrument: `parser_version` says `mention-parser-v2+llm` but records neither the classifier model nor the prompt text version that produced each judgment. Editing `CLASSIFIER_SYSTEM` or changing `CLASSIFIER_MODEL` changes every future measurement with no stamp changing and no CI signal.
3. Sampling configuration is recorded nowhere, although `docs/07-experiment-protocol.md` claims "temperature/params (provider defaults, recorded)". A run cannot be replayed even to the same configuration.
4. Every `runAgent` call's cost is computed and discarded; the daily spend ceiling and all dashboards see only `responses.cost_usd`. Classification — the highest-volume LLM task — is invisible spend.
5. `normalizeEntityName` strips `team`/`group`, so "Hudson Advisory" and "Hudson Advisory Team" score `exact` (auto-match at 0.90) — a designed-in false merge for real estate, asserted as desired behavior in tests. Separately, `createBenchmarkProject` resolves prospects by exact `lower(name)` match-or-create, bypassing the resolver and minting duplicate companies.
6. The only CI-gated accuracy corpus tests the deprecated heuristic parser; the LLM classifier that actually runs has no accuracy measurement, and the human review queue's gold labels are discarded as an accuracy signal.

## Scope

### A. Mock-data isolation
- Split the mock decision in two: `mockProviderAllowed()` (may the mock *run*) stays as-is; new `mockScoringAllowed()` (may mock captures *count as measurements*) is true only under the test runner (`NODE_ENV=test` / `VITEST`) or an explicit `ALLOW_MOCK_SCORING=1`, and **always false when `AUTH_MODE=supabase`** — the real-auth posture never scores fabrications, no matter what flags say.
- `computeScores` and the prospect benchmark-link guard use `mockScoringAllowed()`.
- Seed scripts and the Playwright harness (isolated DBs, dev auth) set `ALLOW_MOCK_SCORING=1` explicitly.

### B. Instrument versioning (migration 058)
- `responses.request_params jsonb` — the sampling configuration the adapter actually sent (provider-default sampling is recorded *as* `"provider_default"`; explicit values like Anthropic's `max_tokens: 8192` are recorded as values). `ProviderResult.requestParams` becomes a required field so an adapter cannot forget it.
- `mentions.classifier_model` / `mentions.classifier_prompt_version` and the same pair on `response_parses` — stamped with what actually classified the row (null for heuristic parses).
- Prompt-edit tripwire: a unit test pins the SHA-256 of `CLASSIFIER_SYSTEM` and `VERIFIER_SYSTEM`; editing either prompt without bumping its version constant (and the pinned hash) fails CI.

### C. Unified LLM cost ledger (migration 059)
- `llm_calls` (insert-only, `forbid_mutation`): agent_version, model, purpose, project_id (nullable), tokens_in/out, cost_micro_usd, attempts, success, called_at.
- `runAgent` records every call — success *and* terminal failure — via `lib/ai/ledger.ts` (write failure is logged, never fails the agent call).
- `runAgent` accepts optional `projectId`/`purpose`; the classification path threads `projectId` through (the highest-volume caller). Other callers may pass null — their spend still counts globally.
- `spendLast24hUsd()` (the `DAILY_SPEND_CEILING_USD` input) becomes `responses.cost_usd + llm_calls.cost_micro_usd` over the window. **Semantics change:** agent spend now draws down the same daily ceiling as benchmark runs. Per-client rollups (`db/operations.ts`) include project-scoped `llm_calls`.

### D. Entity-resolution fixes
- `scoreNameMatch`: equality that exists *only because* distinguishing tokens (`group`, `team`) were stripped is demoted from `exact` to `probable` (requires review). Legal suffixes (`llc`, `inc`, `ltd`, `corp`, `corporation`, `co`) and the article `the` still collapse — those genuinely don't distinguish firms. `normalizeEntityName` itself is unchanged (recall must stay wide; precision is the judgment layer's job).
  - Consequence: "The Rivera Group" vs company "Rivera Team" resolves `possible` (human decides), no longer auto-`match`. The existing test asserting auto-match is updated deliberately — in real estate those are frequently different firms.
- `createBenchmarkProject` resolves the prospect through `resolveProspectCompany` (same resolver as discovery) instead of exact-name-or-create: `match` links, `possible` refuses with the candidates named (operator resolves via the existing link flow first), `none` creates. No more silent duplicate minting.

### E. Classifier gold-set evals + review-queue disagreement (migration 060)
- `lib/accuracy/classifier-gold.ts`: versioned gold corpus (`classifier-gold-v1`) of labeled cases targeting the LLM classifier's actual judgments, including the real-estate traps: brokerage-vs-team, Team/Group near-collisions, same-name-different-entity, passing/list-only mentions, negative-sentiment mentions.
- `lib/accuracy/classifier-eval.ts`: `evaluateClassifier({caller?})` runs the gold set through `classifyResponseLlm` (injectable caller — deterministic in CI, live via script), computes precision/recall for `mentioned` and `recommended` plus entity-rejection accuracy with pure math, persists a `classifier_evaluations` row (gold-set version, prompt version, model, metrics, per-case failures), and returns pass/fail against exported floors (mentioned P≥0.90/R≥0.85; recommended P≥0.85/R≥0.80).
- `scripts/eval-classifier.ts`: operator-run live evaluation; non-zero exit below floors. Run it before shipping any classifier prompt/model change (the hash tripwire in B forces the version bump; this script proves the new version).
- `lib/accuracy/disagreement.ts`: `classifierDisagreementRate(windowDays)` — deterministic SQL over reviewed mention revisions: of the human-reviewed rows, how often did the human overturn `mentioned`/`recommended`? The review queue already produces this gold signal; this stops discarding it.

## Out of scope (queued)
- Spec 051 — Value loop closure (verdicts to client surfaces, live verification, delivery).
- Spec 052 — Manual outbound safety (evidence-bound audits, compliant sender, PII deletion, territory re-checks).
- Fleet drift/sentinel, shared market captures, model routing tiers (scale phase).

## Acceptance criteria
- [ ] With `ALLOW_MOCK_PROVIDER=1` and `AUTH_MODE=supabase`, `computeScores` excludes mock captures (test).
- [ ] `ALLOW_MOCK_SCORING=1` without supabase auth scores mock (seed/e2e path still works); with supabase auth it does not (test).
- [ ] New successful responses carry `request_params`; all five adapters return `requestParams` (compile-time required field).
- [ ] v2 parses stamp `classifier_model` + `classifier_prompt_version` on mentions and `response_parses`; heuristic parses stamp null (test).
- [ ] Editing `CLASSIFIER_SYSTEM` without bumping `MENTION_CLASSIFIER_V2` fails a unit test.
- [ ] Every `runAgent` call writes an `llm_calls` row, including terminal failures (test); `llm_calls` is insert-only (test).
- [ ] `spendLast24hUsd()` includes agent spend (test).
- [ ] "Hudson Advisory Team" vs "Hudson Advisory" → `probable`/`possible`, never auto-match (test); "The Hudson Advisory" vs "Hudson Advisory" stays `exact` (test).
- [ ] `createBenchmarkProject` refuses with candidates named when resolution is `possible`; links on `match`; creates on `none` (tests).
- [ ] `evaluateClassifier` computes correct metrics for a known stub caller and persists a row (tests); floors exported; script exits non-zero below floors.
- [ ] `classifierDisagreementRate` returns correct rate over seeded reviewed revisions (test).
- [ ] Migrations 058–060 reversible (CI walks up/down/up).
- [ ] `npm test`, lint, typecheck green.
