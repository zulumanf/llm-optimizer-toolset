/**
 * Workspace assistant (spec 044): a bounded agent loop whose ONLY data
 * access is the MCP observer tool registry, invoked as the calling user —
 * same staff assertion, zod validation, and classified errors as the MCP
 * server. Operator (mutating) tools are structurally excluded: the
 * assistant reads and explains; it never writes platform state.
 *
 * Conversations persist; messages are insert-only, each assistant message
 * carrying the tool calls it rests on and its cost. Tests inject a fake
 * caller (the lib/ai/agent.ts pattern) so CI never touches the network.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { isStaff, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { MCP_TOOLS, invokeTool } from "@/lib/mcp/tools";
import {
  ASSISTANT_PROMPT_VERSION,
  assistantSystemPrompt,
} from "@/lib/assistant/prompt";
import { log } from "@/lib/logger";

export const MAX_TOOL_CALLS = 6;
export const HISTORY_LIMIT = 20;
const MESSAGE_MAX = 4000;
const TOOL_RESULT_CHAR_LIMIT = 6000;
const TITLE_MAX = 80;

/** The assistant's tool belt: observer tools only, resolved at module load.
 * Mutating tools never enter the catalog, so the model cannot even see them. */
const OBSERVER_TOOLS = MCP_TOOLS.filter((t) => t.group === "observer");

const stepSchema = z.union([
  z.object({
    action: z.literal("tool"),
    tool: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  }),
  z.object({ action: z.literal("answer"), answer: z.string().min(1) }),
]);

export interface AssistantToolCall {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface AssistantReply {
  conversationId: string;
  reply: string;
  toolCalls: AssistantToolCall[];
  costMicroUsd: number;
}

export interface AssistantMessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: AssistantToolCall[];
  createdAt: Date;
}

const askSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(MESSAGE_MAX),
  pathname: z.string().trim().max(300).default("/"),
});

/** Truncate a tool result for the transcript — the full result never needs
 * to ride the prompt; the model summarizes, the user can open the page. */
function toolResultForTranscript(data: unknown): string {
  const text = JSON.stringify(data);
  return text.length > TOOL_RESULT_CHAR_LIMIT
    ? `${text.slice(0, TOOL_RESULT_CHAR_LIMIT)}… (truncated)`
    : text;
}

async function loadConversation(
  user: CurrentUser,
  conversationId: string
): Promise<{ id: string }> {
  const [row] = await sql`
    select id, user_id from assistant_conversations
    where id = ${conversationId} and archived_at is null
  `;
  if (!row || (row.userId as string) !== user.id) {
    // Another user's conversation is indistinguishable from a missing one.
    throw new ClassifiedError("not_found", "Conversation not found.");
  }
  return { id: row.id as string };
}

function assertStaff(user: CurrentUser): void {
  if (!isStaff(user)) {
    throw new ClassifiedError("forbidden", "The assistant is staff-only.");
  }
}

export async function getConversationMessages(
  user: CurrentUser,
  conversationId: string
): Promise<AssistantMessageRow[]> {
  assertStaff(user);
  await loadConversation(user, conversationId);
  const rows = await sql`
    select id, role, content, tool_calls, created_at
    from assistant_messages
    where conversation_id = ${conversationId}
    order by created_at asc
    limit 200
  `;
  return rows.map((r) => ({
    id: r.id as string,
    role: r.role as "user" | "assistant",
    content: r.content as string,
    toolCalls: (r.toolCalls as AssistantToolCall[]) ?? [],
    createdAt: r.createdAt as Date,
  }));
}

export async function askAssistant(
  user: CurrentUser,
  raw: unknown,
  caller?: AgentCaller
): Promise<ActionResult<AssistantReply>> {
  const parsed = askSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A message is required (max 4000 chars)."));
  }
  const input = parsed.data;
  try {
    assertStaff(user);

    // Conversation: the caller's own, or a new one.
    let conversationId: string;
    if (input.conversationId) {
      conversationId = (await loadConversation(user, input.conversationId)).id;
    } else {
      const [row] = await sql`
        insert into assistant_conversations (user_id, title)
        values (${user.id}, ${input.message.slice(0, TITLE_MAX)})
        returning id
      `;
      conversationId = row?.id as string;
    }

    const history = await sql`
      select role, content from assistant_messages
      where conversation_id = ${conversationId}
      order by created_at desc limit ${HISTORY_LIMIT}
    `;
    const transcript: string[] = [...history]
      .reverse()
      .map((m) => `${(m.role as string).toUpperCase()}: ${m.content}`);
    transcript.push(`USER: ${input.message}`);

    const system = assistantSystemPrompt({
      userName: user.name,
      today: new Date().toISOString().slice(0, 10),
      pathname: input.pathname,
      toolCatalog: OBSERVER_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
      })),
    });

    const toolCalls: AssistantToolCall[] = [];
    let cost = 0;
    let reply: string | null = null;

    for (let step = 0; step <= MAX_TOOL_CALLS; step += 1) {
      const mustAnswer = step === MAX_TOOL_CALLS;
      const run = await runAgent({
        agentVersion: ASSISTANT_PROMPT_VERSION,
        system,
        user:
          transcript.join("\n\n") +
          (mustAnswer
            ? '\n\n(You have used every allowed lookup — respond with {"action":"answer",...} now.)'
            : ""),
        schema: stepSchema,
        caller,
      });
      cost += run.costMicroUsd;

      const output = run.output;
      if (output.action === "answer") {
        reply = output.answer;
        break;
      }
      if (mustAnswer) {
        // The model asked for yet another tool after the hard stop.
        reply =
          "I hit the lookup limit for one question before reaching an answer — try asking something narrower.";
        break;
      }
      const toolName = output.tool;
      const toolInput = output.input;
      // Observer-only: a mutating tool name is unknown here BY CONSTRUCTION.
      const known = OBSERVER_TOOLS.some((t) => t.name === toolName);
      const result = known
        ? await invokeTool(user, toolName, toolInput)
        : ({
            ok: false as const,
            error: {
              kind: "validation",
              message: `Unknown tool "${toolName}" — only read-only tools are available to you.`,
            },
          });
      const summary = result.ok
        ? toolResultForTranscript(result.data)
        : `ERROR (${result.error.kind}): ${result.error.message}`;
      toolCalls.push({
        tool: toolName,
        input: toolInput,
        ok: result.ok,
        summary: summary.slice(0, 400),
      });
      transcript.push(`TOOL ${toolName}(${JSON.stringify(toolInput)}) → ${summary}`);
    }

    const finalReply = reply ?? "I could not produce an answer.";
    await sql.begin(async (tx) => {
      await tx`
        insert into assistant_messages (conversation_id, role, content)
        values (${conversationId}, 'user', ${input.message})
      `;
      await tx`
        insert into assistant_messages
          (conversation_id, role, content, tool_calls, cost_micro_usd)
        values (${conversationId}, 'assistant', ${finalReply},
          ${tx.json(toolCalls as never)}, ${Math.round(cost)})
      `;
      await tx`
        update assistant_conversations set last_message_at = now()
        where id = ${conversationId}
      `;
    });
    log("info", "assistant.turn", {
      conversationId,
      toolCalls: toolCalls.length,
      costMicroUsd: Math.round(cost),
    });
    return ok({
      conversationId,
      reply: finalReply,
      toolCalls,
      costMicroUsd: Math.round(cost),
    });
  } catch (err) {
    return fail(err);
  }
}
