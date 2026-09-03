# Spec 128 — The mismatch "private report" (audit page variant)

> Status: done
> Depends on: specs/032 (audit page), 045 (proof), 124 (mismatch evidence), 127 (frozen Touch 1 lookup)
> Branch: feat/128-mismatch-private-report

## Goal
A prospect who replied to a competitive-mismatch email gets exactly what the email promised: the side-by-side and the exact questions and answers, on one screen, with almost no text. Published through the existing `publishAudit` tool (token link, views, beacon, revoke, expiry) — no new surface.

## Behavior
- `publishAudit` adds `snapshot.mismatch` (`AuditMismatchBlock`) when the prospect has a delivered mismatch Touch 1 (`deliveredTouch1`, spec 127): the frozen prospect/competitor production and recommendation counts, the assistant label, answer/question/repetition counts, capture date, and per-question rows (only questions where either name appeared) with up to two verbatim excerpts around the competitor's mention (response ids kept as receipts).
- `app/audit/[handle]` renders `MismatchReport` instead of the full report when `snapshot.mismatch` exists: eyebrow, one headline ("You closed more. {competitor} got recommended more."), two tiles (production + count; the prospect's count in `text-destructive`), one candor line, the question list with `<details>` excerpts, a link to the complete answers page, the existing CTA block and prepared-by signature. Same beacon and tracking.
- Older snapshots without the block render exactly as before.

## Rules honored
audit-page-design (semantic color only, serif headline, tabular figures, receipts, CTA mailto), prospect-voice (no invented numbers, "the pattern is the finding", complete-answers appendix backs the absence claim). No new dependencies, no client JS.

## Acceptance criteria
- [ ] Publishing for a mismatch prospect yields `snapshot.mismatch` whose counts equal the frozen Touch 1 snapshot.
- [ ] `excerptAround` returns the sentence containing the competitor with markdown stripped; null when absent.
- [ ] Page with `mismatch` shows the two tiles and the question list; page without it is unchanged.

## Tests
`tests/unit/audit-mismatch.test.ts` (excerpt extraction); publish + render verified against the live prospect.
