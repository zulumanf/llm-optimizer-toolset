# Spec 128 — Private AI Recommendation Report (mismatch audit variant, v2)

> Status: done
> Depends on: specs/032 (audit page), 045 (proof), 124 (mismatch evidence), 127 (frozen Touch 1 lookup)
> Branch: feat/128-mismatch-private-report

## Goal
A prospect who replied to a competitive-mismatch email gets exactly what the email promised: the side-by-side and the exact questions and answers, on one screen, with almost no text. Published through the existing `publishAudit` tool (token link, views, beacon, revoke, expiry) — no new surface.

## v2 (2026-09-03) — the full research document
Template `private_ai_recommendation_report_v2`. Section order: header (name, market, prepared date, production source, AI test, questions, valid answers, captured) → 1 the finding (Figure 01 table) → 2 why I flagged this → 3 what we asked (representative questions + all-questions fold) → 4 the receipts (question / captured answer / what we recorded, evidence flow) → 5 this wasn't one answer (distinct-question stats + Figure 02 by question type; only when competitor ≥ 3 distinct questions) → 6 where they're showing up more (gaps, competitor ≥ 2) → 7 where the information is coming from (Figure 03 sources, association caveat; only when sources exist) → 8 why this may be happening (observed / may mean / would investigate, 1–3 evidence-backed areas; one subtle reply link) → 9 what I'd look at first (≤ 3) → 10 what I can't tell from public data (2–4 personalized questions) → 11 what would make me less concerned (each condition with its actual status) → 12 Francisco's note (narrow, serif, with the team's own numbers) → 13 what this means + how we ran the test (plain-language method fold) → 14 CTA "Walk me through it" (mailto, `Re: {team} report`, prefilled reply) → appendix links. Every generated sentence in `lib/prospects/audit-mismatch.ts` is deterministic over counted evidence; sections without evidence are omitted. Beacon targets: hero, evidence, all-questions, captured-answers, what-id-look-at, what-i-cant-tell, francisco-note, methodology, cta (walk-me-through, mid-report).

## Walkthrough scheduling (2026-09-03)
`/audit/<handle>/walkthrough` (and the branded `/audit/<slug>/<key>/walkthrough`): token-gated, noindex, no view row. `walkthroughSlots(now, tz)` offers the next 5 business days × 9:00 / 11:00 / 2:00 / 4:00 in the prospect's zone, ≥ 20 h ahead. One pick + optional contact/note → `requestWalkthrough` stores `prospect_walkthrough_requests` (migration 100), logs activity + audit, and emails the operator (sender identity reply-to) via the Gmail connector with both timezones; mail failure is recorded on the row, never shown to the prospect. The report's final CTA links here unless `AUDIT_BOOKING_URL` overrides it.

## v1 behavior (kept)
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
