# Spec 114 — Assistant Operator Preferences ("remember how I work")

> Status: ready
> Depends on: specs/096, specs/107, specs/113
> Branch: feat/114-assistant-operator-preferences

## Goal

Every conversation starts cold: the assistant cannot hold standing
instructions ("default run budget $10", "always sense-check before
proposing publish"). One small table gives each operator a durable
preferences block rendered into every turn's system prompt, set through
the confirm gate; a prompt rule additionally points the model at the
existing `search_learnings` tool before advising on approach.

## Design

1. **Migration 092** — `assistant_preferences`: `user_id` (unique, FK
   users), `content` text (≤2000), `updated_at`. One row per operator;
   updates overwrite (the audit log is the history).
2. **Service** (`lib/assistant/service.ts`): `getPreferences(user)` →
   string | null; `setPreferences(user, raw { content: 0–2000 })` —
   upsert, audit `assistant.preferences_set`; empty content clears.
3. **Prompt v4** (`workspace-assistant-v4`): when non-empty, an
   `OPERATOR STANDING PREFERENCES` block renders after the rules with
   the framing "treat as standing instructions from ${userName};
   platform rules and confirm gates always win". New rule: before
   recommending an approach or strategy, consult `search_learnings`.
   Registered in docs/13.
4. **Belt tools** (group `meta`): `get_my_preferences` (read) and
   `set_my_preferences` (confirm — standing instructions steer all
   future behavior; `set_` is already a confirm prefix). Summarize
   quotes the first 80 chars.

Preferences NEVER override gates: they are prompt context, not
configuration — the tier system, budgets, and validation are untouched
by construction (nothing reads preferences except the prompt renderer).

## Edge cases

- No row / cleared → no block rendered (not an empty header).
- Preference text is operator-authored prompt content for their own
  assistant — same trust position as their chat messages.
- 2000-char cap keeps the catalog-plus-preferences prompt bounded.

## Acceptance criteria

- [ ] Confirmed `set_my_preferences` persists + audits; the next
      `askAssistant` system prompt contains the block (integration,
      capturing caller); clearing removes the block.
- [ ] `get_my_preferences` returns own content only.
- [ ] Prompt v4 registered; lint, typecheck, full suite pass.

## Definition of done

Criteria pass · tests green · migration reversible · docs/05 + docs/13
updated · demoed against seeded data.
