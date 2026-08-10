# Spec 054 — Shared Market Captures

**Status:** In progress
**Branch:** `feat/054-shared-captures` (stacked on `feat/053-fleet-drift`)
**Source:** Architecture gap audit 2026-08-09 (cost B4, P0 — "the dominant cost multiplier at scale"): twenty same-city clients pay twenty times for identical market prompt captures, each classified separately. The no-cross-talk rule (spec 008 / migration 041) is a promise about client *subjects*, never about market *captures* — one capture classified against N clients' company sets is legally available and simply not built.

## Why

Market packs deliberately give same-city clients the same prompt text ("Who are the best real estate agents in Jersey City?"). The provider's answer to that question is a fact about the market, not about any client — yet each project re-asks it, paying provider cost N× and, worse for measurement, sampling N different answers for what reports as the same market observation. Reuse is both the biggest cost lever and a comparability improvement: same-market clients measured in the same window see the same market reality.

## Design

**Capture reuse, not shared runs.** Runs stay project-owned (budgets, evidence, immutability, scheduling all key on project). When the executor is about to spend on a cell, it first looks for a *reusable capture*: a recent original capture of the byte-identical prompt on the same provider+model from a **different** project. If found, the cell is satisfied by copying the capture into this run — full raw payload, response text, tokens, `request_params`, shape verdict — with `reused_from` pointing at the original and `cost_usd = 0` (the platform paid once; the ledger stays truthful).

Eligibility (all deterministic):
- byte-identical `prompt_text`, same `provider` + `model`; source has no error, is not itself a copy (`reused_from is null` — provenance always points at an original), and its shape was recognized;
- source is from a **different project** — same-project runs (weekly cycles, intervention retests) must always sample fresh, or a retest would "measure" its own baseline;
- source is younger than `CAPTURE_REUSE_WINDOW_HOURS` (72) — inside one measurement cycle, never across weeks;
- repetition-aligned: target repetition k reuses the source capture with repetition k (distinct sources per repetition, stable and idempotent on resume);
- the mock provider never participates (test/demo behavior unchanged);
- per-run opt-out: `runs.reuse_captures` (default true) lets an operator force fresh sampling.

Downstream is untouched by construction: parsing classifies the copied text against **this** project's company set (the audit's "one capture, N company sets"), scoring reads this run's rows, the evidence drill-down recomputes from them, and capture-time hashing gives the copy its own integrity hash over identical content. `reused_from` is the provenance for anyone asking "did we pay for this answer or share it?".

## Scope (migration 064)
- `responses.reused_from uuid references responses(id)` + expression index `(md5(prompt_text), provider, model, requested_at desc) where error is null and reused_from is null` for the eligibility lookup.
- `runs.reuse_captures boolean not null default true`.
- `lib/runs/reuse.ts`: `findReusableCapture(cell, projectId)` — the eligibility query, one place.
- Executor: reuse hook ahead of the provider call; copies commit through the same capture path (insert-only, hash trigger); `run.capture_reused` logged per cell and a reuse count in the completion log.
- `CAPTURE_REUSE_WINDOW_HOURS` in `lib/constants.ts`.

## Out of scope
- Reusing *classification* (mentions) across projects — parsing stays per-project against each client's company set; that is the design, not a gap.
- Market-run ownership (runs belonging to a market instead of a project) — invasive rework of budgets/evidence/scheduling for no additional saving over capture reuse.
- Cross-window reuse policy (>72h) and a UI reuse indicator — follow-ups.

## Acceptance criteria
- [ ] Second project with the byte-identical prompt within the window captures via reuse: zero provider calls, `reused_from` set, `cost_usd = 0`, payload/text/tokens/params copied (test with a stubbed non-mock provider).
- [ ] Reused captures parse and score normally against the reusing project's own company set (test).
- [ ] Same-project repeat runs never reuse (test) — retests and weekly cycles always sample fresh.
- [ ] A third project reusing points `reused_from` at the ORIGINAL capture, never at a copy (test).
- [ ] Sources older than the window are ignored — live call happens (test).
- [ ] `reuse_captures = false` forces live calls even when a source exists (test).
- [ ] Mock-provider cells never reuse (existing suites unchanged, green).
- [ ] Migration 064 reversible; `npm test`, lint, typecheck green.
