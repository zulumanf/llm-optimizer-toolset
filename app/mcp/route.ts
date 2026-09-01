/**
 * Remote MCP endpoint (spec 126) — Streamable HTTP at /mcp for Grok
 * connectors and the xAI API's remote MCP tools.
 *
 * Third documented exception to "route handlers only for webhooks/cron"
 * (DECISIONS 2026-09-01): like a webhook, this is a machine protocol
 * endpoint — no session, no page, JSON-RPC over POST.
 *
 * Fully stateless: every request builds a fresh McpServer + transport
 * (`sessionIdGenerator: undefined`), so nothing breaks on multi-instance
 * deploys and Grok may open a new HTTP exchange per conversation. Auth is
 * a Bearer personal-access token (lib/mcp/remote-auth.ts); the rate limit
 * (60 tool calls/min/token) is enforced here with a 429 before the
 * transport ever sees the message.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateRemoteToken, rateLimited } from "@/lib/mcp/remote-auth";
import { buildRemoteMcpServer } from "@/lib/mcp/remote-tools";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 262_144;

function countToolCalls(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter(
    (m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "tools/call"
  ).length;
}

async function handle(request: Request): Promise<Response> {
  const auth = await authenticateRemoteToken(request);
  if (!auth.ok) return auth.response;

  let parsedBody: unknown;
  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
        { status: 400 }
      );
    }
    if (countToolCalls(parsedBody) > 0 && (await rateLimited(auth.auth.tokenId))) {
      return Response.json(
        { error: "rate_limited", detail: "60 tool calls per minute per token" },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }
  }

  const server = buildRemoteMcpServer(auth.auth);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request, { parsedBody });
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

// GET (SSE resume) and DELETE (session close) are answered by the transport
// itself — 405 in stateless mode, which the MCP spec permits.
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
