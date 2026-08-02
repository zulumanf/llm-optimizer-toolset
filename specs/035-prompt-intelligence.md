# Spec 035 — Prompt Intelligence (deterministic slice)

> Status: done (2026-08-02) — implemented and test-verified; see acceptance checklist
> Depends on: specs/002 (prompt library) · specs/033 (MCP) · docs/ai-visibility-roadmap.md Phase 3 · DECISIONS 2026-07-31 ("deterministic lists, not a model")
> Branch: feat/034-learning-loop line (committed on feat/032-contacts-and-import — see DECISIONS)

## Goal

Prompts stop being purely hand-typed. Operators can bulk-import prompts from CSV or pasted lines with per-row validation, duplicate suppression, and recorded provenance; a versioned deterministic classifier suggests category and intent tier for unclassified rows; and a versioned deterministic clusterer groups a set's prompts by category + shared salient terms — readable in the UI and over MCP. Everything is rule-based, versioned, and unit-tested against hand-labeled fixtures; nothing guesses.

## Non-goals

- **No LLM classification or clustering.** Per docs/12 an LLM classifier ships only WITH a validation set; the deterministic v1 creates that labeling surface first. (LLM v2 stays roadmap.)
- **No demand/search-volume estimation.** No legitimate licensed source exists; a fabricated number is worse than none.
- **No external prompt sources** (Reddit/PAA/keyword tools) — import is operator-supplied text in this slice.
- Clusters are **computed on read, not stored** — v1 is cheap to run and storing versioned cluster snapshots before the algorithm has been used in anger is premature.

## User stories

- As an operator, I can paste a CSV or plain lines into a prompt set and get: N added, M duplicates skipped, K rows rejected with reasons — never a silent partial import.
- As an operator, rows without a category get a rule-based suggestion; a row no rule matches is rejected as "category required", not guessed.
- As an operator or agent, I can see a set's prompts grouped into named clusters and use cluster labels when discussing coverage.
- As an agent over MCP, I can dry-run an import to see what would happen before anything is written.

## UI

Prompt set page: an "Import" button opening a dialog with a textarea (paste CSV or one prompt per line), format hint, and on submit a toast with the added/skipped/rejected counts (rejections listed in the dialog). A "Clusters" section on the set page listing each cluster (label, category badge, member prompts). No new pages.

## Database changes (migration 043, reversible)

- `prompts` + `source text not null default 'manual' check (source in ('manual','import','vertical_pack','expansion'))`. Backfill: existing rows default to `'manual'` (honest: everything so far was typed or pack-seeded through the same manual path; pack-seeded rows created after this migration record `'vertical_pack'`).
- Rollback: drop the column.

## Behavior

### Classifier — `lib/prompts/classify.ts`, `PROMPT_CLASSIFIER_VERSION = "prompt-classifier-v1+deterministic"`

`classifyPrompt(text, { brandNames? }) → { category, tier, rule } | null`. Ordered rules, first match wins (order = specificity):

