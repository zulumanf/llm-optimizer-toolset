/**
 * Integration tests for the workspace assistant (spec 044): the bounded
 * tool loop over real MCP observer tools with an injected fake caller (no
 * network), conversation persistence, and the security boundaries.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const otherOperator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};
const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

/** A caller that replays scripted JSON steps — the lib/ai/agent.ts seam. */
const scripted = (steps: object[]): AgentCaller => {
  let i = 0;
  return async () => ({
    text: JSON.stringify(steps[Math.min(i++, steps.length - 1)]),
    tokensIn: 100,
    tokensOut: 20,
  });
};

describe.skipIf(!TEST_URL)("workspace assistant (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let assistant: typeof import("@/lib/assistant/service");
  let projectSvc: typeof import("@/lib/projects/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    assistant = await import("@/lib/assistant/service");
    projectSvc = await import("@/lib/projects/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, assistant_messages, assistant_conversations, projects cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });


  it("answers through a real observer tool and persists the turn with its lookups", async () => {
    unwrap(await projectSvc.createProject(operator, { name: "Client Alpha" }));

    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "Which projects exist?", pathname: "/projects" },
        scripted([
          { action: "tool", tool: "list_projects", input: {} },
          { action: "answer", answer: "One project: Client Alpha (per list_projects)." },
        ])
      )
    );
    expect(reply.reply).toContain("Client Alpha");
    expect(reply.toolCalls).toEqual([
      expect.objectContaining({ tool: "list_projects", ok: true }),
    ]);
    expect(reply.costMicroUsd).toBeGreaterThan(0);

    // Persisted: user + assistant message, tool log on the assistant row.
    const messages = await assistant.getConversationMessages(operator, reply.conversationId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({ tool: "list_projects", ok: true });

    // The real tool ran: its summary carried real data into the transcript.
    const [row] = await sql`
      select tool_calls from assistant_messages
      where conversation_id = ${reply.conversationId} and role = 'assistant'
    `;
    const calls = row?.toolCalls as { summary: string }[];
    expect(calls[0]?.summary).toContain("Client Alpha");

    // Follow-up in the same conversation sees the history.
    const followUp = unwrap(
      await assistant.askAssistant(
        operator,
        {
          conversationId: reply.conversationId,
          message: "thanks",
          pathname: "/projects",
        },
        scripted([{ action: "answer", answer: "Anytime." }])
      )
    );
    expect(followUp.conversationId).toBe(reply.conversationId);
    const all = await assistant.getConversationMessages(operator, reply.conversationId);
    expect(all.length).toBe(4);
  });

  it("raw MCP operator tools and unknown tools come back as tool errors, and the turn still answers", async () => {
    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "start a run", pathname: "/" },
        scripted([
          // run_prompt_set is an MCP OPERATOR tool — never in the assistant
          // belt by that name (spec 096 wraps live runs as the confirm-gated
          // start_benchmark_run instead), so it stays unknown here.
          { action: "tool", tool: "run_prompt_set", input: { project_id: "x" } },
          { action: "answer", answer: "I can't start runs — use the Runs page." },
        ])
      )
    );
    expect(reply.toolCalls[0]).toMatchObject({ tool: "run_prompt_set", ok: false });
    expect(reply.toolCalls[0]?.summary).toContain("Unknown tool");
    expect(reply.reply).toContain("Runs page");
  });

  it("hard-stops the loop at MAX_TOOL_CALLS and says so", async () => {
    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "loop forever", pathname: "/" },
        // Always asks for another tool; never answers.
        scripted([{ action: "tool", tool: "list_projects", input: {} }])
      )
    );
    expect(reply.toolCalls.length).toBe(assistant.MAX_TOOL_CALLS);
    expect(reply.reply).toContain("lookup limit");
  });

  it("sends only the last HISTORY_LIMIT messages, chronological, new user message last", async () => {
    const [conv] = await sql`
      insert into assistant_conversations (user_id, title)
      values (${operator.id}, 'long thread') returning id
    `;
    const conversationId = conv!.id as string;
    // 30 alternating messages, oldest first — msg-01 … msg-30.
    for (let i = 1; i <= 30; i += 1) {
      await sql`
        insert into assistant_messages (conversation_id, role, content, created_at)
        values (${conversationId}, ${i % 2 === 1 ? "user" : "assistant"},
          ${"msg-" + String(i).padStart(2, "0")},
          now() - make_interval(mins => ${60 - i}))
      `;
    }
    let captured = "";
    const capturing: AgentCaller = async (args) => {
      captured = args.user;
      return {
        text: JSON.stringify({ action: "answer", answer: "ok" }),
        tokensIn: 1,
        tokensOut: 1,
      };
    };
    unwrap(
      await assistant.askAssistant(
        operator,
        { conversationId, message: "the newest question", pathname: "/" },
        capturing
      )
    );
    // Window: exactly the last 20 stored messages plus the new user turn.
    const entries = captured.split("\n\n");
    expect(entries.length).toBe(assistant.HISTORY_LIMIT + 1);
    expect(captured).toContain("msg-11");
    expect(captured).toContain("msg-30");
    expect(captured).not.toContain("msg-10");
    expect(captured).not.toContain("msg-01");
    // Chronological, oldest of the window first.
    expect(entries[0]).toBe("USER: msg-11");
    expect(captured.indexOf("msg-11")).toBeLessThan(captured.indexOf("msg-12"));
    expect(captured.indexOf("msg-29")).toBeLessThan(captured.indexOf("msg-30"));
    // The new user message rides last.
    expect(entries[entries.length - 1]).toBe("USER: the newest question");
  });

  it("attributes the turn to the current prompt version in the llm ledger", async () => {
    const { ASSISTANT_PROMPT_VERSION } = await import("@/lib/assistant/prompt");
    unwrap(
      await assistant.askAssistant(
        operator,
        { message: "version check", pathname: "/" },
        scripted([{ action: "answer", answer: "ok" }])
      )
    );
    const [row] = await sql`
      select agent_version from llm_calls order by called_at desc limit 1
    `;
    expect(row?.agentVersion).toBe(ASSISTANT_PROMPT_VERSION);
    expect(row?.agentVersion).toBe("workspace-assistant-v4");
  });

  it("persists the turn when the agent loop throws after tool calls — the thread stays the record", async () => {
    let calls = 0;
    const failing: AgentCaller = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify({ action: "tool", tool: "list_projects", input: {} }),
          tokensIn: 100,
          tokensOut: 20,
        };
      }
      throw new Error("provider melted down");
    };
    const result = await assistant.askAssistant(
      operator,
      { message: "doomed turn", pathname: "/" },
      failing
    );
    // The failure still surfaces to the caller…
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("provider melted down");
    // …but the turn was recorded first: user + assistant rows with the
    // executed tool log, and the conversation's activity clock bumped.
    const [conv] = await sql`
      select id, last_message_at from assistant_conversations where title = 'doomed turn'
    `;
    expect(conv).toBeDefined();
    expect(conv?.lastMessageAt).not.toBeNull();
    const messages = await assistant.getConversationMessages(operator, conv!.id as string);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.content).toBe("doomed turn");
    expect(messages[1]?.content).toContain("provider melted down");
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({ tool: "list_projects", ok: true });
  });

  it("enforces the boundaries: staff-only, own conversations only, insert-only messages", async () => {
    const denied = await assistant.askAssistant(
      clientViewer,
      { message: "hello", pathname: "/" },
      scripted([{ action: "answer", answer: "hi" }])
    );
    expect(denied.ok).toBe(false);

    const mine = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "private note", pathname: "/" },
        scripted([{ action: "answer", answer: "noted" }])
      )
    );
    // Another staff member can neither read nor append to it.
    await expect(
      assistant.getConversationMessages(otherOperator, mine.conversationId)
    ).rejects.toThrow(/not found/i);
    const appended = await assistant.askAssistant(
      otherOperator,
      { conversationId: mine.conversationId, message: "mine now", pathname: "/" },
      scripted([{ action: "answer", answer: "no" }])
    );
    expect(appended.ok).toBe(false);

    // The transcript is insert-only.
    await expect(
      sql`update assistant_messages set content = 'edited'
        where conversation_id = ${mine.conversationId}`
    ).rejects.toThrow(/immutable|forbid/i);
  });
});
