# Spec 159 — Measurement/outreach isolation (Medina P0, "Spec D")

> Status: ready
> Depends on: specs/148, specs/150, specs/158, docs/deployment.md
> Branch: feat/159-measurement-outreach-isolation

## Goal

The production worker can be started to run Medina's contractual measurement
**without** starting the outreach engine or any unrequested paid work. Today,
the first boot after weeks offline would immediately:

- email every overdue approved draft (no lateness bound);
- re-enable every event subscription and the platform control-tower trigger;
- resume city pipelines, enrichment sweeps, weekly baselines and cycles,
  intervention retests, assistant tasks and video renders.

After this spec, the default — every variable unset — is **measurement only,
nothing outbound**. Outreach and automation are explicit, separate,
operator-set switches. This closes Medina audit P0-04 and gaps G1, G2, G5,
G6, G8 and G9 from the 2026-10-24 side-effect inventory. G3, G4 and G7 are
neutralised while the switches are off and listed as must-fix before
outreach is re-enabled.

## What is reused (audit result — do not rebuild)

- **The job queue**, `db/jobs.ts`. `claimNextJob` gains an optional type
  allow-list; leasing, retry and backoff are unchanged.
- **One dispatch step**, `workers/core.ts` `dispatchOnce`, and **one tick**,
  `lib/ops/tick.ts` (`runAutomationTick`, `runWeeklyKick`,
  `runWeeklyBaselines`). The cron routes already call these, so gating
  inside them covers worker and web alike.
- **One external-action boundary**, `lib/connectors/execute.ts`
  `executeCapability`, plus the existing `CONSEQUENTIAL_CAPABILITIES` list
  (`lib/connectors/types.ts`). Test mode already refuses these; live mode
  gains the global switch.
- **One send entry point**, `sendProspectDraft`, and **one scheduled-send
  drain**, `drainScheduledSends`, including its existing `park()` (clears
  `scheduled_send_at` with a reason the operator sees in the outbox).
- **Bootstrap**, `bootstrapAutomation` / `installTriggers`, `upsertTrigger`
  and `upsertSubscription`.
- **The env schema**, `lib/env.ts`. The opt-in convention (unset = off) is
  the one spec 158 used for `PROFILE_CORRECTIONS_ENABLED`.

## Database changes

None.

## Changes

### D1 — Automation mode (`AUTOMATION_MODE`)

`AUTOMATION_MODE`: `measurement_only` (**default**, also used for any
unrecognised value) | `full`. One helper, `automationMode()` in
`lib/ops/mode.ts`.

In `measurement_only`:

1. **The worker claims only measurement jobs**: `MEASUREMENT_JOB_TYPES` =
   `execute_run`, `parse_response`, `compute_scores`, `backfill_company`
   (alias re-parse), `analyze_gaps`, `analyze_accuracy`. Every other job
   stays `queued`, untouched, for when automation is enabled. It is never
   failed, deleted or run. This includes `start_scheduled_run`,
   `advance_cycle`, `advance_workflow`, `deliver_events`,
   `render_video_walkthrough`, `dispatch_triggers` and the
   profile-correction jobs.
2. **`runAutomationTick`, `runWeeklyKick` and `runWeeklyBaselines` do
   nothing** and return `{ skipped: "measurement_only" }`. This applies to
   both callers: the worker's internal clock and the `/api/cron/*` routes on
   the web service.
3. **Kept:** heartbeat, stale-lease reclaim, orphaned-run reaping. Reclaimed
   non-measurement jobs go back to `queued` and stay there (G9).
4. The worker logs its mode and job allow-list at start (`worker.start`).

In `full`: today's behaviour, plus D2–D4.

### D2 — Global outbound switch (`OUTBOUND_SENDS_ENABLED`)

`OUTBOUND_SENDS_ENABLED`: only the exact string `"true"` enables. Any other
value, or unset, means off.

- **`executeCapability` refuses every consequential capability in live mode
  while it is off.** That covers `email.send_approved_message`,
  `cms.publish_approved_asset`, `billing.create_invoice`,
  `billing.send_reminder` and `notification.send_client`, whatever the
  caller: scheduled drain, workflow node, assistant, script, or manual send.
  The refusal is non-retryable (`errorCode: "outbound_disabled"`), and the
  adapter is never called.
