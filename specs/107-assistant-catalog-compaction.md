# Spec 107 — Assistant Catalog Compaction (grouped catalog + describe_tools)

> Status: done
> Depends on: specs/096, specs/102–106
> Branch: feat/107-assistant-catalog-compaction

## Goal

The assistant renders all ~63 tools — full descriptions plus derived
input shapes — into the system prompt every turn: ~16.7k characters
(~4k tokens) of catalog before the conversation even starts, growing
with every new tool. This spec makes the per-turn catalog **compact and
grouped** (name, tier marker, first sentence only) and moves full
guidance + input shapes behind a free `describe_tools` meta-tool the
model calls on demand. Selection stays cheap and global (every tool name
is always visible); detail is lazy.

## Design

1. **Compact catalog.** Each tool renders as
   `- name[ (confirm)]: <first sentence of its description>`, grouped
   under headers (VISIBILITY, PROSPECTING, MARKETS, BENCHMARK RUNS,
   OUTREACH, AUDITS, META). The first sentence is derived
   deterministically (`summaryOf`) — never a second hand-written string
   that could drift from the description.
2. **Groups without 46 annotations.** A single `TOOL_GROUPS` map
   (name → group) lives next to the belt; MCP observer tools are
   implicitly VISIBILITY. A unit test asserts every tool is mapped —
   an unmapped new tool fails the suite, not production.
3. **`describe_tools` meta-tool** (read tier, group META): input
   `{ names: string[] 1–8 }`; returns, per name, the full description
   (with the confirm annotation) and the derived input shape — the exact
   text the old catalog carried. Unknown names return an
   `unknown: true` row naming the miss, never an error that kills the
   step.
4. **Prompt v3** (`workspace-assistant-v3`): the HOW-YOU-WORK rules gain
   one instruction — before first use of a tool whose exact input you
   don't already know from this conversation, call `describe_tools`
   (batch several names in one call); alternatively attempt the call and
   correct from the validation error, which states the expected shape
   (the spec-096 self-healing contract, unchanged). The multi-tool
   playbook paragraphs (city prospecting etc.) stay — they are the
   happy-path guidance that makes detail-on-demand safe.

Nothing changes in dispatch, tiers, the confirm gate, or any tool's
behavior. `MAX_TOOL_CALLS` stays 10 — describe_tools is one cheap step
and batches up to 8 names.

## UI / Database changes

None.

## Validation / Edge cases

- `summaryOf` splits on the first sentence boundary (`. ` following a
  non-abbreviation); a description without a period is its own summary.
- `describe_tools` with duplicate names dedupes; >8 names is a
  validation error (self-healing shape applies to the meta-tool too).
- The catalog test asserts the rendered compact catalog stays under
  **11,000 characters** at the current tool count — a hard ratchet that
  fails when growth erodes the compaction (raise it consciously, in a
  commit that says why).

## Acceptance criteria

- [ ] Compact grouped catalog renders < 11,000 chars with all current
      tools; every tool appears exactly once under exactly one group
      (unit).
- [ ] `describe_tools` returns full description + input shape for known
      names, `unknown` rows for misses (unit).
- [ ] Through the loop: the model calls `describe_tools`, then invokes
      the described tool successfully with the shape it learned
      (integration, scripted caller).
- [ ] Prompt v3 registered (version string bumped; docs/13 updated).
- [ ] Lint, typecheck, full suite pass.

## Test cases

- Unit (`assistant-tools.test.ts`): group coverage (every belt + observer
  tool mapped), summaryOf derivation, describe_tools known/unknown/batch,
  catalog-size ratchet.
- Integration (`assistant-operator.test.ts`): describe-then-call loop
  round trip.

## Definition of done

Acceptance criteria pass · tests green · lint/typecheck clean ·
`docs/05` + `docs/13` updated · `DECISIONS.md` entry · demoed against
seeded data.
