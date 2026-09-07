/**
 * Liveness for the remote MCP surface (spec 126). Deliberately DB-free —
 * connector setup wizards poll it; the deep health check stays at
 * /api/health.
 */
import { REMOTE_MCP_SERVER_VERSION } from "@/lib/mcp/remote-tools";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, version: REMOTE_MCP_SERVER_VERSION });
}
