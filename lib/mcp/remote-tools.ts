/**
 * Remote MCP tool registry (spec 126) — the eight read-only tools Grok
 * sees. Deliberately small: every schema costs Grok context. Handlers
 * delegate to lib/mcp/remote-data.ts; this file owns only the contract,
 * scope enforcement, and the audit ledger write.
 *
 * Results are JSON text content (no markdown). Missing data is a
 * structured isError payload with a machine code — never invented counts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MCP_SCOPE_READ,
  recordToolCall,
  type RemoteMcpAuth,
} from "@/lib/mcp/remote-auth";
import * as data from "@/lib/mcp/remote-data";

export const REMOTE_MCP_SERVER_NAME = "recommendedfirst";
export const REMOTE_MCP_SERVER_VERSION = "1.0.0";
/** Single-tenant: the "workspace" is the RecommendedFirst account. */
const WORKSPACE_ID = "recommendedfirst";
const WORKSPACE_NAME = "RecommendedFirst";

const uuid = z.string().uuid();

export interface RemoteToolDef {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  handler: (auth: RemoteMcpAuth, input: never) => Promise<unknown>;
}

export const REMOTE_TOOLS: RemoteToolDef[] = [
  {
    name: "whoami",
    description:
      "Confirm authentication and identify the workspace, token scopes, and server version. Call this first; if it fails, no other tool will work.",
    schema: z.object({}).strict(),
    handler: async (auth) => ({
      workspace_id: WORKSPACE_ID,
      workspace_name: WORKSPACE_NAME,
      user_email: auth.user.email,
      scopes: auth.scopes,
      server_version: REMOTE_MCP_SERVER_VERSION,
    }),
  },
  {
    name: "list_markets",
    description:
      "List the markets (city launches) RecommendedFirst operates in, with exclusivity status. Use before pitching: exclusive_status 'locked' means an engaged team already holds the market — do not pitch there. Not for listing teams (use list_teams).",
    schema: z
      .object({ include_locked: z.boolean().default(true) })
      .strict(),
    handler: async (_auth, input: { include_locked: boolean }) => ({
      markets: await data.listMarkets(input.include_locked),
      as_of: new Date().toISOString(),
    }),
  },
  {
    name: "list_teams",
    description:
      "List real-estate teams (prospects and engagements), optionally filtered by market, status, or a name query. Returns compact rows only — for measurement numbers call get_visibility_snapshot on one team_id.",
    schema: z
      .object({
        market_id: uuid.optional(),
        status: z.enum(["prospect", "engaged", "closed", "all"]).default("all"),
        query: z.string().min(1).max(120).optional(),
        // Over-asks are clamped in the data layer (max 50), not rejected.
        limit: z.number().int().min(1).default(data.TEAMS_LIMIT_DEFAULT),
      })
      .strict(),
    handler: async (
      _auth,
      input: { market_id?: string; status: data.TeamStatus | "all"; query?: string; limit: number }
    ) => ({
      teams: await data.listTeams({
        marketId: input.market_id,
        status: input.status,
        query: input.query,
        limit: input.limit,
      }),
      as_of: new Date().toISOString(),
    }),
  },
  {
    name: "get_visibility_snapshot",
    description:
      "One team's measured AI-visibility snapshot from a capture (benchmark run): counted answers, mention/recommendation counts and shares, top recommended competitors, top cited source domains. Defaults to the latest capture. Every number is counted from preserved raw answers — if the team has no capture this returns error no_capture; never treat that as zero.",
    schema: z
      .object({ team_id: uuid, capture_id: uuid.optional() })
      .strict(),
    handler: (_auth, input: { team_id: string; capture_id?: string }) =>
      data.getVisibilitySnapshot(input.team_id, input.capture_id),
  },
  {
    name: "list_cited_sources",
    description:
      "Domains the AI answers in a team's capture cited, tallied with example URLs. Use to explain WHERE models source their recommendations. Not for answer text (use search_answers).",
    schema: z
      .object({
        team_id: uuid,
        capture_id: uuid.optional(),
        limit: z.number().int().min(1).default(data.SOURCES_LIMIT_DEFAULT),
      })
      .strict(),
    handler: (_auth, input: { team_id: string; capture_id?: string; limit: number }) =>
      data.listCitedSources(input.team_id, input.capture_id, input.limit),
  },
  {
    name: "search_answers",
    description:
      "Page through individual captured AI answers for a team's capture, filtered by how the team was classified (recommended / named / absent) or by a named competitor appearing. Returns 500-char excerpts, max 20 per page (use next_cursor) — never a full transcript dump.",
    schema: z
      .object({
        team_id: uuid,
        capture_id: uuid.optional(),
        filter: z.enum(["team_recommended", "team_named", "team_absent", "competitor_named", "all"]),
        competitor_name: z.string().min(1).max(120).optional(),
        limit: z.number().int().min(1).default(data.ANSWERS_LIMIT_DEFAULT),
        cursor: z.string().uuid().optional(),
      })
      .strict(),
    handler: (
      _auth,
      input: {
        team_id: string;
        capture_id?: string;
        filter: data.AnswerFilter;
        competitor_name?: string;
        limit: number;
        cursor?: string;
      }
    ) =>
      data.searchAnswers({
        teamId: input.team_id,
        captureId: input.capture_id,
        filter: input.filter,
        competitorName: input.competitor_name,
        limit: input.limit,
        cursor: input.cursor,
      }),
  },
  {
    name: "get_email_brief",
    description:
      "The ONLY payload an email-drafting agent may trust for outreach claims about a team. If allowed_to_claim_measurement is false, no measurement claim of any kind may be made — use allowed_first_line verbatim or write copy that asserts nothing about the team's AI visibility. Never state numbers that are not in this brief.",
    schema: z.object({ team_id: uuid }).strict(),
    handler: (_auth, input: { team_id: string }) => data.getEmailBrief(input.team_id),
  },
  {
    name: "list_outreach_sends",
    description:
      "Send-level outreach history (email sends recorded in the evidence ledger), newest first, optionally since an ISO date or scoped to a market. Use to avoid re-pitching a recently contacted team. Not a CRM — read-only evidence rows.",
    schema: z
      .object({
        since: z.string().datetime().optional(),
        market_id: uuid.optional(),
        limit: z.number().int().min(1).default(data.SENDS_LIMIT_DEFAULT),
      })
      .strict(),
    handler: (_auth, input: { since?: string; market_id?: string; limit: number }) =>
      data.listOutreachSends({
        since: input.since,
        marketId: input.market_id,
        limit: input.limit,
      }),
  },
];