- **`sendProspectDraft` refuses first** for a transmitting channel (`gmail`,
  `mock`), with a clear operator message ("Outbound sending is switched
  off"), before any read of the draft or any ledger write. The Send button
  therefore explains itself. Recording a `manual` send (the human already
  sent it from their own mailbox, and the platform transmits nothing) stays
  allowed.
- **`drainScheduledSends` returns immediately** while off, with nothing due
  and nothing touched: no claim, no park, no reconcile, no Gmail read.
  Schedules survive the pause unchanged.

### D3 — Overdue scheduled sends need reconfirmation (G2)

When sends are enabled again, a draft whose `scheduled_send_at` is more than
`SCHEDULED_SEND_MAX_LATENESS_HOURS = 24` in the past is **parked, not
sent**. The park reason names the original time ("…was due <date>; confirm
it still makes sense, then reschedule."). This also catches the rows a
long-stopped worker left behind. Drafts with an outstanding claim keep the
existing stale-claim reconciliation; it runs before lateness, so a
possibly-sent message is never treated as unsent.

### D4 — Bootstrap never re-enables (G5, G8)

`upsertTrigger` and `upsertSubscription` take a `bootstrap` flag. On
conflict, bootstrap may **disable** an existing row (client-scoped
templates and webhooks stay forced off, as today) but never **enable** one.
SQL: `enabled = existing.enabled and excluded.enabled`. New rows still get
the declared default. Non-bootstrap callers (operator toggles, per-client
clones) keep today's overwrite semantics.

## Classification (who can cause what, after this spec)

| Path | Default (both unset) | `AUTOMATION_MODE=full`, sends off | Both on |
|---|---|---|---|
| Measurement run (operator-started) → execute/parse/score | runs | runs | runs |
| Tick sections, weekly kick, weekly baselines, cron routes | off | run | run |
| Non-measurement jobs | stay queued | run | run |
| Any consequential connector capability (live) | refused | refused | gated by existing per-path checks |
| Scheduled drain | no-op | no-op | sends; >24 h late → parked |
| Bootstrap | cannot enable a disabled row | same | same |

## Edge cases

- **`AUTOMATION_MODE=full` while sends are off**: follow-ups, report
  handoffs and workflows still prepare drafts, call models and publish
  audit pages (G4, G6). This is a deliberate operator state ("automation
  on, nothing leaves"), and it is documented as such in `docs/deployment.md`.
- **A run started in `measurement_only` publishes domain events**: those
  events wait undelivered (`deliver_events` is not claimed). Nothing is
  lost.
- **A `measurement_only` worker next to a `full` web service**: the cron
  routes would run the tick on web. The deploy doc tells the operator to
  set the same mode on both services. Unset on both is the safe pair.
- **The mode variable is mistyped**: it falls back to `measurement_only`.
  An unrecognised value never means `full`.
- **Walkthrough notices** (`notifyOperator`, a Gmail send to our own
  reply-to address) are refused while sends are off. This is accepted: the
  switch is global on purpose.
- **Exactly 24 h late**: sent (`>` is strict). Lateness is measured against
  `now()` in the database, not the worker's clock.

## Out of scope (recorded; must be fixed before `OUTBOUND_SENDS_ENABLED=true`)

- **G3**: follow-up touches dispatch at boot time, not in the
  recipient-local window. D3 bounds lateness only.
- **G4**: in SHADOW, report handoffs publish audit pages and make a
  frontier call. The handoff kill switch does not stop already-scheduled
  deliveries; D3 parks them only after 24 h.
- **G7**: the workflow-engine send path (`int.email_send_approved_message`)
  lacks the spec 148/150 gates, and `autonomy_policies` ≥ 3 skip approval.
- The spend ceiling is not applied to agent or Perplexity calls (G6 in
  `full`).
- The video job handler ignores `VIDEO_WALKTHROUGH_KILL_SWITCH`.

## Acceptance criteria

- [ ] With every variable unset, booting the worker logic and draining the
      queue runs a queued `execute_run`/`parse_response`/`compute_scores`
      chain, and leaves every non-measurement job `queued` with
      `attempts = 0`.
- [ ] With every variable unset, `runAutomationTick`, `runWeeklyKick` and
      `runWeeklyBaselines` return skipped, and make no trigger dispatch, no
      event delivery, no send and no run (spied).
- [ ] The cron route for the automation tick returns skipped in
      `measurement_only`.
- [ ] `executeCapability` in live mode refuses each consequential
      capability while sends are off: the adapter is never invoked, and the
      result is non-retryable `outbound_disabled`. Non-consequential
      capabilities still run.
- [ ] `sendProspectDraft` on a transmitting channel with sends off returns
      `forbidden`, with zero database writes and zero capability calls. A
      `manual` record is still accepted.
- [ ] `drainScheduledSends` with sends off returns zeros, and the
      scheduled rows are byte-identical afterwards.
- [ ] With sends on, a draft 25 h overdue is parked with a reason naming its
      original time and is never dispatched; a draft 1 h overdue is
      dispatched.
- [ ] After an operator disables a trigger and a subscription, bootstrap
      leaves both disabled. A client-scoped template trigger that someone
      enabled is still forced off. A brand-new row gets the declared
      default.
- [ ] `automationMode()` maps unset, garbage and `measurement_only` to
      `measurement_only`; only `full` gives full. The outbound switch
      accepts only `"true"`.
- [ ] Every spec 156 security suite still passes unchanged.

## Definition of done

All acceptance criteria pass · full vitest green · lint and typecheck clean
· `docs/deployment.md` worker section updated (both variables, same values
on web and worker, the pre-start checklist) · `DECISIONS.md` entry ·
deferred items above listed.
