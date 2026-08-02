# AI Visibility MCP Tools

> Spec: `specs/033-mcp-visibility-interface.md` · Server: `mcp/server.ts` (`npm run mcp`, stdio) · Registry: `lib/mcp/tools.ts` · Schemas: `lib/mcp/schemas.ts`

## Shared contract (applies to every tool)

- **Permissions**: staff only (`admin`/`operator`/`reviewer`). The server refuses to start as a non-staff identity, and `invokeTool` re-checks per call (`forbidden`). Client roles have no MCP surface. Write tools additionally pass through the services' `assertCanWrite` — all staff may write, exactly as in the UI.
- **Validation**: every input is a strict zod object; unknown keys and malformed UUIDs are rejected with kind `validation`.
- **Errors**: returned as `"<kind>: <message>"` tool errors (`isError: true`), kinds from `lib/errors.ts` (`validation`, `not_found`, `conflict`, `forbidden`, `internal`, provider kinds). Never a stack trace.
- **Output**: one JSON text content block. Field names are the readers' shapes (camelCase from `db/`, snake_case for MCP-added envelope fields).
- **Unknown project/run ids** → `not_found` (house 404-not-403 rule).
- **Approval**: no tool decides or bypasses approvals. Nothing here acts outside the platform — publishing/sending stays behind the approval-gated workflows and their UI.

## Observer tools (read-only, no ledger rows, no side effects)

| Tool | Input | Output (summary) | Delegates to |
|---|---|---|---|
| `list_projects` | `{ include_archived?: boolean }` | projects with prompt-set/run counts | `db/projects.listProjects` |
| `get_project` | `{ project_id: uuid }` | `{ project, subject_company, companies }` | `db/projects` + `db/companies` + `db/competitors` |
| `list_prompt_sets` | `{ project_id }` | sets, each with `versions[]` (frozen snapshots) | `db/prompt-sets` |
| `list_runs` | `{ project_id }` | runs: status, providers, cost, timing | `db/runs.listRuns` |
| `get_run_status` | `{ run_id }` | `{ run, cells: {total, captured, failed, refusals}, pending_review }` | `db/runs` + `db/mentions` |
| `get_prompt_results` | `{ run_id }` | `{ run_status, mentions[] }` — current-revision classifications | `db/mentions.currentMentionsForRun` |
| `get_visibility_summary` | `{ project_id }` | `{ latest_scored_run_id, tiles, trend }` | `db/dashboard` |
| `compare_competitors` | `{ project_id }` | per-company latest metrics (provider `all`, current scoring version) | `db/competitors` |
| `get_citation_sources` | `{ project_id, limit?: 1–50 }` | cited domains with counts, source type, relationship | `db/competitors.listTopSources` |
| `get_gap_report` | `{ project_id, run_id? }` | gap findings, open first, by opportunity | `db/gaps.listGapFindings` |
| `list_experiments` | `{ project_id }` | interventions with baseline/post counts | `db/interventions.listInterventions` |
| `get_experiment` | `{ intervention_id }` | before/after verdicts + instrument/confound flags | `lib/attribution/service.interventionView` |
| `get_prompt_clusters` | `{ prompt_set_id }` | deterministic clusters of active prompts + `cluster_version` (computed on read) | `lib/prompts/cluster.clusterPrompts` |
| `search_learnings` | `{ query?, project_id?, category?, include_retired? }` | confidence-labeled learnings; project searches include cross-project rows | `lib/learnings/service.searchLearnings` |
| `list_pending_approvals` | `{}` | every undecided approval, ordered by urgency | `db/workflow.pendingApprovalsAcrossRuns` |

Failure modes: `not_found` on bad ids; empty arrays / `latest_scored_run_id: null` are honest empty states, not errors. `get_prompt_results` on an unparsed run returns `run_status` plus an empty `mentions` list so "not parsed" is distinguishable from "not mentioned".

## Operator tools (mutating)

Both write one row to the append-only `mcp_invocations` ledger per executed attempt (success or failure) — migration 039: tool, actor, sha-256 of canonical args, idempotency key, outcome, created entity. `dry_run` calls execute nothing and record nothing.

### `run_prompt_set`

