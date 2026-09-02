# Spec 115 — Assistant Tasks ("do this for me" — delegated multi-step jobs)

> Status: ready
> Depends on: specs/096, specs/107, specs/110, specs/114
> Branch: feat/115-assistant-tasks

## Goal

The assistant executes bounded turns (≤10 tool calls, then it must
answer); anything bigger dies at the turn boundary unless it has a
hard-coded pipeline (spec 097 is the one instance). This spec adds the
generic version: a **task** — a goal the operator confirms once, that the
worker's tick then advances autonomously through read/direct tools,
pausing at the confirm gate whenever a consequential action is needed,
and reporting back into its conversation when done. Spec 096's "no
multi-step autonomous plans" deferral is deliberately lifted here, with
the trust model extended rather than weakened.

## Trust model (the heart of the spec)

- **Creating a task is confirm-tier.** The Confirm click authorizes:
  autonomous execution of READ and DIRECT tools only, toward the stated
  goal, within two hard budgets (max steps, max LLM cost) shown in the
  confirmation summary.
- **Confirm-tier tools never execute autonomously.** Inside a task they
  mint pending actions exactly as chat does (now carrying `task_id`).
  When the model finishes planning-and-staging, the task parks as
  `awaiting_confirmation`; it resumes only after the operator decides
  every staged action, and the decisions (confirmed outcome or
  dismissal) are appended to the task transcript verbatim.
- **No recursion.** `create_task` / `cancel_task` invoked from inside a
  task loop are validation errors.
- **Budgets are hard.** Steps or LLM cost exhausted → status `failed`
  with a budget message — never a silent partial "success".
- **Observation, not control.** Cancelling is confirm-tier; a cancelled
  or failed task keeps its transcript (nothing is deleted).

## Database (migration 093)

- `assistant_tasks`: id, `user_id` FK, `conversation_id` FK (progress
  and the final report post there), `goal` text ≤2000, `status`
  check in ('running','awaiting_confirmation','completed','failed',
  'cancelled'), `transcript` jsonb (the loop's flat strings), `report`
  text null, `steps_taken` int, `max_steps` int, `cost_micro_usd`
  bigint, `max_cost_micro_usd` bigint, `last_error` text,
  created/updated timestamps; partial index on active statuses.
- `assistant_pending_actions` + nullable `task_id` FK (mint links task
  stagings; the resume check counts undecided rows by task).
- Down: drop column, drop table.

## Engine (`lib/assistant/tasks.ts`)

- `createTask(user, {goal, maxSteps=25 (5–50), maxCostUsd=2 (0.1–10)})`
  — inserts `running` + a fresh conversation titled from the goal;
  audit `assistant.task_created`. Called ONLY via the confirm gate.
- `advanceAssistantTasks(caller?)` — the tick lane (isolated, spec-097
  pattern): up to 3 active tasks, up to 5 loop steps each per tick.
  Each step: task prompt (`assistant-task-v1`, registered in docs/13 —
  catalog + rules + goal + preferences + "confirm-tier stages and the
  operator decides later; answer with your final report when the goal
  is done") → `runAgent` (purpose `assistant_task`, routing tier
  frontier) → the SAME dispatch the chat loop uses, extracted from
  `lib/assistant/service.ts` as `dispatchToolCall` (one implementation,
  imported by both — no duplicated gate logic).
  - answer + no undecided stagings → `completed`; `report` stored; the
    report posts into the conversation as an assistant message.
  - answer with undecided stagings → `awaiting_confirmation`; a
    conversation message lists what needs deciding.
  - budget exceeded → `failed` (budget named); LLM/step throw →
    `failed` with `last_error`. Every terminal state posts a
    conversation message — the dock is the notification surface.
- Resume: `awaiting_confirmation` tasks with zero undecided pending
  actions get `CONFIRMED …`/`DISMISSED …` lines appended and return to
  `running`.
- `cancelTask(user, {taskId, reason})` — own tasks only, active only;
  audit `assistant.task_cancelled`; undecided stagings are cancelled.

Notifications: the project-keyed attention feed does not fit
operator-keyed tasks (DECISIONS entry) — the surfaces are the task's
conversation (message on every state change) and a dock header line
("Tasks: N running · M need you") fed by a `listAssistantTasks` action.

## Belt tools

| Tool | Tier | Input |
|---|---|---|
| `create_task` | confirm | `{ goal: 10–2000, max_steps?: 5–50 = 25, max_cost_usd?: 0.1–10 = 2 }` — summary states goal + both budgets |
| `list_tasks` | read | `{ status?: enum(active, completed, failed, cancelled, all) = 'active' }` |
| `get_task` | read | `{ task_id: uuid }` — status, budgets spent, transcript tail, report |
| `cancel_task` | confirm | `{ task_id: uuid, reason: 5–500 }` |

Group `tasks` (new header "DELEGATED TASKS"); MUST_CONFIRM +=
`create_task` (`cancel_` already covered).

## Edge cases

- Requesting user deactivated → task `failed` at next advance (the
  city-pipeline precedent).
- A dismissed staging is not an error: the model sees `DISMISSED` and
  decides whether the goal is still achievable.
- The tick crashing mid-step: transcript and counters are persisted
  after every step, so the next tick resumes at the last durable step.
- Chat behavior unchanged when no tasks exist; `dispatchToolCall`
  extraction is behavior-preserving (existing suites prove it).

## Acceptance criteria

- [ ] Confirmed `create_task` starts a task; minting alone starts
      nothing (integration).
- [ ] A scripted task runs read/direct steps to completion; report +
      conversation message + cost recorded (integration).
- [ ] A task staging a confirm parks; the operator's decision resumes
      it with the outcome in the transcript; completion follows
      (integration).
- [ ] Step-budget exhaustion fails with the budget named (integration).
- [ ] Recursion refused; cancel cancels stagings (integration).
- [ ] Migration 093 up/down/up; lint, typecheck, full suite pass.

## Definition of done

Criteria pass · tests green · migration reversible · docs/05 + docs/13 +
DECISIONS.md updated · demoed against seeded data.
