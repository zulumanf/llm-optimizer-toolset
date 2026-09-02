/**
 * Integration tests for the remote MCP endpoint (spec 126): the /mcp route
 * handler end to end against a real database — bearer auth (missing, bad,
 * revoked, wrong scope), tool discovery, fixture-backed snapshot and email
 * brief, answer pagination + cap, and the ledger-window rate limit.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import {
  seedProspect,
  type PipelineModules,
  type ProspectFixture,
} from "../helpers/prospect-fixtures";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000201",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000101",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

interface RpcBody {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

describe.skipIf(!TEST_URL)("remote mcp endpoint (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let auth: typeof import("@/lib/mcp/remote-auth");
  let route: typeof import("@/app/mcp/route");
  let m: PipelineModules;
  let fixture: ProspectFixture;
  let noCaptureProspectId: string;
  let secret: string;
  let tokenId: string;

  async function call(body: RpcBody, bearer?: string): Promise<Response> {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return route.POST(request);
  }

  let nextId = 1;
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    bearer = secret
  ): Promise<{ status: number; isError: boolean; data: Record<string, unknown> }> {
    const res = await call(
      { jsonrpc: "2.0", id: (nextId += 1), method: "tools/call", params: { name, arguments: args } },
      bearer
    );
    if (res.status !== 200) {
      return { status: res.status, isError: true, data: {} };
    }
    const body = (await res.json()) as {
      result?: { isError?: boolean; content: { text: string }[] };
    };
    // SDK-level rejections (schema validation) carry plain-text errors,
    // not the JSON payloads our handler emits.
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(body.result?.content[0]?.text ?? "{}") as Record<string, unknown>;
    } catch {
      data = { raw_text: body.result?.content[0]?.text };
    }
    return {
      status: res.status,
      isError: Boolean(body.result?.isError),
      data,
    };
  }

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    auth = await import("@/lib/mcp/remote-auth");
    route = await import("@/app/mcp/route");
    m = {
      sql,
      projectSvc: await import("@/lib/projects/service"),
      setSvc: await import("@/lib/prompts/set-service"),
      promptSvc: await import("@/lib/prompts/prompt-service"),
      runSvc: await import("@/lib/runs/service"),
      execute: await import("@/lib/runs/execute"),
      jobs: await import("@/db/jobs"),
      companySvc: await import("@/lib/companies/service"),
      claims: await import("@/lib/claims/service"),
      parsing: await import("@/lib/parsing/service"),
      scoring: await import("@/lib/scoring/compute"),
      exclusivity: await import("@/lib/exclusivity/service"),
      svc: await import("@/lib/prospects/service"),
    };
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    // seedTestActors gives every fixture an admin role and a generated
    // email; pin the operator's email so whoami has something to assert.
    await sql`update users set email = ${operator.email} where id = ${operator.id}`;

    fixture = await seedProspect(m, operator, admin);
    const linked = await m.svc.linkBenchmark(operator, {
      prospectId: fixture.prospectId,
      runId: fixture.runId,
    });
    if (!linked.ok) throw new Error(linked.error.message);
    const bare = await m.svc.createProspect(operator, {
      launchId: fixture.launchId,
      businessName: "No Capture Team",
      prospectType: "team",
    });
    if (!bare.ok) throw new Error(bare.error.message);
    noCaptureProspectId = bare.data.prospectId;

    const minted = await auth.mintToken({
      userId: operator.id,
      name: "test",
      prefix: "rf_test_",
      createdBy: operator.id,
    });
    secret = minted.secret;
    tokenId = minted.id;
  }, 120_000);

  afterAll(async () => {
    await sql.end();
  });

  it("rejects a missing token with 401 + WWW-Authenticate", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects an unknown token", async () => {
    const res = await call(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "rf_test_definitely-not-a-real-token-aaaaaaaaaaaa"
    );
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const minted = await auth.mintToken({
      userId: operator.id,
      name: "revoked",
      prefix: "rf_test_",
      createdBy: operator.id,
    });
    await auth.revokeToken(minted.id);
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, minted.secret);
    expect(res.status).toBe(401);
  });

  it("initializes and lists exactly the eight tools", async () => {
    const init = await call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      },
      secret
    );
    expect(init.status).toBe(200);
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, secret);
    const body = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(
      [
        "get_email_brief",
        "get_visibility_snapshot",
        "list_cited_sources",
        "list_markets",
        "list_outreach_sends",
        "list_teams",
        "search_answers",
        "whoami",
      ].sort()
    );
  });

  it("whoami confirms the token binding", async () => {
    const { isError, data } = await callTool("whoami", {});
    expect(isError).toBe(false);
    expect(data.workspace_id).toBe("recommendedfirst");
    expect(data.user_email).toBe(operator.email);
    expect(data.scopes).toEqual(["mcp:read"]);
  });

  it("refuses a token without mcp:read", async () => {
    const minted = await auth.mintToken({
      userId: operator.id,
      name: "wrong-scope",
      prefix: "rf_test_",
      createdBy: operator.id,
      scopes: ["mcp:write"],
    });
    const { isError, data } = await callTool("whoami", {}, minted.secret);
    expect(isError).toBe(true);
    expect(data.error).toBe("forbidden");
  });

  it("lists the fixture market with capture recency", async () => {
    const { isError, data } = await callTool("list_markets", {});
    expect(isError).toBe(false);
    const markets = data.markets as Record<string, unknown>[];
    const market = markets.find((row) => row.market_id === fixture.launchId);
    expect(market?.metro).toBe("Manhattan");
    expect(market?.exclusive_status).toBe("open");
    expect(market?.last_capture_at).toBeTruthy();
  });

  it("lists teams and filters by query", async () => {
    const all = await callTool("list_teams", {});
    expect((all.data.teams as unknown[]).length).toBe(2);
    const filtered = await callTool("list_teams", { query: "Rivera" });
    const teams = filtered.data.teams as Record<string, unknown>[];
    expect(teams).toHaveLength(1);
    expect(teams[0]?.team_id).toBe(fixture.prospectId);
    expect(teams[0]?.last_capture_at).toBeTruthy();
  });

  it("returns a counted visibility snapshot for the fixture capture", async () => {
    const { isError, data } = await callTool("get_visibility_snapshot", {
      team_id: fixture.prospectId,
    });
    expect(isError).toBe(false);
    expect(data.capture_id).toBe(fixture.runId);
    expect(data.valid_answers).toBe(6);
    expect(data.questions_count).toBe(2);
    expect(data.repetitions).toBe(3);
    expect(data.provider_labels).toEqual(["mock"]);
    expect(typeof data.mentioned_count).toBe("number");
    expect(typeof data.recommended_count).toBe("number");
    expect((data.mentioned_count as number) <= 6).toBe(true);
    expect(Array.isArray(data.top_recommended)).toBe(true);
    expect(typeof data.gap_label).toBe("string");
    expect(data.as_of).toBeTruthy();
  });

  it("returns structured no_capture instead of invented zeros", async () => {
    const { isError, data } = await callTool("get_visibility_snapshot", {
      team_id: noCaptureProspectId,
    });
    expect(isError).toBe(true);
    expect(data.error).toBe("no_capture");
    expect(data.team_id).toBe(noCaptureProspectId);
  });

  it("returns not_found for an unknown team", async () => {
    const { isError, data } = await callTool("get_visibility_snapshot", {
      team_id: "00000000-0000-4000-8000-00000000dead",
    });
    expect(isError).toBe(true);
    expect(data.error).toBe("not_found");
  });

  it("keys counts to the benchmark company, not the current prospect link", async () => {
    // prospects.company_id is mutable; the benchmark's frozen key
    // (prospect_benchmarks.company_id) must decide every count. Re-point
    // the prospect at Acme — heavily recommended in the mock capture —
    // and the panel must still report Rivera's (zero) numbers.
    const [acme] = await sql`select id from companies where name = 'Acme'`;
    if (!acme) throw new Error("fixture company Acme missing");
    await sql`update prospects set company_id = ${acme.id} where id = ${fixture.prospectId}`;
    try {
      const snap = await callTool("get_visibility_snapshot", { team_id: fixture.prospectId });
      expect(snap.isError).toBe(false);
      expect(snap.data.mentioned_count).toBe(0);
      expect(snap.data.recommended_count).toBe(0);
      expect(snap.data.gap_label).toBe("absent");

      const brief = await callTool("get_email_brief", { team_id: fixture.prospectId });
      expect(brief.isError).toBe(false);
      // A capture exists, so measurement claims stay allowed — but they are
      // Rivera's counted absence, never Acme's recommendations.
      expect(brief.data.allowed_to_claim_measurement).toBe(true);
      expect(brief.data.recommended_count).toBe(0);
      expect(brief.data.appeared).toBe(false);
      expect(String(brief.data.allowed_first_line)).not.toMatch(/recommended in \d/);
    } finally {
      await sql`update prospects set company_id = ${fixture.prospectCompanyId}
        where id = ${fixture.prospectId}`;
    }
  });

  it("email brief without a capture refuses measurement claims", async () => {
    const { isError, data } = await callTool("get_email_brief", {
      team_id: noCaptureProspectId,
    });
    expect(isError).toBe(false);
    expect(data.allowed_to_claim_measurement).toBe(false);
    expect(data.valid_answers).toBe(0);
    expect(String(data.allowed_first_line)).not.toMatch(/did not appear|missing/i);
  });

  it("email brief with a capture carries counted facts", async () => {
    const { isError, data } = await callTool("get_email_brief", {
      team_id: fixture.prospectId,
    });
    expect(isError).toBe(false);
    expect(data.allowed_to_claim_measurement).toBe(true);
    expect(data.valid_answers).toBe(6);
    expect(Array.isArray(data.competitors_named)).toBe(true);
    expect((data.competitors_named as string[]).length).toBeLessThanOrEqual(3);
  });

  it("search_answers caps pages at 20 and paginates the full capture", async () => {
    const oversized = await callTool("search_answers", {
      team_id: fixture.prospectId,
      filter: "all",
      limit: 50,
    });
    expect(oversized.isError).toBe(false);
    expect((oversized.data.items as unknown[]).length).toBeLessThanOrEqual(20);

    const page1 = await callTool("search_answers", {
      team_id: fixture.prospectId,
      filter: "all",
      limit: 4,
    });
    const items1 = page1.data.items as { answer_id: string; excerpt: string }[];
    expect(items1).toHaveLength(4);
    expect(page1.data.next_cursor).toBeTruthy();
    for (const item of items1) expect(item.excerpt.length).toBeLessThanOrEqual(500);

    const page2 = await callTool("search_answers", {
      team_id: fixture.prospectId,
      filter: "all",
      limit: 4,
      cursor: page1.data.next_cursor as string,
    });
    const items2 = page2.data.items as { answer_id: string }[];
    expect(items2).toHaveLength(2);
    const ids = new Set([...items1, ...items2].map((i) => i.answer_id));
    expect(ids.size).toBe(6);
  });

  it("list_outreach_sends returns the (empty) evidence ledger", async () => {
    const { isError, data } = await callTool("list_outreach_sends", {});
    expect(isError).toBe(false);
    expect(data.sends).toEqual([]);
  });

  it("enforces the 60-calls-per-minute ledger window with 429", async () => {
    const minted = await auth.mintToken({
      userId: operator.id,
      name: "rate-limit",
      prefix: "rf_test_",
      createdBy: operator.id,
    });
    for (let i = 0; i < 60; i += 1) {
      await auth.recordToolCall({
        tokenId: minted.id,
        toolName: "whoami",
        argumentIds: {},
        durationMs: 1,
        error: null,
      });
    }
    const limited = await callTool("whoami", {}, minted.secret);
    expect(limited.status).toBe(429);
    // tools/list is not a tool call and stays available.
    const list = await call({ jsonrpc: "2.0", id: 99, method: "tools/list" }, minted.secret);
    expect(list.status).toBe(200);
  });

  it("refuses GET and DELETE with 405 instead of opening a stream", async () => {
    const get = await route.GET();
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
    // The old delegation trap: GET with an SSE Accept got a 200 stream that
    // never emitted and never closed. A 405 body must be readable instantly.
    const body = (await get.json()) as { error: string };
    expect(body.error).toBe("method_not_allowed");
    const del = await route.DELETE();
    expect(del.status).toBe(405);
  });

  it("meters every tools/call in a JSON-RPC batch against the window", async () => {
    const minted = await auth.mintToken({
      userId: operator.id,
      name: "batch",
      prefix: "rf_test_",
      createdBy: operator.id,
    });
    const batchOf = (n: number): RpcBody[] =>
      Array.from({ length: n }, (_v, i) => ({
        jsonrpc: "2.0" as const,
        id: 500 + i,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      }));
    const request = (batch: RpcBody[]): Request =>
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${minted.secret}`,
        },
        body: JSON.stringify(batch),
      });
    // A small batch executes and writes one ledger row per call.
    const ok = await route.POST(request(batchOf(2)));
    expect(ok.status).toBe(200);
    const [counted] = await sql`
      select count(*)::int as n from mcp_tool_calls where token_id = ${minted.id}
    `;
    expect(counted?.n).toBe(2);
    // 55 in the window + a batch of 10 would overshoot 60 → the whole
    // request is refused before any call runs (previously all 10 executed).
    for (let i = 0; i < 53; i += 1) {
      await auth.recordToolCall({
        tokenId: minted.id,
        toolName: "whoami",
        argumentIds: {},
        durationMs: 1,
        error: null,
      });
    }
    const limited = await route.POST(request(batchOf(10)));
    expect(limited.status).toBe(429);
    const [after] = await sql`
      select count(*)::int as n from mcp_tool_calls where token_id = ${minted.id}
    `;
    expect(after?.n).toBe(55);
  });

  it("audits rejected calls: invalid_arguments and forbidden are ledgered", async () => {
    const minted = await auth.mintToken({
      userId: operator.id,
      name: "rejects",
      prefix: "rf_test_",
      createdBy: operator.id,
    });
    const bad = await callTool(
      "get_visibility_snapshot",
      { team_id: "not-a-uuid" },
      minted.secret
    );
    expect(bad.isError).toBe(true);
    const wrongScope = await auth.mintToken({
      userId: operator.id,
      name: "rejects-scope",
      prefix: "rf_test_",
      createdBy: operator.id,
      scopes: ["mcp:write"],
    });
    await callTool("whoami", {}, wrongScope.secret);
    const [invalidRow] = await sql`
      select error from mcp_tool_calls where token_id = ${minted.id}
    `;
    const [forbiddenRow] = await sql`
      select error from mcp_tool_calls where token_id = ${wrongScope.id}
    `;
    expect(invalidRow?.error).toBe("invalid_arguments");
    expect(forbiddenRow?.error).toBe("forbidden");
  });

  it("accepts a date-only since filter", async () => {
    const { isError, data } = await callTool("list_outreach_sends", {
      since: "2026-09-01",
    });
    expect(isError).toBe(false);
    expect(Array.isArray(data.sends)).toBe(true);
  });

  it("audits tool calls with argument ids only", async () => {
    await callTool("get_visibility_snapshot", { team_id: fixture.prospectId });
    const rows = await sql`
      select tool_name, argument_ids, error from mcp_tool_calls
      where token_id = ${tokenId} and tool_name = 'get_visibility_snapshot'
      order by created_at desc limit 1
    `;
    expect(rows[0]?.toolName).toBe("get_visibility_snapshot");
    // postgres.camel rewrites JSONB keys on read: stored team_id → teamId.
    expect((rows[0]?.argumentIds as Record<string, string>).teamId).toBe(fixture.prospectId);
  });
});
