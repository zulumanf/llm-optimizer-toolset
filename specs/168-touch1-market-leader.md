# Spec 168 — Touch 1 "market leader" comparison

> Status: implemented (2026-10-28), not committed
> Depends on: specs/124, 136, 150, 167; prospect-voice
> Audience: PROSPECT (cold email)

## Why

43 never-contacted prospects in the 2026-10-27 refreshed markets had no clean
mismatch (no lower-producing competitor recommended more), so they fell back to
the generic reply-first email ("X was mentioned in 17 of 256 answers") — no
comparison, no context. 27 of them have 0–2 recommendations while the market's
top recommended team has ~18.

## Rule (`evaluateLeader`, pure, `LEADER_THRESHOLDS`)

- Prospect recommendations ≤ 2 in the run (OpenAI, echoes excluded).
- Leader = most-recommended candidate from the same pool as spec 124 (same
  launch peers + RealTrends companies in the city) at the **same entity level**
  (team vs team, individual vs individual; production supplies the level only).
- Leader count − prospect count ≥ 10; benchmark ≤ 14 days; first name and
  company resolved. Tried only when no clean mismatch exists; otherwise the
  draft falls back to reply-first as before (never a weakened mismatch).

## Email (`leader_comparison_reply_v1`)

Same structure and spec 167 lines as mismatch v2, but the comparison is counts
only — no production claim, no "even though RealTrends has you ahead":

    {Leader}… recommended far more often than your team.
    Your team: recommended in 0 of 256 answers
    {Leader}: recommended in 18 of 256 answers

## Safety

- Frozen `LeaderEvidenceSnapshot` (`variant: "leader"`, no production fields).
- Evidence release runs every entity, alias, zero-count, run, recount and
  integrity check; only `productionChecks` are skipped for `variant: "leader"`.
- Draft QA `qaLeaderClaims`: rendered counts, live staleness, live eligibility
  (gap ≥ 10), recency — at approve and at send.
- Fulfillment manifests refuse leader evidence (no handoff path yet).

## Out of scope

- Follow-ups (T2/T3) for leader emails: current templates restate production.
  Leader drafts are not in `MISMATCH_TEMPLATE_VERSIONS`, so they never enroll.
- Analytics count leader as Touch 1 (`TOUCH1_EVIDENCE_TEMPLATE_VERSIONS`).

## Acceptance criteria

- [x] Eligibility, refusal codes, snapshot shape, rendering, prohibited phrases,
      QA drift and the release-verdict branch are unit-tested.
- [x] Full suite (3,340), lint, typecheck pass.
