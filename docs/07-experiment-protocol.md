# 07 — Experiment Protocol

How every experiment runs, without exception. The protocol exists so that any two runs are comparable and any number is re-derivable. Deviating from it invalidates the data — if a step can't be followed, the run is aborted and recorded as aborted.

## The pipeline

```
1 Create Prompt Set → 2 Freeze → 3 Run → 4 Capture Raw → 5 Parse → 6 Human Review → 7 Score → 8 Report
```

### 1. Create Prompt Set
Author prompts as a real user would phrase them (no brand priming unless the prompt category is explicitly "branded"). Each prompt has a category (`recommendation`, `comparison`, `how-to`, `branded`, `problem`). Minimum viable set: 10 prompts. Document the set's intent in its description.

### 2. Freeze Prompt Set
Freezing snapshots the set into an immutable `prompt_set_versions` row. **Runs only ever execute frozen versions.** Rules:

- Never change historical prompts. Edits apply to the working copy; next freeze = next version.
- A version, once created, is never modified or deleted.
- Week-over-week comparison requires the *same version*. New version = new baseline, annotated on all charts.

### 3. Run
Configuration is explicit and recorded on the run: providers, exact model IDs, repetitions per cell (default **5** — single samples are anecdotes), temperature/params (provider defaults, recorded per response in `request_params` — spec 050), budget cap. Runs execute via the worker queue; the same code path serves cron and manual runs.

- **Never rerun into old datasets.** A rerun is a new `runs` row. Retrying failed cells within a run is allowed and appends responses to the *same* run — it never replaces existing rows.

### 4. Capture Raw Response
The full provider payload is written to `responses` **before any parsing, scoring, or display logic touches it**. Errored calls are captured too, with the error. This table is insert-only, enforced at the database level. If capture fails, the cell failed — we never reconstruct a response from memory or logs.

### 5. Parse
The classifier (versioned, `docs/12-ai-guidelines.md`) extracts mentions, recommendations, positions, sentiment, and citations, each with confidence. Parsing writes new rows; re-parsing (e.g., after a parser upgrade) writes new revisions. Original parses are never overwritten.

### 6. Human Review
Mentions with `confidence < 0.7` enter the review queue. A human confirms or corrects against the highlighted raw response; corrections are stored as new revisions with `reviewed_by`. Scoring for a run is blocked until its queue is cleared (or the 72h timeout excludes-and-flags per `docs/06`). Reviewers judge only what the response says — never what we wish it said.

### 7. Score
Scores are computed per `docs/06-scoring-methodology.md`, stamped with `scoring_version`, and written as new rows. Never modify historical measurements. A methodology change applies forward; optional historical re-scoring adds rows under the new version alongside the old.

### 8. Report
Reports snapshot scores, deltas, coverage, and notable raw excerpts for a period. Drafts are editable (narrative only — numbers come from data); published reports are immutable. Every claim carries evidence links; `evidence_score` must be 1.0 to publish. A human publishes; nothing auto-publishes.

## Intervention experiments (before/after)

To measure whether an action (new comparison page, docs overhaul, PR coverage) moved AI answers:

1. Freeze a targeted prompt set for the topic.
2. Capture **baseline**: ≥ 2 runs, ≥ 1 week apart, before the intervention.
3. Ship the intervention; record its date on the project (see `specs/007-attribution.md`).
4. Re-run the *same frozen version* at +2, +6, +12 weeks.
5. Compare using the change-detection rule in `docs/06`. Report "no detectable effect" as readily as success (`PRINCIPLES.md` #7).

One intervention per prompt set per window — overlapping interventions make attribution meaningless; if overlap is unavoidable, the report must say the effect is confounded.

## Cadence

- **Weekly baseline:** core prompt set, all providers, Mondays 06:00 via cron.
- **Ad-hoc runs:** allowed anytime; labeled clearly so they're not confused with the baseline series.
- **Provider/model updates:** when a provider retires a model, the change is recorded on the run config; trend charts annotate the boundary — a model change is itself an "intervention" from the outside world.

## Invariants (restated because they are the product)

- Historical prompts never change. Raw responses never change. Scores never change in place.
- Every number: raw data + prompt-set version + parser version + scoring version ⇒ reproducible.
- Failed ≠ missing ≠ zero: coverage is always reported alongside rates.
