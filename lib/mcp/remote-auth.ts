/**
 * Bearer-token auth for the remote MCP endpoint (spec 126).
 *
 * Tokens: `rf_live_`/`rf_test_` + 32 random bytes base64url. Lookup is by
 * sha256(token) against the unique `mcp_tokens.token_hash` index — the hash
 * comparison happens inside Postgres on a 256-bit-entropy input, so no
 * pepper and no constant-time dance is needed (unlike CRON_SECRET, which is
 * operator-chosen and compared in process).
 *
 * Rate limiting counts rows in the insert-only `mcp_tool_calls` ledger for
 * the trailing 60s, so the cap holds across web instances without Redis.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { isStaff } from "@/lib/auth";

export const MCP_SCOPE_READ = "mcp:read";
export const MCP_TOOL_CALLS_PER_MINUTE = 60;
const TOKEN_BYTES = 32;
export const TOKEN_PREFIXES = ["rf_live_", "rf_test_"] as const;
export type TokenPrefix = (typeof TOKEN_PREFIXES)[number];

export interface RemoteMcpAuth {
  tokenId: string;
  tokenName: string;
  scopes: string[];
  user: CurrentUser;
}

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface MintedToken {
  id: string;
  /** The full secret — shown once, never stored. */
  secret: string;
}

export async function mintToken(input: {
  userId: string;
  name: string;
  prefix: TokenPrefix;
  createdBy: string;
  scopes?: string[];
}): Promise<MintedToken> {
  const secret = `${input.prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const scopes = input.scopes ?? [MCP_SCOPE_READ];
  const [row] = await sql`
    insert into mcp_tokens (user_id, name, token_hash, prefix, scopes, created_by)
    values (${input.userId}, ${input.name}, ${hashToken(secret)},
      ${input.prefix}, ${sql.array(scopes)}, ${input.createdBy})
    returning id
  `;
  return { id: row?.id as string, secret };
}

export async function revokeToken(tokenId: string): Promise<boolean> {
  const rows = await sql`
    update mcp_tokens set revoked_at = now()
    where id = ${tokenId} and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}

function unauthorized(detail: string): Response {
  return new Response(JSON.stringify({ error: "unauthorized", detail }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"',
    },
  });
}

export type RemoteAuthResult =
  | { ok: true; auth: RemoteMcpAuth }
  | { ok: false; response: Response };

export async function authenticateRemoteToken(
  request: Request
): Promise<RemoteAuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) {
    return { ok: false, response: unauthorized("missing bearer token") };
  }
  const secret = match[1];
  if (!TOKEN_PREFIXES.some((p) => secret.startsWith(p))) {
    return { ok: false, response: unauthorized("unrecognized token") };
  }
  const [row] = await sql`
    select t.id, t.name as token_name, t.scopes, t.revoked_at,
      u.id as user_id, u.email, u.name, u.role, u.active
    from mcp_tokens t
    join users u on u.id = t.user_id
    where t.token_hash = ${hashToken(secret)}
  `;
  if (!row) return { ok: false, response: unauthorized("unknown token") };
  if (row.revokedAt) return { ok: false, response: unauthorized("token revoked") };
  const user: CurrentUser = {
    id: row.userId as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as CurrentUser["role"],
  };
  if (!row.active || !isStaff(user)) {
    return { ok: false, response: unauthorized("token owner is not active staff") };
  }
  // Fire-and-forget freshness marker; a failed update must not fail the call.
  void sql`update mcp_tokens set last_used_at = now() where id = ${row.id}`.catch(
    () => undefined
  );
  return {
    ok: true,
    auth: {
      tokenId: row.id as string,
      tokenName: row.tokenName as string,
      scopes: (row.scopes as string[]) ?? [],
      user,
    },
  };
}

/** True when the token is at/over its 60s tool-call budget. */
export async function rateLimited(tokenId: string): Promise<boolean> {
  const [row] = await sql`
    select count(*)::int as calls from mcp_tool_calls
    where token_id = ${tokenId} and created_at > now() - interval '60 seconds'
  `;
  return Number(row?.calls ?? 0) >= MCP_TOOL_CALLS_PER_MINUTE;
}

export async function recordToolCall(entry: {
  tokenId: string;
  toolName: string;
  argumentIds: Record<string, string>;
  durationMs: number;
  error: string | null;
}): Promise<void> {
  await sql`
    insert into mcp_tool_calls (token_id, tool_name, argument_ids, duration_ms, error)
    values (${entry.tokenId}, ${entry.toolName},
      ${sql.json(entry.argumentIds)}, ${entry.durationMs}, ${entry.error})
  `;
}
