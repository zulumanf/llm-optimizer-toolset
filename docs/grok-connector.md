# Grok connector — remote MCP for RecommendedFirst data (spec 126)

## 1. What this is

A remote **Model Context Protocol** server built into the app: Grok (and any
MCP client) calls our measured visibility data over HTTPS instead of logging
into or scraping the web UI. It is **read-only** — eight tools, no sending,
no market-lock changes.

- Transport: **Streamable HTTP** at `POST /mcp` (stateless; JSON responses).
- Auth: `Authorization: Bearer <personal access token>` (`rf_live_…`).
- Liveness: `GET /healthz` → `{ ok: true, version }` (no auth).
- OAuth discovery stub: `GET /.well-known/oauth-protected-resource`
  (bearer-only for now).

## 2. Production URL

```
https://app.recommendedfirst.com/mcp
```

(The MCP server is part of the main app deployment — no separate service.)

## 3. Create a token

On a machine with production `DATABASE_URL` (or via a Railway shell):

```bash
npm run mcp:token:create -- --name "grok-bot"
```

The secret (`rf_live_…`, ~43 chars after the prefix) is printed **once** —
store it in a password manager immediately. Also available:

```bash
npx tsx scripts/mcp-token.ts list
npx tsx scripts/mcp-token.ts revoke --id <token-id>
```

Tokens carry scope `mcp:read`, are sha256-hashed at rest, and are limited to
**60 tool calls per minute** (429 past that).

## 4. Connect Grok (grok.com Connectors)

1. Open **grok.com/connectors** → **New** → **Custom**.
2. Server URL: `https://app.recommendedfirst.com/mcp`
3. Authentication: **Header** → `Authorization` → `Bearer rf_live_…`
   (paste the full token after the word `Bearer` and a space).
4. Save. Grok fetches `tools/list`; you should see the eight tools.

## 5. Attach to Grok Bot

Grok Bot → **Settings → Plugins** → enable the RecommendedFirst connector.
In the **Outreach Analyst** and **Email Drafter** chats, attach it with `@`
(type `@` and pick the connector) so those bots can call the tools.

## 6. Example prompts

Outreach Analyst:

> Using the recommendedfirst connector: list markets, skip anything locked,
> then for the Charleston teams with a capture, pull get_visibility_snapshot
> and rank the three biggest mismatches between production and
> recommended_count. Show cited domains for the top one.

Email Drafter:

> Call get_email_brief for team <team_id>. If allowed_to_claim_measurement is
> false, do not mention any measurement — use the allowed_first_line as the
> opener. Never use numbers that are not in the brief, and respect do_not_say.

## 7. Security notes

- Grok connectors are **account-wide**: anyone using this Grok account can
  invoke the tools. The token is read-only by design — treat the data as
  shareable with whoever shares the Grok account.
- Rotate by minting a new token and revoking the old (`revoke --id …`).
  Revocation is immediate (401 on the next call).
- Do **not** put send credentials, Gmail tokens, or market-lock powers on
  this surface. Write tools require a future `mcp:write` scope and a new
  spec — the server rejects anything else today.
- Every tool call is audited (`mcp_tool_calls`): token, tool, entity ids,
  duration. No answer text and no tokens are logged.

## 8. xAI API (Remote MCP Tools)

The same URL works from the API:

```json
{
  "tools": [
    {
      "type": "mcp",
      "server_url": "https://app.recommendedfirst.com/mcp",
      "server_label": "recommendedfirst",
      "authorization": "Bearer rf_live_…"
    }
  ]
}
```

## Local development

```bash
npm run mcp:dev                      # Next dev server on :8787
npm run mcp:token:create -- --name dev --test   # rf_test_ token
cloudflared tunnel --url http://localhost:8787
# then add https://<tunnel-host>/mcp at grok.com/connectors (Custom),
# header Authorization: Bearer rf_test_…
npm run mcp:smoke                    # protocol smoke against :8787
```

Verify by hand:

```bash
curl -s https://app.recommendedfirst.com/mcp \
  -H "Authorization: Bearer rf_live_…" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tool reference (read-only)

| Tool | Purpose |
|---|---|
| `whoami` | Confirm auth; workspace, scopes, server version |
| `list_markets` | Markets + exclusivity (`locked` = do not pitch) |
| `list_teams` | Compact team rows by market/status/query |
| `get_visibility_snapshot` | Counted mention/recommendation shares, top competitors, top cited domains for one capture |
| `list_cited_sources` | Domain tallies + example URLs for a capture |
| `search_answers` | Paged answer excerpts filtered by classification (max 20/page) |
| `get_email_brief` | The only claims payload Email Drafter may trust |
| `list_outreach_sends` | Send-level outreach evidence ledger |

Missing data returns a machine error (`no_capture`, `not_found`,
`not_configured`) — never a zero pretending to be a measurement.
