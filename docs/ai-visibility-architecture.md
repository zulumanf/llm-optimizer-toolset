# AI Visibility Intelligence — Architecture

> Companion to `docs/02-system-architecture.md` (the canonical system doc) and `docs/ai-visibility-system-audit.md` (why this shape). This file covers only what the visibility-intelligence initiative adds; it does not restate the platform.

## The one-sentence architecture

The AI Visibility Intelligence system **is the existing platform** — registry → versioned prompt sets → provider-neutral runner → immutable capture → classification → citations → versioned scoring → gaps → tasks/content → approval-gated execution → scheduled retests — **plus a thin MCP interface layer** that exposes those domain services to AI agents.

## Layer map (request's target separation → this repo)

| Layer | Lives in | Status |
|---|---|---|
| Domain services | `lib/<domain>/service.ts` | pre-existing |
| Data layer | `db/` + `db/migrations/` (39 reversible migrations) | pre-existing (+039) |
| Worker layer | `workers/` + Postgres `jobs` queue | pre-existing |
| Evaluation layer | `lib/parsing`, `lib/scoring`, `lib/evidence`, `lib/attribution` | pre-existing |
| Orchestration | `lib/workflow` (graph engine), `lib/automation`, approvals, autonomy | pre-existing |
| **MCP interface** | `mcp/server.ts` + `lib/mcp/` | **added (spec 033)** |
| UI | `app/` (approvals, review, evidence remain human surfaces) | pre-existing |

## MCP layer design

- **One server, tool groups, not three services.** The request sketched observer/planner/operator servers; this is one app with a ~15-tool surface, so they are groups inside one binary (`observer` read-only, `operator` mutating). A future split is a file move, not a redesign.
- **Thin by rule**: handlers delegate to services/readers and contain no business logic. Transport-independent handlers (`lib/mcp/tools.ts`) mean contract tests never touch the SDK; `mcp/server.ts` is a process shell like `workers/index.ts`.
- **Actor model**: one operator identity per process (`MCP_USER_ID` → `users` row; dev fallback), staff-only, re-checked per invocation. Never the system principal — human-initiated work stays attributable to the human.
- **Mutation contract**: dry-run, optional idempotency key, append-only `mcp_invocations` ledger, and reuse of every existing gate (pinned models, pricing-required, budget caps, `assertCanWrite`).
- **No external actions**: publishing, sending, and connectors are not exposed as tools. The approval boundary (`workflow_approvals`, autonomy policies, `/approvals`) is upstream of any external effect and MCP cannot reach around it.

## Closed loop coverage

Steps 1–13 of the visibility loop and where each runs are tabulated in `docs/ai-visibility-system-audit.md` §B. Gaps (prompt discovery, recommendation triple, learnings loop) are phased in `docs/ai-visibility-roadmap.md` — designed, deliberately not built speculatively.
