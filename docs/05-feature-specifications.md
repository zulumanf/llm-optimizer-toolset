# 05 — Feature Specifications (Overview)

One section per feature: purpose, user flow, edge cases, acceptance criteria. These are the stable product-level descriptions; the **executable, build-this-now versions live in `specs/`** with schema changes, endpoints, and test cases. When this file and a spec disagree, the spec (newer, more detailed) wins — then update this file.

| Feature | Executable spec |
|---|---|
| Project Management | `specs/001-project-management.md` |
| Prompt Library | `specs/002-prompt-library.md` |
| Experiment Runs | `specs/003-experiment-runs.md` |
| Response Classification & Review | `specs/004-response-classification.md` |
| Competitor Analysis | `specs/005-competitor-analysis.md` |
| Reporting Dashboard | `specs/006-reporting-dashboard.md` |
| Attribution | `specs/007-attribution.md` |

---

## Prompt Manager (Prompt Library)

**Purpose:** author the questions we ask AI assistants, organized into sets that can be frozen into immutable versions for reproducible runs.

**User flow:** create set → add prompts (text, category) → reorder → **Freeze** → set version becomes selectable when starting a run. Editing after freeze changes the working copy only; next freeze = next version.

**Edge cases:** freezing an empty set (blocked); freezing with no changes since last version (blocked, "no changes"); editing a prompt used in past runs (fine — past runs reference the frozen snapshot); deleting a set with versions (archive only).

**Acceptance criteria:** a frozen version's contents are bit-identical forever; every run displays exactly which version it used; diffs between versions viewable.

## Experiment Runs

**Purpose:** execute a frozen prompt set across providers/models with N repetitions, capturing raw responses immutably.

**User flow:** New Run → pick prompt-set version, providers/models, repetitions → cost estimate shown → confirm → progress view (completed/failed cells) → run completes → parsing kicks off automatically.

**Edge cases:** provider outage mid-run (cells fail with recorded errors, run ends `partial`, retry-failed-cells action); duplicate cell protection (idempotent jobs); budget cap exceeded (run pauses, operator decides); cron and manual runs colliding (queue serializes per project).

**Acceptance criteria:** every attempted call has a `responses` row (success or error); no response ever updated after insert; rerun never touches an old run's data.

## Response Classification & Review

**Purpose:** turn raw text into structured mentions (who was mentioned, recommended, at what position, with what sentiment and citations) with confidence, routing uncertain parses to humans.

**User flow:** automatic after each run → Review queue lists `needs_review` mentions with excerpt + highlighted raw response → operator confirms or corrects → correction saved as new revision, original kept.

**Edge cases:** brand alias collisions ("Lumina" vs. an unrelated "Lumina Labs"); answers with no brands at all (valid, counts in denominators); non-English answers; parser version upgrade (re-parse creates new revisions, never overwrites).

**Acceptance criteria:** every mention row carries `parser_version` + `confidence`; below-threshold parses never enter scoring until reviewed; correction history fully visible.

## Competitor Analysis

**Purpose:** the same metrics we compute for the client, computed for tracked competitors, compared.

**User flow:** manage competitor list per project (company + aliases + tier) → dashboard comparison view: share of voice, recommendation rate side by side, per provider, over time.

**Edge cases:** competitor added mid-history (metrics computed from existing raw data retroactively — raw data makes this free); competitor rebrands (alias update, re-parse forward); untracked brands appearing often (surfaced as "unrecognized brands" suggestions).

**Acceptance criteria:** identical methodology for the client and competitors — no metric exists for one and not the other.

## Reports

**Purpose:** immutable point-in-time snapshots for decision-making: scores, deltas vs. previous period, notable excerpts, suggested tasks.

**User flow:** generate draft for a period → operator edits narrative sections (never numbers) → publish → locked forever → shareable/exportable.

**Edge cases:** publishing with unreviewed low-confidence mentions in the period (blocked or explicitly flagged in the report); regenerating a draft after new data (allowed for drafts only).

**Acceptance criteria:** published reports render identically forever; every number links to its underlying scores/responses.

## Evidence & Tasks

**Purpose:** close the loop — findings become concrete work with proof attached.

**User flow:** from any score/mention/report, "Create task" → task drafted with evidence links → human approves → tracked to done → follow-up run measures effect (see `specs/007-attribution.md`).

**Edge cases:** task suggested with zero evidence (blocked); evidence's parent report superseded (task keeps original evidence — it pointed at immutable data).

**Acceptance criteria:** no suggested task without evidence; no task auto-executes anything (`PRINCIPLES.md` #8).
