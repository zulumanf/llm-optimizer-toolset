# Spec 112 — Assistant Conversation List ("where did that chat go?")

> Status: ready
> Depends on: specs/044, specs/096
> Branch: feat/112-assistant-conversation-list

## Goal

The dock remembers exactly one conversation id in `localStorage`; "New
chat" orphans the old thread forever even though every message is
persisted. A History dropdown in the panel header lists the operator's
own recent conversations and reopens any of them. No schema change —
the data is already there.

## Design

1. **Service** `listConversations(user, limit = 20)` in
   `lib/assistant/service.ts`: the caller's own conversations only
   (ownership exactly as `loadConversation` enforces), newest
   `last_message_at` first, returning `{ id, title, lastMessageAt,
   messageCount }`.
2. **Action** `listAssistantConversations()` in
   `app/assistant/actions.ts` — same thin `getCurrentUser` → service
   shape as its four siblings.
3. **Dock** (`components/assistant/assistant-dock.tsx`): a History
   button (lucide `History`, ghost, size sm) in the panel header opens a
   small list layer (existing shadcn primitives only): `text-xs` rows —
   title, relative date, message count. Selecting one sets and stores
   the conversation id, loads messages + pending actions via the
   existing `getAssistantConversation` / `getPendingAssistantActions`.
   States: "Loading…" row while fetching, "No previous chats." when
   empty. "New chat" behavior unchanged — the old thread simply remains
   reachable now.

## Edge cases

- A stored id belonging to a deleted/foreign conversation already falls
  back to a fresh chat (existing `loadHistory` path) — unchanged.
- Switching conversations while a turn is in flight is blocked the same
  way the composer is (`pending || busy`).
- Titles are the first message's first 80 chars (existing behavior) —
  rendered truncated, never wrapped.

## Acceptance criteria

- [ ] `listConversations` returns only the caller's conversations,
      newest-first with counts (integration).
- [ ] Dock: history opens, lists, reopens a conversation with its
      messages and pending actions; loading/empty states present
      (manual demo; no component-test harness exists for the dock).
- [ ] Lint, typecheck, full suite pass.

## Definition of done

Criteria pass · tests green · lint/typecheck clean · docs/05 updated ·
demoed against seeded data.
