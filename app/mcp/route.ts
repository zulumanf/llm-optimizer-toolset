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
import { authenticateRemoteToken, rateLimited, recordToolCall } from "@/lib/mcp/remote-auth";
import { buildRemoteMcpServer } from "@/lib/mcp/remote-tools";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 262_144;

interface RpcMessage {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown };
}

function rpcMessages(body: unknown): RpcMessage[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter((m): m is RpcMessage => typeof m === "object" && m !== null);
}

function toolCallMessages(body: unknown): RpcMessage[] {
  return rpcMessages(body).filter((m) => m.method === "tools/call");
}

/**
 * Ledger tools/call messages the SDK rejected before our handler ran
 * (schema-invalid arguments, unknown tool). invokeRemoteTool audits its own
 * outcomes, but the SDK validates `inputSchema` first and throws — those
 * rejections must still be metered or they are free to spam. Detection: our
 * handler's error payloads are always JSON text; the SDK's are plain
 * "MCP error …" strings, so an error result whose text is not JSON came
 * from the SDK layer.
 */
async function auditTransportRejections(
  tokenId: string,
  requestBody: unknown,
  response: Response
): Promise<void> {
  try {
    const calls = toolCallMessages(requestBody);
    if (calls.length === 0) return;
    if (!response.headers.get("content-type")?.includes("application/json")) return;
    const body: unknown = await response.clone().json();
    const byId = new Map(
      calls.map((m) => [String(m.id), typeof m.params?.name === "string" ? m.params.name : "unknown"])
    );
    for (const msg of rpcMessages(body)) {
      const toolName = byId.get(String(msg.id));
      if (!toolName) continue;
      const result = (msg as { result?: { isError?: boolean; content?: { text?: string }[] } }).result;
      const text = result?.content?.[0]?.text;
      if (!result?.isError || typeof text !== "string") continue;
      try {
        JSON.parse(text); // our handler's payload — already ledgered
      } catch {
        await recordToolCall({
          tokenId,
          toolName,
          argumentIds: {},
          durationMs: 0,
          error: "invalid_arguments",
        });
      }
    }
  } catch {
    // Best-effort metering must never break the protocol response.
  }
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
    // Every tools/call in the body counts — a JSON-RPC batch must not slip
    // N calls past a single per-request check.
    const pendingToolCalls = toolCallMessages(parsedBody).length;
    if (pendingToolCalls > 0 && (await rateLimited(auth.auth.tokenId, pendingToolCalls))) {
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
  const response = await transport.handleRequest(request, { parsedBody });
  await auditTransportRejections(auth.auth.tokenId, parsedBody, response);
  return response;
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

// This server is stateless and offers no standalone SSE channel or session
// to close, so GET and DELETE are refused outright (the MCP spec permits
// 405 for both). Delegating them to the transport instead was a trap: a GET
// with `Accept: text/event-stream` opened a silent SSE stream that never
// emitted and never closed — one pinned connection per request, unmetered
// because the rate limit only counts tools/call.
function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed", detail: "POST JSON-RPC only; no SSE channel or sessions are offered" },
    { status: 405, headers: { Allow: "POST" } }
  );
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