/** Audit only entity ids, never payloads. */
function argumentIds(input: Record<string, unknown>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.endsWith("_id") && typeof value === "string") ids[key] = value;
  }
  return ids;
}

const isDataError = (v: unknown): v is data.RemoteDataError =>
  typeof v === "object" && v !== null && "error" in v;

export async function invokeRemoteTool(
  auth: RemoteMcpAuth,
  tool: RemoteToolDef,
  rawInput: unknown
): Promise<{ isError: boolean; payload: unknown }> {
  if (!auth.scopes.includes(MCP_SCOPE_READ)) {
    return { isError: true, payload: { error: "forbidden", detail: `${MCP_SCOPE_READ} scope required` } };
  }
  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      payload: { error: "invalid_arguments", detail: parsed.error.issues[0]?.message ?? "invalid input" },
    };
  }
  const started = Date.now();
  let errorCode: string | null = null;
  try {
    const result = await tool.handler(auth, parsed.data as never);
    if (isDataError(result)) {
      errorCode = result.error;
      return { isError: true, payload: result };
    }
    return { isError: false, payload: result };
  } catch (err) {
    // Internal detail stays server-side; the ledger keeps the message.
    errorCode = err instanceof Error ? `internal: ${err.message}`.slice(0, 500) : "internal";
    return { isError: true, payload: { error: "internal" } };
  } finally {
    try {
      await recordToolCall({
        tokenId: auth.tokenId,
        toolName: tool.name,
        argumentIds: argumentIds((parsed.success ? parsed.data : {}) as Record<string, unknown>),
        durationMs: Date.now() - started,
        error: errorCode,
      });
    } catch {
      // The audit write must never mask the tool result.
    }
  }
}

/** A per-request server: stateless transport, nothing kept in RAM. */
export function buildRemoteMcpServer(auth: RemoteMcpAuth): McpServer {
  const server = new McpServer({
    name: REMOTE_MCP_SERVER_NAME,
    version: REMOTE_MCP_SERVER_VERSION,
  });
  for (const tool of REMOTE_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema.shape },
      async (args: Record<string, unknown>) => {
        const { isError, payload } = await invokeRemoteTool(auth, tool, args);
        return {
          ...(isError ? { isError: true } : {}),
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      }
    );
  }
  return server;
}
