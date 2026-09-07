# Spec 105 — Assistant Outreach Spine (suppression, sender identity, sequences)

> Status: done
> Depends on: specs/096, specs/102, docs/10
> Branch: feat/105-assistant-outreach-spine

## Goal

The assistant can send and schedule email but cannot see or manage the
compliance spine underneath: the suppression list, the CAN-SPAM sender
identity, and the automation-driven outreach sequences. Seven tools
expose them — three reads and four confirm-gated mutations — as thin
wrappers over existing primitives. Where a primitive takes a `Tx`
(`suppress`, `liftSuppression`, `stopSequence`), the belt wrapper mirrors
the exact `sql.begin` + role-gate shape of the existing server actions in
`app/automation/actions.ts` (`suppressContact`, `liftContactSuppression`,
`stopOutreachSequence`) — no new semantics.

## User stories

- As an operator, I can ask "who is suppressed?" and see the active list
  (scope, reason, when), and suppress an address/domain from chat
  (confirm click) when someone asks us to stop.
- As an admin, I can lift a suppression from chat (confirm click, with
  the permanently-recorded reason) — operators cannot.
- As an operator, I can check the active sender identity, and an admin
  can replace it from chat (confirm click).
- As an operator, I can list outreach sequences (status, step, next send)
  and stop one from chat (confirm click) — queued drafts are cancelled.

## UI / Database changes

None.

## API (assistant tools)

| Tool | Tier | Input (zod) | Backing call |
|---|---|---|---|
| `list_suppressions` | read | `{ scope?: enum('email','phone','domain'), include_lifted?: bool = false, limit?: int 1–100 = 30 }` | `listSuppressions` (`lib/outreach/suppression.ts:197`) |
| `suppress_contact` | confirm | `{ scope: enum, value: string 1–320, reason: enum(SUPPRESSION_REASONS), detail?: string ≤500, project_id?: uuid }` | `sql.begin` → `suppress` (`:70`) |
| `lift_suppression` | confirm (admin) | `{ suppression_id: uuid, reason: string 3–500 }` | `assertRole(admin)` + `sql.begin` → `liftSuppression` (`:170`) |
| `get_sender_identity` | read | `{}` | `getActiveSenderIdentity` (`lib/outreach/sender-identity.ts:26`) |
| `set_sender_identity` | confirm (admin, service-enforced) | `{ sender_name: 2–120, company_name: 2–120, postal_address: 10–300, reply_to_email: email }` | `setSenderIdentity` (`:53`) |
| `list_outreach_sequences` | read | `{ status?: enum('active','stopped','completed','all') = 'active', limit?: int 1–50 = 20 }` | inline SQL over `outreach_sequences` (belt-read precedent) |
| `stop_sequence` | confirm | `{ sequence_id: uuid, detail: string 5–500 }` | `sql.begin` → `stopSequence` with reason `'manual'` (`lib/outreach/sequences.ts:291`) |

Tier rationale: suppressing blocks future sends but is near-irreversible
for operators (lifting is admin-only, permanently recorded) — confirm.
Lifting reopens a do-not-contact instruction — confirm + admin, exactly
as the server action gates it. Sender identity is the legal CAN-SPAM
sender — confirm, with the service's own admin assertion. Stopping a
sequence cancels queued sendable artifacts — confirm. Chat stops are
always reason `'manual'`; `opted_out`/`bounced` (which also suppress
globally) remain inbound-signal semantics, never operator chat verbs.

## Validation rules

- Enums come from the modules' own constants (`SUPPRESSION_REASONS`,
  scope union) — never restated string lists.
- `list_outreach_sequences` `status: 'stopped'` matches every
  `stopped_*` status (`like 'stopped_%'`); rows return id, subject
  kind/ref, recipient, status, stop reason, step/maxSteps, nextSendAt —
  never message bodies.
- Catalog invariant extended: `suppress_`, `lift_`, `stop_`, and `set_`
  prefixes must be confirm-tier.

## Edge cases

- Suppressing an already-suppressed value returns
  `alreadySuppressed: true` (the primitive's `on conflict do nothing`) —
  reported, not an error.
- Lifting an already-lifted or missing entry returns `lifted: false` —
  reported honestly.
- A non-admin confirming `lift_suppression` or `set_sender_identity`
  fails at execution with the role error recorded in-thread (the
  confirm-gate contract: confirmed-but-failed, never silent).
- Stopping a non-active sequence returns `alreadyStopped: true`.
- `get_sender_identity` with none configured returns null — the model
  reports "not configured", pointing at the operator setup step.

## Acceptance criteria

- [ ] Seven tools at the tiers above; catalog assertion covers the four
      new prefixes.
- [ ] Confirmed `suppress_contact` inserts the audited entry; confirmed
      `lift_suppression` as admin lifts it; as operator it records the
      role failure in-thread and lifts nothing (integration).
- [ ] Confirmed `stop_sequence` stops an active sequence and cancels its
      queued draft messages (integration).
- [ ] `list_suppressions`, `get_sender_identity`, and
      `list_outreach_sequences` return through the loop (integration).
- [ ] Lint, typecheck, full suite pass.

## Test cases

- Unit: MUST_CONFIRM additions + prefix regex.
- Integration (`assistant-operator.test.ts`): suppression round trip
  (suppress → list shows it → lift as admin; operator lift attempt
  fails); sequence seeded active with a draft message → stop → status
  `stopped_manual`, message `cancelled`; sender identity set (admin) then
  read.

## Definition of done

Acceptance criteria pass · tests green · lint/typecheck clean · `docs/05`
updated · `DECISIONS.md` entry for the tier calls · demoed against seeded
data.
