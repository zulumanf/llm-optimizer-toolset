# Spec 033 — MCP Visibility Interface

> Status: done (2026-08-01) — implemented and test-verified; see acceptance checklist
> Depends on: specs/001–005 (registry/prompts/runs/classification/competitors) · specs/007 (attribution) · specs/009 (gaps) · specs/014 (auth) · docs/ai-visibility-system-audit.md
> Branch: feat/033-mcp-visibility-interface

## Goal

Expose the existing measurement and analysis services to AI agents (Claude Code, Claude Desktop, future agents) through one Model Context Protocol server with narrowly-scoped, zod-validated tools. When this is done, an agent can answer "how visible is project X, versus whom, cited from where, with what gaps, at what cost" — and can start a benchmark run or register an experiment — **without any new business logic existing anywhere**: every tool is a thin delegation to a service or `db/` reader that already ships and is already tested. External actions (publishing, sending, connectors) are deliberately not exposed; they stay behind the existing approval-gated workflows.

This is the audit's recommended first slice (`docs/ai-visibility-system-audit.md` §L): the MCP layer was the only wholly absent layer in the target architecture.

## Non-goals

- No publishing/sending/connector tools — nothing in this spec can act outside the platform.
- No new metrics, parsers, or scoring paths. No prompt-discovery pipeline (roadmap).
- No HTTP/SSE transport, no multi-user token auth — stdio, one operator identity per process.
- No UI. Inspection happens through existing pages; the server is started from the CLI.

## User stories

- As an operator, I can point Claude Code at `npm run mcp` and ask visibility questions across my projects, so analysis doesn't require clicking through the UI.
- As an operator, I can have an agent start a benchmark run against a frozen prompt-set version (with dry-run cost estimate first), so remeasurement is scriptable — under the same budget/validation gates as the UI.
- As an operator, I can have an agent register an intervention (experiment) so the +2/+6/+12-week retests get scheduled exactly as if I had used the form.
- As an admin, I can see every MCP invocation in an append-only ledger: who, which tool, what arguments (hashed), what outcome.
- As a client user, I cannot use this at all — the server refuses non-staff identities.

## UI

None. This spec adds no pages. (`/approvals`, run pages, and the evidence pages remain the human surfaces.)

## Architecture

```
mcp/server.ts          # stdio entry point (like workers/index.ts) — registers tools, no logic
lib/mcp/context.ts     # actor resolution: MCP_USER_ID → users row (active + staff), dev fallback
lib/mcp/audit.ts       # invocation ledger writer + idempotency lookup
lib/mcp/tools.ts       # tool registry: name, description, zod schema, handler (transport-free)
db/gaps.ts             # NEW reader: listGapFindings(projectId, runId?)
db/interventions.ts    # NEW reader: listInterventions(projectId)
```

Handlers never touch the SDK — `mcp/server.ts` adapts them, so contract tests run without a transport. Tool groups: `observer` (read-only) and `operator` (mutating); one server, groups are a later split seam.

## Database changes (migration 039, reversible)

- `mcp_invocations` — id uuid pk, tool text, actor_id uuid → users, args_hash text (sha256 of canonical JSON args), idempotency_key text null, outcome text check in ('ok','error') — replays are responses, not recorded rows, entity_kind text null, entity_id uuid null, error text null, created_at timestamptz default now(). Insert-only (`forbid_mutation` trigger). Partial unique `(tool, idempotency_key) where idempotency_key is not null and outcome = 'ok'`. Index on `(created_at)`.
- Rollback: drop table.

## Tools

All tools: staff actor required (resolved once at startup, re-verified per invocation), zod-validated input, JSON output, errors returned as classified messages (never stack traces). Read tools write no ledger rows (they are pure reads and would bloat the ledger); mutating tools always write one.

### Observer (read-only)

| Tool | Delegates to | Input |
|---|---|---|
| `list_projects` | `db/projects.listProjects` | `{ include_archived? }` |
| `get_project` | `db/projects.getProject` + `db/companies.getSubjectCompany` + `db/competitors.listComparisonCompanies` | `{ project_id }` |
| `list_prompt_sets` | `db/prompt-sets.listPromptSets` + `listVersionSummaries` | `{ project_id }` |
| `list_runs` | `db/runs.listRuns` | `{ project_id }` |
| `get_run_status` | `db/runs.getRun` + `listRunCells` (summary counts) + `db/mentions.pendingReviewCount` | `{ run_id }` |
| `get_prompt_results` | `db/mentions.currentMentionsForRun` | `{ run_id }` |
| `get_visibility_summary` | `db/dashboard.selfTiles` + `authorityTrend` + `latestScoredRunId` | `{ project_id }` |
| `compare_competitors` | `db/competitors.listComparisonCompanies` + `latestScoresByCompany` | `{ project_id }` |
| `get_citation_sources` | `db/competitors.listTopSources` | `{ project_id, limit? }` |
| `get_gap_report` | `db/gaps.listGapFindings` (new reader over `gap_findings`) | `{ project_id, run_id? }` |
| `list_experiments` | `db/interventions.listInterventions` (new reader) | `{ project_id }` |
| `get_experiment` | `lib/attribution/service.interventionView` | `{ intervention_id }` |
| `list_pending_approvals` | `db/workflow.pendingApprovalsAcrossRuns` | `{}` |

