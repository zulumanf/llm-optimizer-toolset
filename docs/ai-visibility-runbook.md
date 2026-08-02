# AI Visibility Intelligence — Runbook (MCP)

## Start the server

```bash
npm run mcp        # stdio MCP server; logs on stderr, protocol on stdout
```

Requirements: `.env` with `DATABASE_URL` (and migrations applied — `npm run db:migrate`). For runs to actually execute, the worker must be running: `npm run worker`.

Identity: under dev auth the server acts as the dev user. Under `AUTH_MODE=supabase`, set `MCP_USER_ID` to an active staff user's id or the server refuses to start. Non-staff ids are refused.

## Connect Claude Code

```bash
claude mcp add avos-visibility -- npm --prefix /path/to/llm-optimizer-toolset run mcp
```

(Or the equivalent entry in `.mcp.json` / Claude Desktop config: command `npm`, args `["--prefix", "<repo>", "run", "mcp"]`.)

## Verify it works

Ask the agent to call `list_projects`, or run the handshake manually — the server prints `avos-visibility MCP server ready (15 tools) as <email> [<role>]` on stderr once connected.

## Answering "what ran and why"

- **What did MCP change?** `select * from mcp_invocations order by created_at desc` — tool, actor, args hash, outcome, created entity. Read-only tools do not appear (they change nothing).
- **What did a run cost / which models?** `get_run_status` / the run page; per-cell cost, tokens, latency on `responses`.
- **Which parser/scoring versions?** stamped on `mentions` rows and `scores` rows; evidence pages re-derive numbers from raw rows.
- **Who approved an external action?** `workflow_approvals` via `/approvals` — MCP can list, never decide.

## Failure modes

| Symptom | Cause / fix |
|---|---|
| Server exits immediately with `refusing to start` | `MCP_USER_ID` missing/inactive/non-staff — provision or correct it |
| `Invalid environment: DATABASE_URL` on boot | `.env` not present in the working directory the server was spawned in |
| `run_prompt_set` returns `validation` about pricing/model | Model not in the pinned registry or missing a pricing row — deliberate gate |
| Run stays `pending` forever | Worker not running (`npm run worker`) |
| `conflict` mentioning an idempotency key | Two concurrent executions with one key — inspect both named entities; cancel the extra run if unwanted |
| Scores absent though the run completed | Pending human review gates scoring — `get_run_status.pending_review`, clear it at `/projects/<id>/review` |

## Rollback

The slice is additive. `npm run db:rollback` reverts migration 039 (the ledger); removing the `mcp` script and `mcp/` + `lib/mcp/` directories removes the surface. No measurement code depends on any of it.
