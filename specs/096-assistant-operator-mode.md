# Spec 096 — Assistant Operator Mode ("lets research the agents in X city")

**Status:** In progress
**Branch:** `feat/095-prospecting-dashboard` (stacked)
**Source:** Operator request 2026-08-20: the workspace chat should be able to
DO things — "research the agents in X city" — not just explain them. Spec
044 deliberately excluded mutating tools; this spec adds them behind the
platform's human gate, made conversational.

## The trust model (PRINCIPLES #8, conversational)

Two tiers, decided by consequence, enforced structurally:

- **Direct tools** — actions that stage, research, or create internal
  artifacts that themselves await human review downstream: draft a market
  pack, install it (creates a launch + frozen prompt pack), run discovery,
  enrich a prospect (staged proposals), generate findings (candidates),
  create an outreach draft (needs approval to send), add a contact, plus
  new pipeline read tools. The assistant executes these immediately — they
  are suggestions by construction.
- **Confirm-gated tools** — anything that spends provider budget or crosses
  the platform's consequence lines: start a live benchmark run, approve a
  finding or draft, send or schedule an email, publish an audit, approve an
  enrichment proposal, advance a stage. Invoking one does NOT execute: the
  server mints a single-use, expiring **pending action** bound to the exact
  tool + input (the body-hash pattern applied to conversation), and the
  dock renders Confirm / Dismiss buttons. Only the confirm server action —
  a human click in the operator's own session — executes. The model cannot
  mint, guess, or replay a token; a changed input is a different action.

## Pieces

1. **Migration 088** — `assistant_pending_actions`: conversation, user,
   tool, input (jsonb), human-readable summary, high-entropy token, status
   (pending/confirmed/cancelled/expired), result, timestamps. 15-minute
   expiry; single use; user-bound.
2. **`lib/assistant/tools.ts`** — the assistant belt: MCP observer tools
   (unchanged) + pipeline reads (`pipeline_dashboard`, `list_prospects`,
   `get_prospect`) + the direct and confirm-gated operator tools above, all
   thin wrappers over existing services (no new business logic — the gates,
   ledgers, and audit rows are the services' own).
3. **`lib/assistant/confirm.ts`** — mint/confirm/cancel; confirm executes
   the underlying service as the confirming user and appends the outcome to
   the conversation as an assistant message.
4. **Prompt v2** — the assistant may act; states which actions confirm;
   never promises an outcome before a tool result; still never invents data.
5. **Dock UI** — pending-action card on the reply (summary + Confirm /
   Dismiss); result posts into the thread.

## Out of scope

- Automation-layer/workflow control from chat; cron edits.
- Multi-step autonomous plans (each tool call remains one bounded step of
  the existing loop; MAX_TOOL_CALLS raised modestly for research chains).

## Acceptance criteria

- [ ] Catalog test: every tool that spends money or sends/publishes/approves
      is in the confirm-gated set (source-level assertion, like the MCP
      observer/operator split).
- [ ] Pending actions: minting, single-use confirm, expiry, wrong-user and
      tampered-token refusal (integration tests).
- [ ] "Research market" chain callable end-to-end through the assistant
      loop with an injected caller (no network in CI).
- [ ] Confirm-gated tool invoked by the model returns a proposal and
      executes nothing until confirmed (test).
- [ ] Lint, typecheck, full suite pass.
