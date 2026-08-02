# Spec 030 — Competitor Movement & Portfolio Operations

> Status: done (2026-07-31) — see "Not built"
> Depends on: docs/06 (change-detection rules), specs/005 (competitors), specs/015-notifications pattern (migration 015)
> Branch: `feat/030-competitor-movement`

## Goal

Two Phase-2 capabilities (roadmap 2.1 + 2.7):

1. **Movement detection.** "A competitor overtook you" and "your visibility
   fell materially" become derived, self-resolving alerts — computed from
   the same score history the platform already keeps, under the same noise
   rules reports use (docs/06). No new stored state: like the rest of the
   inbox, movement is recomputed from reality and disappears when reality
   improves.
2. **Portfolio fields.** `account_owner_id` and `service_tier` on projects,
   editable in settings, filterable on the portfolio.

## Movement semantics (deliberately conservative)

Comparisons only between the **latest two scored runs on the same frozen
prompt-set version and the same scoring version** — cross-instrument or
cross-version movement is not movement, it is a changed ruler.

- **Overtake**: on `mention_rate` (provider `all`), the ordering between
  subject and a tracked competitor flips (prev: subject ≥ competitor;
  now: competitor > subject) AND the competitor's gain or the subject's
  loss is `notable` under `changeVerdict` (|Δ| ≥ 0.10, N ≥ 30/side,
  direction consistent across ≥ 2 providers). Small-sample flips stay
  silent — a coin flip is not an overtake.
- **Visibility drop**: the subject's `mention_rate` or
  `recommendation_rate` delta is `notable` and negative.

Each event carries the numbers that justify it (before/after for both
parties). Surfaced as attention-feed kinds `competitor_overtake` and
`visibility_drop` (severity: attention) → auto-notified and deduped by the
existing derived-notification machinery, self-resolving when a newer run
no longer shows the condition.

## Portfolio fields

Migration 035: `projects.account_owner_id uuid references users(id)`,
`projects.service_tier text check (service_tier in
('standard','premium','exclusive'))` — both nullable (a solo agency has no
owner ambiguity; tiers are optional vocabulary). Settings page edits both;
portfolio (`/projects`) shows columns and filters by owner/tier via query
params. Control-tower deep filtering is a recorded follow-up.

## Later batches under this spec (2026-07-31, same day)

- **Batch 2** — roadmap 2.2 (deterministic source classification +
  "Sources influencing answers" view) and 2.6 (benchmark + visibility
  event producers). Merged as PR #6.
- **Batch 3** — roadmap 2.3 (knowledge-graph ↔ measurement bridge:
  approved works_for/brokerage/affiliated_with relationships roll agents
  up under brokerages with a distinct-response group rate) and 2.5
  (platform schedule templates clone per client, enabled, admin-gated;
  template stays disabled as the canonical default).

## Not built (recorded)

- Roadmap 2.4 (verdict-outcome feedback into gap weights): needs ≥10
  accumulated intervention verdicts; the data does not exist yet. Revisit
  when it does.
- Control-tower filter panel (portfolio filters land first).
- ~~Overtake on metrics beyond mention_rate~~ — closed by a later batch:
  `MOVEMENT_METRICS` runs both mention_rate and recommendation_rate through
  the full overtake + drop paths (reconciled 2026-08-02, spec 036).
- LLM long-tail source classification (waits for a validation set,
  docs/12); relationship-creation UI (relationships arrive via extraction
  + approval today).

## Acceptance criteria

- [ ] Overtake fixture: competitor flips above subject with notable margin
      → one attention item + one deduped notification; re-sync does not
      duplicate; a newer run without the condition resolves it.
- [ ] Small-sample flip (N < 30) produces nothing.
- [ ] Different prompt-set version or scoring version between runs →
      no comparison at all.
- [ ] Subject notable negative delta → visibility_drop item.
- [ ] Owner/tier round-trip in settings; portfolio filters by both;
      client_viewer cannot edit (read-only denial).
- [ ] Migration applies and rolls back.

## Test cases

Unit (`tests/unit/competitor-movement.test.ts`): overtake/no-overtake
fixtures incl. noise, sample-size, version-mismatch guards. Integration:
attention feed + notification dedupe/self-resolve via the existing
notifications test idioms; settings round-trip + denial.
