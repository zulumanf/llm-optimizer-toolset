# Spec 110 — Assistant Streaming Progress ("what is it doing right now?")

> Status: ready
> Depends on: specs/044, specs/096, specs/107
> Branch: feat/110-assistant-streaming-progress

## Goal

`askAssistant` is one blocking server action: during a 10-step research
chain the dock shows "Looking things up…" for the whole loop — the
operator cannot see progress, and long chains feel broken. This spec
streams **step progress** (which tool is running, what each returned)
plus the final reply over SSE, while keeping the existing server action
as the untouched fallback path. No change to the loop's semantics,
tiers, or the confirm gate.

## Design

1. **Service events.** `askAssistant` gains an optional
   `onEvent?: (e: AssistantStreamEvent) => void` parameter and emits:
   `{type:"tool_start", tool}` before each dispatch,
   `{type:"tool_end", tool, ok, summary}` after (summary already
   truncated to the stored 400 chars),
   `{type:"done", reply}` with the full reply payload (conversationId,
   messageId, toolCalls, pendingActions, cost). Emission is fire-and-
   forget — an event-callback throw is caught and logged, never fails
   the turn. No other service change.
2. **SSE route** `app/api/assistant/stream/route.ts` (POST): same
   staff assertion and input schema as the action, wraps the service
   call in a `ReadableStream`, one `data:` line per event, `done` last,
   `error` on failure. **Architecture-rule exception, documented in
   DECISIONS.md:** route handlers are for webhooks/cron because
   *mutations* belong in server actions — this is a streaming transport
   for the same service call the action makes; the mutation semantics
   live in `lib/assistant/service.ts` either way.
3. **Dock.** Sends via `fetch` to the stream route and renders a live
   progress line per `tool_start`/`tool_end` (tool name + ✓/✗), then the
   reply. If the stream fails before any event arrives, falls back to
   the `askAssistant` server action transparently (progressive
   enhancement); a stream that dies mid-turn surfaces the error state.
   Existing states (pending actions, error, empty) unchanged.

## UI

The busy row "Looking things up…" becomes a step list while streaming:
each line `⚙ tool_name` flips to `✓ tool_name` / `✗ tool_name` on
tool_end. shadcn/typography per ui-conventions; no new components.

## Database changes

None.

## Validation / Edge cases

- The route validates the same zod input shape as the action; a bad body
  is a 400 with a JSON error event, never a hanging stream.
- Client disconnect mid-loop: the turn completes server-side and
  persists as today (the stream is observation, not control).
- `onEvent` absent (server action path, tests, confirm executions):
  byte-identical behavior to today.
- Event callback errors are swallowed with a log line — progress
  reporting can never break the turn.

## Acceptance criteria

- [ ] `askAssistant` with an events callback emits tool_start/tool_end
      pairs in order plus done with the reply; without it, behavior is
      unchanged (integration, scripted caller — no HTTP needed).
- [ ] The SSE route streams those events as `data:` lines and ends after
      done (route unit test with a stubbed service if session mocking is
      impractical; otherwise the route stays a thin adapter reviewed as
      such).
- [ ] Dock renders live steps and falls back to the server action on
      stream failure.
- [ ] Lint, typecheck, full suite pass.

## Definition of done

Criteria pass · tests green · lint/typecheck clean · docs/05 +
DECISIONS.md updated · demoed against seeded data.
