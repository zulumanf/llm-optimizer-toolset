# Spec 162 — Workflow-engine email sends obey the prospect send gates (G7)

> Status: implemented (2026-10-26), not committed
> Depends on: specs/148, specs/150, specs/159
> Branch: feat/162-workflow-send-gates
> Audience: operator (internal). No client- or prospect-facing UI.

## Goal

Close gap G7 from spec 159: prospect email can only leave through
`sendProspectDraft` (send gate v4: provenance, draft QA, evidence release,
caps, suppression, DNC). The workflow engine must not be a second, weaker path.

## Problem

`int.email_send_approved_message` (`lib/automation/nodes/integration.ts`,
`emailSendApproved`) sends free-form `to/subject/body` after only
`assertSendAllowed` (`lib/outreach/suppression.ts`). That gate lacks the
148/150 checks, and at autonomy level ≥ 3 it skips approval entirely.
`inbound_lead_qualification_v1` (`lib/automation/workflows/revenue.ts`) uses it
with `actionType: "prospect_first_outreach"`.

## Decisions

- **D1 — Prospect recipients are refused by the node.** Before any other check,
  `emailSendApproved` refuses when either:
  - `actionType` is in `PROSPECT_OUTREACH_ACTION_TYPES` (new constant,
    initially `["prospect_first_outreach"]`), or
  - the recipient email (case-insensitive, trimmed) matches a non-archived
    `prospect_contacts.email` or `prospects.email`.

  Outcome `safe_stop`, `failedCheck: "prospect_send_path"`, recorded via
  `recordWouldHaveHappened`, reason naming `sendProspectDraft` as the only
  path. No delegation: the workflow's stored draft is not an `outreach_drafts`
  row, and inventing one would bypass 148/150 provenance.
- **D2 — No unapproved workflow email.** For `email.send_approved_message`,
  `assertSendAllowed` requires a recorded approval at every autonomy level
  (level ≥ 3 no longer skips `approval`/`message_version`). Other capabilities
  are unchanged.
- **D3 — One lookup, in `db/`.** The recipient match is a single function in
  `db/` (e.g. `isProspectRecipient(email)`), reused by D1. No new tables, no
  migration.

## Out of scope

- G3, G4 (separate specs).
- `lib/prospects/walkthrough.ts` operator notification (internal recipient,
  `projectId: null`) — not prospect email. Noted only.
- Removing or rewriting `inbound_lead_qualification_v1`.

## Acceptance criteria

- [x] Workflow send with `actionType: "prospect_first_outreach"` → `safe_stop`,
      `failedCheck: "prospect_send_path"`, no `executeCapability` call, one
      would-have-happened row.
- [x] Workflow send to an address on a non-archived prospect contact (any
      `actionType`, any autonomy level, mixed case) → same refusal.
- [x] Archived contact's address does not trigger D1.
- [x] Non-prospect recipient at autonomy level 3 or 4 without `approvalId` →
      refused at `approval` (`safe_stop`).
- [x] Non-prospect recipient with a valid approval → unchanged behaviour
      (existing tests still pass).
- [x] `OUTBOUND_SENDS_ENABLED` off still refuses first (spec 159 unchanged).
- [x] Unit/integration tests for each case; `npm run typecheck`, `npm run lint`,
      `npm test` pass.
- [x] `DECISIONS.md` entry (dated) for D1/D2; `docs/deployment.md` G7 line
      marked closed.