- **Purpose**: start a benchmark run of a frozen prompt-set version — identical path to the runs/new page (`lib/runs/service.startRun`).
- **Input**: `{ project_id, prompt_set_version_id, label (1–80), providers: [{provider, model, repetitions 1–10}], budget_usd (0.5–100), dry_run?, idempotency_key? (1–128) }`
- **Output**: `{ idempotent_replay, entity_kind: "run", entity_id, run_id, status }`; dry run: `{ dry_run: true, estimate: { cellCount, estimatedMicroUsd, unverifiedPricing } }`.
- **Side effects**: inserts `runs` row, enqueues `execute_run`, publishes `benchmark.started`, writes the service's own `audit_log` row plus the MCP ledger row. The worker must be running for the run to execute.
- **Failure modes**: `validation` (unpinned model, missing pricing, budget out of range, version/project mismatch), `conflict` (archived project), `forbidden` (non-staff), provider errors surface later in run status, not here.
- **Idempotency**: same `(tool, idempotency_key)` after success → `{ idempotent_replay: true, entity_id }` and nothing executes. A failed attempt does not consume the key. Concurrent duplicate keys: both may execute; the second gets an explicit `conflict` naming both entities — never a silent pretend-replay.
- **Approval required**: no (internal, budget-capped action; same trust level as the UI form).
- **Example**: `{ "project_id": "…", "prompt_set_version_id": "…", "label": "post-comparison-page", "providers": [{"provider": "openai", "model": "gpt-5.4-2026-03-05", "repetitions": 3}], "budget_usd": 5, "idempotency_key": "retest-2026-08-08" }`

### `create_experiment`

- **Purpose**: register an intervention (experiment): links the two strongest baseline runs and schedules +2w/+6w/+12w retests of the same frozen version — identical path to the interventions form (`lib/attribution/service.createIntervention`).
- **Input**: `{ project_id, title (≤120), description?, shipped_at (YYYY-MM-DD), urls? (≤10), prompt_set_version_id, task_id?, dry_run?, idempotency_key? }`
- **Output**: `{ idempotent_replay, entity_kind: "intervention", entity_id, intervention_id, baseline_run_ids, baseline_weak, scheduled_offsets }`; dry run: `{ dry_run: true, validated_only: true }` (shape check only — no baseline inspection).
- **Side effects**: inserts `interventions` + `intervention_runs`, enqueues three future-dated `start_scheduled_run` jobs, MCP ledger row.
- **Failure modes**: `validation` (ship date >7 days in future, version/project mismatch), `not_found`, `forbidden`.
- **Idempotency / approval**: same semantics as `run_prompt_set`; no approval required. Optional `hypothesis` (≤500) is stored on the intervention (spec 034).

### `import_prompts`

- **Purpose**: bulk-import prompts into a set (spec 035) — plain lines or header-mapped CSV (`text,category,language,tier`).
- **Input**: `{ prompt_set_id, content (≤500k chars, ≤200 rows), dry_run?, idempotency_key? }`
- **Output**: `{ idempotent_replay, entity_kind: "prompt_set", entity_id, added, skipped_duplicates, rejected[] }`; dry run: full parse/dedupe report (`would_import`, `rejected`, `format`, `classifier_version`) with nothing written. Dry runs omit brand-name matching (they read no registry state); the real import uses the project's companies/aliases for the `branded` rule.
- **Side effects**: inserts `prompts` rows with `source='import'`, one `audit_log` row with counts, MCP ledger row. Frozen versions are untouched — import edits live prompts only.
- **Failure modes**: `validation` (zero importable rows — first reason named; unknown header column; row cap), `not_found`, `conflict` (archived set), `forbidden`.
- **Classification**: rows without a category get the deterministic rule suggestion (`prompt-classifier-v1+deterministic`); unmatched rows are rejected with "category required", never guessed.
- **Idempotency / approval**: standard operator-tool semantics; no approval required.

### `record_learning`

- **Purpose**: record a durable, confidence-labeled learning (spec 034) — always an explicit operator act, never auto-generated.
- **Input**: `{ project_id? (null = cross-project), category, statement (≤500), rationale?, confidence_label, source_action_outcome_ids? (≤20), evidence_note?, dry_run?, idempotency_key? }`
- **Output**: `{ idempotent_replay, entity_kind: "learning", entity_id, learning_id, confidence_label }`; dry run: `{ dry_run: true, validated_only: true }`.
- **Side effects**: inserts `learnings` row, `audit_log` row, MCP ledger row.
- **Failure modes**: `validation` — `confirmed`/`strongly_supported` without measured source outcomes (the gate names the unmeasured id); `not_found` on bad project/outcome ids; `forbidden` (non-staff).
- **Idempotency / approval**: same semantics as `run_prompt_set`; no approval required.

## Adding a tool

Define the schema in `lib/mcp/schemas.ts` (pure zod, strict), the tool in `lib/mcp/tools.ts` delegating to an existing service or `db/` reader, and tests in `tests/unit/mcp-schemas.test.ts` + `tests/integration/mcp.test.ts`. Rules: no business logic in the handler; mutations go through `executeMutation`; no tool may take an external action (publish/send/post) — those require the approval-gated workflow path, by design.
