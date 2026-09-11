# MCP inventory — what the remote connector wraps (spec 126, phase 0)

Audit of the existing app surface the Grok remote MCP server exposes.
Rule: tools delegate to existing services/queries; no parallel schema.

## Existing MCP infrastructure (spec 033)

| Piece | Location | Reused? |
|---|---|---|
| stdio entry (`npm run mcp`) | `mcp/server.ts` | No — internal operator use only |
| Tool registry (19 tools, project-level) | `lib/mcp/tools.ts` | No — project-centric, staff-only actor; Grok needs the prospect/market shape |
| Args hashing | `lib/mcp/hash.ts` | Pattern reference |
| Mutation ledger | `mcp_invocations` (migration 039) | Pattern reference for `mcp_tool_calls` |
| SDK | `@modelcontextprotocol/sdk` 1.30.0 — ships `WebStandardStreamableHTTPServerTransport` (fetch Request/Response) | Yes — the `/mcp` route transport |

## Domain object mapping

Single-tenant app: there is no `workspaces` table. "Workspace" = the whole
account; tokens bind to a `users` row (staff). Tools therefore never cross a
workspace boundary because only one exists — enforced anyway by scoping every
query to ids reachable from the requested prospect/launch.

| Grok concept | Real object | Key columns / notes |
|---|---|---|
| Workspace | (whole account) | `users` (roles in migration 025) |
| Market | `market_launches` + `markets` | status incl. `protected`/`partner_selected` (= locked); exclusivity detail in `exclusivity_agreements`/`_scopes` (032) |
| Team / engagement | `prospects` (038) | `stage` (17 values), `company_id` → `companies`, `launch_id` |
| Capture / run | `runs` + `responses` (003), linked by `prospect_benchmarks` (038) | providers jsonb, per-response `repetition`; valid = `error is null` |
| Answer classification | `mentions` (004), current revision only | `mentioned`, `recommended`, `excerpt`; CURRENT idiom exported from `lib/prospects/benchmark.ts:24` |
| Citations | `response_citations` (033) | url, domain per response |
| Outreach sends | `prospect_outreach_sends` (049) + `outreach_drafts` (038) | insert-only evidence ledger |

## Services / queries each tool uses

| Tool | Source of truth |
|---|---|
| `whoami` | token row + bound `users` row |
| `list_markets` | `market_launches` ⋈ `markets`; engaged team = contracted prospect; last capture via `prospect_benchmarks` ⋈ `runs` (new read in `lib/mcp/remote-data.ts`) |
| `list_teams` | `prospects` ⋈ `market_launches` (new read; `lib/prospects/service.listProspects` lacks website/last-capture) |
| `get_visibility_snapshot` | `lib/prospects/benchmark.runSummary` + new aggregate over current-revision `mentions` and `response_citations` |
| `list_cited_sources` | `response_citations` grouped by domain (new read) |
| `search_answers` | `responses` ⋈ current `mentions` (new read; no generic answer-search service existed) |
| `get_email_brief` | snapshot inputs + pure `lib/mcp/email-brief.ts`; copy gated by `findProhibitedPhrase` (`lib/prospects/constants.ts`) |
| `list_outreach_sends` | `prospect_outreach_sends` (exists — tool is configured, no CSV fallback needed) |

## Gaps found in phase 0 (and how they were closed)

1. **No HTTP transport / multi-token auth existed.** Spec 033 was explicitly
   stdio + one env-resolved staff actor. Added: `mcp_tokens` (migration 098),
   `lib/mcp/remote-auth.ts`, `/mcp` route.
2. **No programmatic prospect-level visibility snapshot.** The pieces existed
   (`runSummary`, `providerRecommendationCounts`, mentions/citations tables)
   but no single read. Added `lib/mcp/remote-data.ts` — read-only postgres.js
   queries reusing the exported `CURRENT` revision idiom; no business logic
   duplicated, nothing recomputed that `scores` already stores.
3. **No answer search.** Added cursor-paginated read over `responses` ⋈
   `mentions`, capped at 20 rows, 500-char excerpts.
4. **No general rate limiter in the codebase.** Implemented as a count over
   the `mcp_tool_calls` ledger's last 60 s — multi-instance safe without
   introducing Redis.
5. **Middleware** (`middleware.ts` PUBLIC_PREFIXES) had to learn `/mcp`,
   `/healthz`, `/.well-known` — the same trap that once ate `/api/open`.
