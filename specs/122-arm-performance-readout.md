# Spec 122 — Arm A vs Arm B performance readout

> Status: done
> Depends on: specs/101 (canonical analytics), specs/098 (cockpit), docs/06
> Branch: feat/122-arm-performance (stacked on feat/121-dashboards-mobile-brief)

## Goal

The cockpit's Analyze view compares the two live message styles — Arm A
(link CTA) versus Arm B (no link, reply CTA) — on the same send-level
metrics every other grouping uses. The arm is **derived from the sent
draft's body at read time** (does it contain a link?), never stored as a
label: the 55 historical sends classify themselves, conversions and manual
sends can never carry a stale tag, and the discipline matches every other
derive-on-read cockpit number.

## User stories

- As an operator, after switching all sends to Arm B (2026-08-26 decision) I
  can see B's delivered/open/reply rates next to the all-A baseline without
  leaving the dashboard.

## UI

New Section "Arm A vs Arm B" in the Analyze tab, after "Message strategy",
rendered with the existing `SendGroupTable` (Sent / Delivered / Open signal*
/ Audit view / Replies / Positive / Meetings / Sample). Help text states the
classification rule and the reading caveat: Arm B bodies have no link, so
audit views under B can only follow a link sent on request — compare arms on
replies and (directionally) opens. Empty state: "No sends yet."

## Database changes

None. Classification is a regex over `outreach_drafts.body` joined from the
send ledger.

## API (server actions / routes)

None. Pure additions:

- `lib/prospects/constants.ts`: `OUTREACH_LINK_PATTERN` — the SQL regex
  (case-insensitive) that counts as "contains a link"; matches `https?://`
  and naked branded URLs.
- `lib/prospects/intent.ts`: `SendFact.hasLink: boolean | null` (null when
  the send has no draft body on file — e.g. a manually recorded send).
- `lib/prospects/dashboard.ts` `prospectFacts`: emits `hasLink` per send.
- `lib/prospects/analytics.ts`: `byArm(items)` — send-level grouping via the
  existing `groupSends`, labels "Arm A · link CTA" / "Arm B · reply CTA" /
  "Unclassified (no draft body on file)".

## Validation rules

- A send with no joined draft body is "Unclassified", never guessed.
- Sample labels come from the shared `sampleLabel` policy; no new floors.

## Edge cases

- Mixed-arm prospect (A touch 1, B touch 2): each send counts under its own
  arm — send-level attribution, same as byTouch/bySubject.
- Zero sends → empty state; single-arm data → one row, no comparison implied.

## Acceptance criteria

- [x] `byArm` classifies link-bearing bodies as A, link-free as B,
      missing-body as Unclassified (unit-tested).
- [x] Analyze tab renders the arm table with the shared columns and caveats.
- [x] Lint, typecheck, and the unit suite pass.

## Test cases

`tests/unit/prospect-analytics.test.ts`: byArm block — A/B/null
classification, mixed-arm prospect splits by send, reply attribution follows
the send window.

## Definition of done

All acceptance criteria pass · tests green · lint/typecheck clean · no
schema change · DECISIONS note on derive-at-read arm classification.