1. `branded` (tier 3) — text contains a supplied brand name (word-boundary, case-insensitive). No brand list → rule inert.
2. `comparison` (tier 2) — `\bvs\b|versus|compare|comparison|alternative(s)? to|better than|instead of`
3. `how-to` (tier 3) — `^how (do|to|can|should)\b|\bhow to\b`
4. `recommendation` (tier 1) — `\bbest\b|\btop \d|\brecommend|which .{0,40} should (i|we)`
5. `problem` (tier 1) — `can'?t\b|\bcannot\b|\bstruggl|\bproblem\b|\bissue\b|\bhelp me\b|\bi (need|want) to\b`
6. No match → `null`. The honest answer for an unmatched prompt is "you tell me", not a default (same stance as source classification's `other`).

Tier mapping mirrors the vertical packs' hand-authored tiers (recommendation/problem 1, comparison 2, branded/how-to 3).

### Clusterer — `lib/prompts/cluster.ts`, `PROMPT_CLUSTER_VERSION = "prompt-cluster-v1+deterministic"`

`clusterPrompts(prompts) → { key, label, category, promptIds }[]`. Pure and order-stable: tokenize lowercase, strip a fixed English stopword list and template placeholders, then greedy grouping **within a category** — a prompt joins the first cluster whose accumulated token set overlaps ≥ `CLUSTER_OVERLAP_THRESHOLD = 0.34` (Jaccard), else starts a new cluster. `key` = `category:top-terms`, label = the two most frequent salient terms. Deterministic given input order (prompts ordered by position — stated limitation, not hidden).

### Import — `lib/prompts/import.ts`

- `parsePromptImport(raw)` — pure. Accepts CSV (via the existing `parseCsv`) with optional header (`text[,category][,language][,tier]`, detected case-insensitively) or plain lines (one prompt each). Per-row outcomes: valid / rejected (reason: empty, >2000 chars, unknown category, bad tier, no category and no rule matched). Rows without explicit category get the classifier's suggestion (brand names supplied by the caller). Cap: `IMPORT_MAX_ROWS = 200` — refuse larger pastes outright.
- `importPrompts(user, { setId, content })` — staff-gated, one transaction: parse → dedupe case/whitespace-insensitively against the set's active prompts and within the batch → insert survivors via the same insert shape as `addPrompt` with `source = 'import'` → one audit row with counts. Returns `{ added, skippedDuplicates, rejected: [{line, text, reason}] }`. A batch with zero valid rows is a validation failure, not an empty success.

### Vertical packs

Pack-seeded prompts record `source = 'vertical_pack'` (one-line change at the `addPrompt` call; `addPromptSchema` gains optional `source`, default `'manual'`).

### MCP (17 → 19 tools)

- `get_prompt_clusters` (observer): `{ prompt_set_id }` → clusters of the set's active prompts + `cluster_version`.
- `import_prompts` (operator: dry-run, idempotency key, ledger): `{ prompt_set_id, content, dry_run? }`. Dry run returns the full parse/dedupe report and writes nothing.

## Edge cases

- Duplicate inside the batch: first occurrence wins, later ones counted `skippedDuplicates`.
- CSV row with a category column value of empty string → treated as "no category" → classifier path.
- Quoted CSV fields containing commas/newlines: handled by `parseCsv` (already covers quotes).
- A set at freeze time is unaffected — import touches live prompts only; versions stay immutable.
- Archived set → `conflict`, same as `addPrompt`.
- Non-English `language` column accepted verbatim (2–8 chars), defaults `en`.
- Clusters of one are real clusters (a lone topic is coverage information).

## Acceptance criteria

- [x] Importing a mixed CSV yields exact added/skipped/rejected counts; re-importing the same content adds nothing (all duplicates).
- [x] Rows without category are classified by rule; unmatched rows are rejected with "category required", never defaulted.
- [x] Imported prompts carry `source='import'`; pack-seeded prompts carry `source='vertical_pack'`; hand-added stay `manual`.
- [x] Classifier fixtures: ≥15 hand-labeled prompts across all five categories + null cases, all passing; version string exported.
- [x] Clusterer fixtures: hand-built sets produce expected groupings; stable across repeated calls; version string exported.
- [x] `get_prompt_clusters` and `import_prompts` (with dry-run + ledger + replay) work over MCP; registry at 19.
- [x] Migration 043 up/down/up clean; suite, lint, typecheck green.

## Test cases

- Unit `prompt-classify.test.ts`: rule table incl. brand names, precedence (comparison beats recommendation for "best alternative to X"), null cases, version constant.
- Unit `prompt-cluster.test.ts`: category separation, overlap grouping, placeholder stripping, stability, singleton clusters.
- Unit `prompt-import-parse.test.ts`: header-detected CSV vs plain lines, plain lines, quoting, caps, per-row rejects, in-batch dedupe.
- Integration `prompt-import.test.ts`: end-to-end import into a set, duplicate suppression vs existing rows, provenance column, audit row, archived-set refusal, zero-valid-rows failure.
- Integration `mcp.test.ts`: registry 19; `import_prompts` dry-run parity, real import, replay; `get_prompt_clusters` shape.

## Definition of done

All acceptance criteria pass · suite/lint/typecheck green · migration up/down/up clean · `docs/ai-visibility-mcp-tools.md` + roadmap updated · DECISIONS records the no-guess classifier stance and computed-on-read clustering.
