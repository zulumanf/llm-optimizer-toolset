# 01 — Product PRD

**What are we building?** An internal web app + worker that runs frozen prompt sets against AI providers on a schedule, captures raw responses immutably, classifies mentions of Parva and competitors, computes versioned scores, and produces reports and tasks.

## Problem

We don't know how AI assistants talk about Parva. Anecdotal checks ("I asked ChatGPT and we weren't mentioned") are unrepeatable, unversioned, and can't measure change. Without instrumentation we can't tell whether any content/PR/docs investment moved AI answers at all.

## Target user

The Parva team (2–5 internal operators): whoever runs growth/marketing experiments and whoever builds content. Technical enough for an internal tool; not willing to babysit scripts and spreadsheets.

## Goals

1. Measure Parva's AI visibility reproducibly across providers, weekly.
2. Compare against a tracked competitor set.
3. Detect change over time with confidence (was it noise or a real shift?).
4. Convert findings into concrete, evidence-linked tasks.
5. Keep every number traceable to raw responses and versioned methodology.

## Use cases

- **Weekly baseline:** the frozen core prompt set runs Monday 06:00 across all providers; by 09:00 a report shows deltas vs. last week.
- **Experiment:** before publishing a comparison page, freeze a targeted prompt set, capture a baseline, publish, re-run at +2 and +6 weeks, compare.
- **Competitor watch:** see which competitors are gaining recommendation share and in which prompt categories.
- **Evidence review:** a low-confidence classification lands in a review queue; a human confirms or corrects it in two clicks.
- **Report out:** export a report for the founders: scores, deltas, notable raw excerpts, recommended actions.

## Requirements

**Functional**
- Projects group prompt sets, competitors, and reports (e.g., "Parva Core", "Feature X Launch").
- Prompt library: create/edit prompts, organize into sets, freeze sets into immutable versions.
- Run engine: execute a frozen set × providers × models × N repetitions; retries, rate limiting, cost tracking.
- Raw capture: full provider payload stored before any processing.
- Classification: detect brand mentions, sentiment, recommendation position, citations; confidence per field.
- Human review queue for low-confidence classifications.
- Scoring per `docs/06-scoring-methodology.md`, versioned.
- Dashboard: trends, provider breakdown, competitor comparison.
- Reports: point-in-time snapshots, exportable, immutable once published.
- Tasks: findings → suggested tasks (human-approved) with links to evidence.

**Non-functional**
- Reproducible: any score re-derivable from raw data + versions.
- Durable: no data loss; raw responses immutable (see `PRINCIPLES.md`).
- Cheap to run: batched provider calls, budget caps per run.
- Auditable: who ran, reviewed, approved what and when.

## Out of scope (v1)

- Multi-tenancy, billing, public access
- Automated content generation or publishing
- Browser automation of consumer AI UIs (API-accessible models only; see `docs/14-future-ideas.md`)
- Real-time monitoring (weekly/on-demand cadence is enough)
- Statistical significance engine beyond repetition + basic variance (start simple, version upward)

## MVP (maps to `specs/001`–`004`)

1. One project, prompt library with freezing (`specs/001`, `specs/002`)
2. Run engine for OpenAI + Anthropic, raw capture (`specs/003`)
3. Mention classification + review queue + Mention/Recommendation Rate (`specs/004`)
4. A minimal trend dashboard

Everything else (competitor analysis, full reports, attribution) follows as `specs/005+`.

## Success metrics

- Weekly baseline runs unattended for 4 consecutive weeks with zero manual fixes
- 100% of scores traceable (spot-audit: pick any number, reach the raw response in <1 min)
- Classification precision ≥90% on human-reviewed sample
- The team makes at least one real content/PR decision per month from the data
