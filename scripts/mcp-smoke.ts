/**
 * Smoke test for the remote MCP endpoint (spec 126) — `npm run mcp:smoke`.
 *
 * Drives a RUNNING server (default http://localhost:8787, i.e. `npm run
 * mcp:dev`) through the real HTTP surface: initialize → tools/list →
 * whoami → snapshot → email brief. Uses MCP_SMOKE_TOKEN when provided;
 * otherwise mints a throwaway rf_test_ token against DATABASE_URL and
 * revokes it on exit. Deterministic data assertions live in
 * tests/integration/mcp-remote.test.ts — this script asserts the protocol
 * and stays lenient about which teams exist in the target DB.
 */
// Must be the first import — later imports read env at module load.
import "dotenv/config";

const BASE = process.env.MCP_SMOKE_URL ?? "http://localhost:8787";
const MCP_URL = `${BASE.replace(/\/$/, "")}/mcp`;

const EXPECTED_TOOLS = [
  "whoami",
  "list_markets",
  "list_teams",
  "get_visibility_snapshot",
  "list_cited_sources",
  "search_answers",
  "get_email_brief",
  "list_outreach_sends",
];

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

interface RpcResult {
  status: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

async function rpc(token: string, method: string, params?: unknown, id = 1): Promise<RpcResult> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
  });
  const text = await res.text();
  // enableJsonResponse gives plain JSON; parse SSE frames defensively anyway.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? (text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "{}")
    : text;
  try {
    const body = JSON.parse(payload) as { result?: Record<string, unknown>; error?: unknown };
    return { status: res.status, result: body.result, error: body.error };
  } catch {
    return { status: res.status, error: text.slice(0, 300) };
  }
}

function toolJson(result: Record<string, unknown> | undefined): Record<string, unknown> {
  const content = (result?.content as { text?: string }[] | undefined) ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

async function main(): Promise<void> {
  let token = process.env.MCP_SMOKE_TOKEN;
  let mintedId: string | null = null;
  let cleanup: (() => Promise<void>) | null = null;

  if (!token) {
    const { sql } = await import("@/db/client");
    const { mintToken, revokeToken } = await import("@/lib/mcp/remote-auth");
    const [user] = await sql`
      select id from users where role = 'admin' and active order by created_at limit 1
    `;
    if (!user) throw new Error("no active admin user to bind a smoke token to");
    const minted = await mintToken({
      userId: user.id as string,
      name: "mcp-smoke (throwaway)",
      prefix: "rf_test_",
      createdBy: user.id as string,
    });
    token = minted.secret;
    mintedId = minted.id;
    cleanup = async () => {
      if (mintedId) await revokeToken(mintedId);
      await sql.end();
    };
    console.log(`minted throwaway token ${minted.id}`);
  }

  try {
    const health = await fetch(`${BASE.replace(/\/$/, "")}/healthz`);
    check("GET /healthz", health.ok);

    const unauthed = await fetch(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    check("no token → 401", unauthed.status === 401);

    const init = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-smoke", version: "0.0.1" },
    });
    check("initialize", init.status === 200 && !!init.result, JSON.stringify(init.error));

    const list = await rpc(token, "tools/list", {}, 2);
    const names = ((list.result?.tools as { name: string }[] | undefined) ?? []).map((t) => t.name);
    for (const name of EXPECTED_TOOLS) {
      check(`tools/list has ${name}`, names.includes(name), `got: ${names.join(", ")}`);
    }

    const who = await rpc(token, "tools/call", { name: "whoami", arguments: {} }, 3);
    const whoData = toolJson(who.result);
    check("whoami", whoData.workspace_id === "recommendedfirst", JSON.stringify(whoData));

    const teamsCall = await rpc(token, "tools/call", { name: "list_teams", arguments: { limit: 50 } }, 4);
    const teams = (toolJson(teamsCall.result).teams as { team_id: string; last_capture_at: string | null }[] | undefined) ?? [];
    check("list_teams", Array.isArray(teams));

    const withCapture = teams.find((t) => t.last_capture_at);
    if (withCapture) {
      const snap = await rpc(token, "tools/call", { name: "get_visibility_snapshot", arguments: { team_id: withCapture.team_id } }, 5);
      const snapData = toolJson(snap.result);
      check(
        "get_visibility_snapshot",
        typeof snapData.valid_answers === "number" && !snap.result?.isError,
        JSON.stringify(snapData).slice(0, 200)
      );
    } else {
      console.log("SKIP  get_visibility_snapshot — no team with a capture in this DB");
    }

    const withoutCapture = teams.find((t) => !t.last_capture_at);
    if (withoutCapture) {
      const brief = await rpc(token, "tools/call", { name: "get_email_brief", arguments: { team_id: withoutCapture.team_id } }, 6);
      const briefData = toolJson(brief.result);
      check(
        "email brief without capture refuses measurement claims",
        briefData.allowed_to_claim_measurement === false,
        JSON.stringify(briefData).slice(0, 200)
      );
    } else {
      console.log("SKIP  no-capture email brief — every team in this DB has a capture");
    }
  } finally {
    if (cleanup) await cleanup();
  }

  console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
