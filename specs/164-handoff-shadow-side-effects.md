# Spec 164 — Report handoffs in SHADOW prepare nothing and send nothing (G4)

> Status: implemented (2026-10-26), not committed
> Depends on: specs/129, specs/137, specs/159
> Branch: feat/162-workflow-send-gates (stacked on 162/163)
> Audience: operator (internal). Affects prospect email and published audit pages.

## Goal

Close gap G4 from spec 159:
1. With outbound sending off (spec 159), a positive-reply handoff still
   publishes the prospect's audit page and runs the release review (a paid
   frontier call), though nothing can be sent.
2. The lane kill switch or a mode change does not stop a delivery draft the
   lane already scheduled; the drain sends it.

## Decisions

- **D1 — Preparation holds while outbound sending is off.** A pure
  `preparationHold(outboundOn)` in `lib/prospects/fulfillment-lane.ts`. With
  `OUTBOUND_SENDS_ENABLED` not `true`, a handoff in `evidence_verified` or
  `report_published` stays there: reason `PREPARATION_HELD: …`,
  `auto_verdict = 'held'`, no publish, no release-review model call, no attempt
  counted. It resumes on the first tick after outbound is on. With outbound
  on, SHADOW still prepares and stages for founder review (spec 139: that is
  the founder's positive-reply workflow, not a leak); D2 keeps it from
  transmitting unattended.
- **D2 — Unattended delivery re-checks the lane at send time.**
  `sendProspectDraft` adds check `fulfillment_lane_release` for drafts with a
  `send_intent_key` on unattended sends: the draft's handoff must still get
  `transmit` from `releaseDecision(resolveLaneConfig(), handoffId)`. A refusal
  parks the draft (existing drain behaviour); the handoff then moves to
  `needs_review`. A founder's attended send is unaffected. Gate version →
  `prospect-send-gate-v5`.

## Out of scope

- Handoffs already past `report_published` keep their artifacts.
- Video lane (`VIDEO_WALKTHROUGH_*`) — unchanged.

## Acceptance criteria

- [x] Outbound off: a verified handoff publishes no audit, makes no model call,
      counts no attempts; it prepares on the first tick after outbound is on.
- [x] `fulfillment_lane_release` refuses an unattended send of a handoff
      draft under the kill switch (and SHADOW); existing
      NARROW_AUTONOMOUS and CANARY send tests still pass.
- [x] typecheck, lint, full test suite pass; `DECISIONS.md` entry;
      `docs/deployment.md` G4 marked closed.
