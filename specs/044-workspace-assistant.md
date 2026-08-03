# Spec 044 — Workspace Assistant (persistent, context-aware chat dock)

A staff-only chat assistant docked at the bottom of every workspace page, answering
questions from **live platform data** — visibility scores, prospects, gaps, citations,
funnel state — with the conversation and every data lookup persisted and auditable.

## Principles applied

- **One tool belt, no second business logic.** The assistant's entire data access is
  the existing MCP **observer** tool registry (`lib/mcp/tools.ts`), invoked through
  `invokeTool` with the logged-in user's identity — the same per-invocation staff
  assertion, zod validation, and classified errors the MCP server gets. Operator
  (mutating) tools are **excluded**: the assistant reads and explains; it never
  writes platform state. v1 is deliberately read-only.
- **One agent runner.** LLM calls go through `lib/ai/agent.ts` (`runAgent`, pinned
  model, JSON-validated output, injectable caller) — no new vendor SDK usage, and
  tests inject a fake caller so CI stays keyless. Without `OPENAI_API_KEY` the dock
  answers with a clear "assistant needs a provider key" error, never a fabrication.
- **Every turn is a bounded loop.** Per user message: at most `MAX_TOOL_CALLS = 6`
  tool invocations, then the model must answer. Each iteration the model returns
  strict JSON — `{action:"tool", tool, input}` or `{action:"answer", answer}` — and
  invalid tool calls come back to it as tool-result errors rather than crashing the
  turn. Per-turn cost is accounted (micro-USD) and stored on the message.
- **Conversations are records.** Migration 050: `assistant_conversations` +
  insert-only `assistant_messages` (role, content, the tool calls made with inputs
  and result summaries, cost). "All the context" = the persisted conversation (last
  `HISTORY_LIMIT = 20` messages), the page the user is on (pathname, sent by the
  dock), user identity/date, and whatever the tools return — never invented memory.
- **Prompt lives with the feature and is registered in docs/13** (the
  `lib/*/prompts.ts` convention): identity, honesty rules (say "not measured", never
  invent numbers; cite which tool a figure came from), tool catalog, JSON protocol.
- **Rendering follows the sidebar rule**: the dock is a server-gated component that
  renders nothing without a staff session (`getCurrentUserOrNull` + `isStaff`) — so
  it never appears on `/login`, the public `/audit/[token]` pages, or the client
  portal. The security boundary stays the server action + service, which re-assert
  staff identity regardless.

## 1. Migration 050

```sql
create table assistant_conversations (
  id, user_id → users NOT NULL, title text,
  started_at, last_message_at, archived_at
);
create table assistant_messages (
  id, conversation_id →, role check in ('user','assistant'),
  content text not null,
  tool_calls jsonb not null default '[]',   -- [{tool, input, ok, summary}]
  cost_micro_usd int, created_at
);  -- insert-only (forbid_mutation)
```

Conversations are per-user; the service refuses to append to another user's
conversation.

## 2. `lib/assistant/` — prompt.ts + service.ts

`askAssistant(user, {conversationId?, message, pathname})`:

1. Staff-assert; create or load the caller's conversation (+ history).
2. Agent loop over `runAgent` with the tool catalog (observer tools' names +
   descriptions) in the system prompt and a transcript that grows with each tool
   result; every `invokeTool` runs as the calling user.
3. Persist the user message and the assistant message (with tool-call log + cost),
   bump `last_message_at`, set a title from the first message.
4. Return `{conversationId, reply, toolCalls, costMicroUsd}`.

`getConversation(user, conversationId)` for reload; server actions in
`app/assistant/actions.ts`.

## 3. UI — `components/assistant/assistant-dock.tsx`

Fixed bottom-right dock: collapsed pill ("Ask AVOS"), expanded panel with the
transcript, tool-call chips ("looked up get_visibility_summary"), input, and error
states. `conversationId` in localStorage; sends the current pathname as context.
Mounted in the root layout via the server-gated wrapper.

## Acceptance criteria

- [ ] With a fake caller: a question triggers a tool call → the tool result reaches
      the second iteration → the final answer is returned and persisted with the
      tool-call log and cost; the loop hard-stops at MAX_TOOL_CALLS.
- [ ] Mutating (operator) tools are invisible to and un-invokable by the assistant
      even if the model asks for one by name.
- [ ] Invalid tool names/inputs surface to the model as tool errors; the turn still
      ends in an answer.
- [ ] Non-staff callers are refused at the service; another user's conversation is
      not readable or appendable.
- [ ] Keyless environments get a classified provider_auth error, no fabricated reply.
- [ ] Messages table is insert-only; migration 050 up/down; full gates green.
