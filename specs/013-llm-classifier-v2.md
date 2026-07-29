# Spec 013 — LLM Classifier v2 (entity-resolving mention classification)

> Status: done (2026-07-29)
>
> Live validation on the real Parva captures (24 observations re-parsed):
> **all three "What is Parva?" false positives retracted** — the
> Mahabharata answer, the "several different companies" answer, and the
> healthcare-Parva answer — including the false *recommendation*. Three
> retraction revisions written; v1 rows preserved. The three surviving
> mentions are the genuine comparison-prompt ones (conf 0.97–0.98).
>
> Two prompt-precision bugs found by that live run and fixed before merge
> (both would have under-counted competitors):
> 1. A registered alias ("Stan Store") was judged a different entity →
>    prompt now states aliases are authoritative.
> 2. A passing list-only mention (Beacons) was rejected as "not
>    substantively discussed" → prompt now states `isSameEntity` is about
>    identity ONLY, never prominence; brief mentions still count.
> After the fix: Linktree 16 mentions/14 recommendations, Beacons 11/9,
> Carrd 8/8, Stan 5/4, Parva 3/2 across both baselines.
>
> Checked, not assumed: Linktree's high recommendation rate is real, not
> over-marking — excerpts read "Best overall for real estate: **Linktree**",
> "My top pick: **Linktree**", "the safer default", which is exactly
> docs/06's "endorses choosing, not merely names it."
> Depends on: specs/004 (parser + review queue) · specs/008 (claims) ·
> specs/010 (agent runner) · docs/06 · docs/12 · docs/15
> Branch: feat/013-llm-classifier-v2
> Priority: **P0** (docs/audits/five-products-roadmap.md — every metric,
> gap finding, verdict, and report inherits classification quality)

## Problem (evidence, not theory)
The heuristic parser (`mention-parser-v1+heuristic`) matches aliases by
string. Live captures proved two failure modes for the real client:

1. **Name collision → false positive.** "What is Parva and what does it
   do?" returned an answer about *the Mahabharata's parvas*; the parser
   counted it as a client mention (and, in the searched run, as a
   recommendation). GPT's searched answers also retrieve
   `parvahealth.com`, `parvaconsulting.com`, `getparva.com`.
2. **Prose inference is shaky** — recommendation language elsewhere in an
   answer can be misattributed to a company merely mentioned.

An evidence portal that faithfully displays wrong classifications is worse
than no portal: the drill-down makes the error auditable but still wrong.

## Goal
A second parser version that decides **"is this the client, and was it
actually recommended?"** using the response text, the originating prompt,
and the client's *approved* identity claims (spec 008) — with an
independent fresh-context verifier and unchanged human-review discipline.

## Design (docs/15 classification graph)

```
raw response
 → deterministic alias prepass (recall: which companies MIGHT appear)
 → LLM semantic classification (precision: same entity? mentioned?
   recommended? position? sentiment?)                [mention-classifier-v2]
 → confidence check (docs/06 threshold 0.7)
 → fresh-context verifier for low-confidence rows    [mention-verifier-v2]
 → human review queue when the verifier disagrees
 → scoring (unchanged)
```

Rules:
- **Recall stays deterministic.** Only companies with an alias hit are
  offered to the LLM; no alias hit = not mentioned, no LLM call, no cost.
  (A response naming the client with an unregistered alias is a
  registry problem, surfaced by brand discovery — spec 005.)
- **Precision is the LLM's job**, and its single most important output is
  `isSameEntity`: the answer's "Parva" must be *this* Parva
  (link-in-bio for real estate agents, parva.io), not a Sanskrit term, a
  health company, or a consultancy.
- **Identity context comes only from approved claims** (spec 008) plus the
  registry's aliases/domain — never invented, never model recollection.
- **Deterministic outputs stay deterministic**: cited URLs remain
  domain-matched in code, not asked of the model.
- **The classifier never verifies itself** — the verifier is a separate
  agent version with fresh context and only the disputed candidate.
- **Verification can only add oversight, never remove it**: verifier
  disagreement forces `needs_review`; verifier agreement leaves the
  docs/06 confidence rule untouched.
- **Graceful degradation** (docs/12): with no provider key the pipeline
  falls back to heuristic v1 and records *that* version on the row.

## Versioning
- `mention-parser-v1+heuristic` (unchanged string — historical rows keep
  their provenance)
- `mention-parser-v2+llm` (new)
- The active version is resolved at parse time (`lib/parsing/version.ts`);
  `response_parses` and `mentions` record the version that actually ran, so
  a mixed-version history is legible.
- Re-parsing an old run appends **new revisions** (existing machinery,
  `reparseRun`, admin-only) — no mention is ever edited or deleted, and the
  evidence portal's classification history shows v1 → v2 side by side.
- Scoring is unaffected (it reads current-revision mentions); scores
  recompute from the re-parse, producing new score rows at the current
  scoring version.

## Model
`gpt-5.4-mini-2026-03-17` (classification is a narrow judgment; the mini
snapshot is ~6× cheaper than the flagship and this runs on every
observation). Registered in docs/13 with both prompts.

## Acceptance criteria
- [ ] The Mahabharata capture classifies as **not the client**
      (`isSameEntity: false`) and produces a retraction revision on
      re-parse; the searched-run "recommended" false positive disappears.
- [ ] Genuine mentions of the client survive re-parse (no over-correction
      to zero) — verified against the real Parva comparison prompts.
- [ ] Low-confidence rows trigger a fresh-context verifier call with a
      different agent version; disagreement sets `needs_review`.
- [ ] No provider key → heuristic v1 runs and rows record the heuristic
      version (tested).
- [ ] Re-parse appends revisions; v1 rows remain readable in the
      observation-detail history.
- [ ] Tests use an injectable caller (no network in CI) and include a
      collision fixture; lint/typecheck/tests green.
- [ ] docs/13 registers both prompts; DECISIONS records the model choice
      and the verifier policy.

## Out of scope
Market/specialty association classification (needs spec 012 vertical
vocabularies), sentiment beyond the existing four values, and re-parsing
every historical run automatically (operator-triggered per run).
