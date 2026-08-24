# Spec 108 — Assistant Operator MCP Tools (experiments, prompt import, learnings)

> Status: done
> Depends on: specs/033, specs/096, specs/107
> Branch: feat/108-assistant-operator-mcp-tools

## Goal

The three MCP operator-group tools — `create_experiment`,
`import_prompts`, `record_learning` — are structurally invisible to the
chat (spec 096 filters the catalog to observer tools). They already carry
the platform's full mutation machinery (`executeMutation`, `dry_run`,
idempotency keys, audit). Three belt wrappers expose them at the right
tiers, reusing the exported zod schemas from `lib/mcp/schemas.ts`
verbatim — one schema, validated at the belt boundary and again inside
`invokeTool`, zero drift.

## API (assistant tools)

| Tool | Tier | Schema | Backing call |
|---|---|---|---|
| `create_experiment` | confirm | `createExperimentSchema` | `invokeTool("create_experiment")` |
| `import_prompts` | direct | `importPromptsSchema` | `invokeTool("import_prompts")` |
| `record_learning` | confirm | `recordLearningSchema` | `invokeTool("record_learning")` |

Tier rationale: an experiment schedules +2w/+6w/+12w retest runs —
future provider spend and a measurement commitment → confirm. Prompt
import writes internal pre-freeze artifacts with a dry-run report and
duplicate-skip — the `run_discovery` consequence class → direct (freezing
and running stay separately gated). A learning is durable and "never
auto-generated; calling this is an explicit operator act" — the confirm
click IS that explicit act when the words came from a model → confirm.

Groups: `create_experiment` → visibility, `import_prompts` → runs,
`record_learning` → visibility (TOOL_GROUPS additions).

## Validation / Edge cases

- `dry_run` passes through — the model can and should dry-run an import
  first (the description says so).
- The strict schemas reject unknown keys; self-healing shape errors
  apply.
- Confirm-tier `create_experiment` with `dry_run: true` still routes
  through the gate (a validated-only proposal is harmless but uniform —
  no special-casing tiers on input values).

## Acceptance criteria

- [ ] Three tools at the tiers above, schemas imported not restated;
      TOOL_GROUPS covers them (existing unit test enforces).
- [ ] Confirmed `record_learning` writes the learning; direct
      `import_prompts` dry-run returns the parse report through the loop
      (integration).
- [ ] Lint, typecheck, full suite pass.

## Test cases

Unit: MUST_CONFIRM additions. Integration (`assistant-operator.test.ts`):
dry-run import through the loop; record_learning mint + confirm → row in
`learnings`.

## Definition of done

Criteria pass · tests green · lint/typecheck clean · docs/05 updated.
