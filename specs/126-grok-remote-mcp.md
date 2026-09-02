# Spec 126 — Remote MCP connector for Grok (read-only)

Status: In progress (2026-09-01)
Branch: `feat/126-grok-remote-mcp`

## Why

Grok Bot (grok.com Connectors) and the xAI API's Remote MCP Tools must read
RecommendedFirst visibility data through Model Context Protocol instead of
scraping the web UI. The existing MCP server (spec 033) is stdio-only with one
operator identity per process — unusable as a public HTTPS endpoint.

## What ships (phase 1)

A Streamable-HTTP MCP endpoint on the existing Next.js app:

- `POST /mcp` — MCP Streamable HTTP (stateless; SDK `WebStandardStreamableHTTPServerTransport`,
  `sessionIdGenerator: undefined`, JSON responses). `GET`/`DELETE /mcp` are
  answered by the same transport per spec (405 in stateless mode).
- `GET /healthz` — `{ ok: true, version }`, unauthenticated.
- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata declaring
  bearer-only auth (phase 2 OAuth stub).
- Personal access tokens (`rf_live_` / `rf_test_` + 32 random bytes base64url),
  sha256-hashed at rest in `mcp_tokens`, scope `mcp:read`, bound to a staff
  user. Missing/invalid/revoked → 401 + `WWW-Authenticate: Bearer`.
- Rate limit 60 tool calls / minute / token → 429 (window counted from the
  `mcp_tool_calls` audit ledger, so it is correct across instances).
- Audit ledger `mcp_tool_calls` (insert-only): token, tool, argument ids,
  duration, error. Never the token, never answer text.

Eight read-only tools (exact names): `whoami`, `list_markets`, `list_teams`,
`get_visibility_snapshot`, `list_cited_sources`, `search_answers`,
`get_email_brief`, `list_outreach_sends`. All results are JSON text content;
missing data is a structured `isError` payload (`no_capture`, `not_found`,
`not_configured`, `forbidden`) — never fabricated zeros.

## Vocabulary mapping (Grok contract → this schema)

Single-tenant: "workspace" = the RecommendedFirst account. "Market" =
`market_launches` (joined to `markets` for the metro). "Team" = `prospects`.
"Capture" = a `runs` row linked via `prospect_benchmarks`. Classification
comes from current-revision `mentions`; citations from `response_citations`;
sends from `prospect_outreach_sends`. Full inventory: `docs/mcp-inventory.md`.

## Non-goals (phase 1)

- No write tools (`run_capture`, `send_email`, market-lock changes are
  explicitly excluded; any future write tool requires `mcp:write`).
- No OAuth flow — metadata stub only.
- No Grok-side email sending.

## Acceptance criteria

1. `docs/mcp-inventory.md` exists; every tool maps to a real service/query.
2. `/mcp` initialize + `tools/list` + `whoami` work with a Bearer token;
   401 without one; 401 for revoked; 429 past the rate window.
3. `get_visibility_snapshot` and `get_email_brief` return fixture-backed data;
   a team without a capture yields `no_capture` / `allowed_to_claim_measurement: false`
   and a first line that claims no measurement (passes `findProhibitedPhrase`).
4. `search_answers` caps at 20 items and paginates via `next_cursor`.
5. `npm run mcp:smoke` passes against a dev server.
6. `docs/grok-connector.md` documents token creation, grok.com/connectors
   setup, Grok Bot attachment, and the xAI API `tools` block.