### Operator (mutating — dry-run, idempotency key, ledger row, actor identity)

| Tool | Delegates to | Notes |
|---|---|---|
| `run_prompt_set` | `lib/runs/service.startRun` (dry-run → `estimateRunForVersion`) | Same validation/budget/pricing gates as the UI; `dry_run: true` returns the cost estimate and writes nothing. |
| `create_experiment` | `lib/attribution/service.createIntervention` | Schedules the +2/+6/+12w retests via the existing job queue. `dry_run: true` validates input only and says so explicitly (`validated_only: true`). |

Idempotency: a repeated call with the same `(tool, idempotency_key)` after a prior `ok` outcome returns the recorded entity reference with `idempotent_replay: true` and executes nothing. Keys are optional; without one, replay protection is the caller's responsibility (documented in tool description).

## Actor resolution and authorization

- `MCP_USER_ID` env set → load that `users` row; must exist, be active, and hold a staff role (`admin`/`operator`/`reviewer`), else the server refuses to start.
- `MCP_USER_ID` unset and `AUTH_MODE != supabase` → the dev user (same identity `getCurrentUser()` returns in dev), staff check still applied.
- `MCP_USER_ID` unset and `AUTH_MODE = supabase` → refuse to start. The system principal is **not** used: MCP invocations are operator-initiated, and "acted by a person" must stay distinguishable from "acted by the platform".
- Mutations flow through the services' own `assertCanWrite` — enforced where it already lives, not re-implemented. Note the platform's model: **all staff roles (including reviewer) may write**, exactly as in the UI; MCP adds no bespoke role logic. Non-staff identities are refused at startup and again per-invocation (defense in depth in `invokeTool`).

## Validation rules

- Every tool input is a strict zod object (`.strict()`); unknown keys are rejected.
- UUID params validated as UUIDs before any query; bad ids → classified `validation` error.
- Unknown project/run/intervention ids → `not_found` message (mirroring the 404-not-403 house rule; MCP is staff-only so this is hygiene, not a boundary).
- `limit` capped at 50. `idempotency_key` 1–128 chars.
- Mutating tool outcomes recorded even on error (`outcome: 'error'`, message in `error`).

## Edge cases

- Project with no scored runs → `get_visibility_summary` returns `latest_scored_run_id: null` and empty tiles, not an error.
- `get_prompt_results` on an unparsed run → empty list plus the run status so the agent can tell "not parsed yet" from "no mentions".
- Review queue non-empty → surfaced in `get_run_status` (`pending_review` count) so agents understand why scores are absent; scoring gates are untouched.
- Idempotency replay where the original run was later cancelled → still replays the reference (the ledger records creation, not lifecycle); status comes from `get_run_status`.
- Two concurrent calls with the same key → both may execute (the ledger is append-only, so there is no pre-execution claim); the partial unique index rejects the second record and the caller gets an explicit conflict naming both entities — never a silent pretend-replay. The stdio server serves one client sequentially, so this is theoretical.
- Provider keys absent → `run_prompt_set` fails exactly as the UI does (mock is test-gated); the error is passed through, never masked.

## Acceptance criteria

- [x] `npm run mcp` starts a stdio MCP server exposing exactly the 15 tools above, each with a description and schema.
- [x] Every read tool returns data identical to what the corresponding page/service renders (delegation, no reimplementation).
- [x] `run_prompt_set` with `dry_run` returns the same estimate as the runs/new page; without it, creates a run visible in the UI and enqueues `execute_run`.
- [x] `create_experiment` creates an intervention with baseline linkage and three scheduled retest jobs, identical to the form path.
- [x] Mutating invocations write `mcp_invocations` rows; the same idempotency key never creates a second run/intervention.
- [x] A non-staff `MCP_USER_ID` (or missing user) prevents server start, and a non-staff actor reaching `invokeTool` directly is refused with `forbidden`; staff mutations are attributed to the acting user in the ledger.
- [x] Migration 039 applies and rolls back cleanly.
- [x] No file in `lib/runs`, `lib/scoring`, `lib/parsing`, `lib/attribution` (except none), or existing `db/` modules is modified.

## Test cases

- Unit (`tests/unit/mcp-tools.test.ts`): registry completeness (15 tools, unique names, descriptions non-empty); schema strictness (unknown key rejected, bad UUID rejected, limit cap); args hashing stable under key reordering.
- Integration (`tests/integration/mcp.test.ts`, TEST_DATABASE_URL): seed project/companies/prompt set/frozen version → freeze → mock-provider run path where needed; each read tool against seeded state incl. empty states; `run_prompt_set` dry-run vs estimate parity, real call creates run + job; idempotent replay (second call, same key → same run id, `idempotent_replay: true`, exactly one `mcp_invocations` ok row per key); reviewer actor authorization failure recorded as `outcome: 'error'`; `create_experiment` schedules three `start_scheduled_run` jobs; ledger immutability (UPDATE/DELETE raise).

## Definition of done

All acceptance criteria pass · tests green · `npm run lint` and `npm run typecheck` clean · migration 039 up/down/up clean · `docs/ai-visibility-mcp-tools.md` documents every tool (purpose, schemas, permissions, side effects, failure modes, idempotency, approval requirements) · `docs/02-system-architecture.md` names the MCP layer · DECISIONS.md records the one-server decision.
