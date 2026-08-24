/**
 * Workspace assistant (spec 044; operator mode spec 096): a bounded agent
 * loop over the MCP observer registry plus the assistant tool belt, invoked
 * as the calling user. Direct-tier belt tools stage reviewable artifacts;
 * confirm-tier tools NEVER execute from the model — they mint a pending
 * action the operator confirms with a button (lib/assistant/confirm.ts).
 * Raw MCP operator tools stay structurally unreachable by name.
 *
 * Conversations persist; messages are insert-only, each assistant message
 * carrying the tool calls it rests on and its cost. Tests inject a fake
 * caller (the lib/ai/agent.ts pattern) so CI never touches the network.
 */
import { modelForTask } from "@/lib/ai/routing";
import { z } from "zod";
import { sql } from "@/db/client";
import { isStaff, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { MCP_TOOLS, invokeTool } from "@/lib/mcp/tools";
import {
  CONFIRM_REQUIRED,
  compactCatalog,
  getAssistantTool,
  runAssistantTool,
} from "@/lib/assistant/tools";
import { mintPendingAction } from "@/lib/assistant/confirm";
import {
  ASSISTANT_PROMPT_VERSION,
  assistantSystemPrompt,
} from "@/lib/assistant/prompt";
import { log } from "@/lib/logger";

// 10 (spec 096 follow-up): research chains legitimately take more steps,
// and self-corrected retries after a validation error need headroom.
export const MAX_TOOL_CALLS = 10;
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

export interface AssistantPendingAction {
  id: string;
  tool: string;
  summary: string;
  /** Server-minted; rendered as the Confirm button. Never shown to the model. */
  token: string;
}

export interface AssistantReply {
  conversationId: string;
  reply: string;
  toolCalls: AssistantToolCall[];
  costMicroUsd: number;
  pendingActions: AssistantPendingAction[];
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

/** Progress events for the streaming transport (spec 110). Emission is
 * observation only — a callback failure is logged and never fails the turn. */
export type AssistantStreamEvent =
  | { type: "tool_start"; tool: string }
  | { type: "tool_end"; tool: string; ok: boolean; summary: string }
  | { type: "done"; reply: AssistantReply };

function emitEvent(
  onEvent: ((e: AssistantStreamEvent) => void) | undefined,
  event: AssistantStreamEvent
): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch (err) {
    log("warn", "assistant.event_callback_failed", {
      type: event.type,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  lastMessageAt: Date | null;
  messageCount: number;
}

/** The caller's own conversations, newest activity first (spec 112). */
export async function listConversations(
  user: CurrentUser,
  limit = 20
): Promise<AssistantConversationSummary[]> {
  assertStaff(user);
  const rows = await sql`
    select c.id, c.title, c.last_message_at,
      (select count(*)::int from assistant_messages m
        where m.conversation_id = c.id) as message_count
    from assistant_conversations c
    where c.user_id = ${user.id}
    order by c.last_message_at desc nulls last
    limit ${Math.min(Math.max(limit, 1), 50)}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    title: (r.title as string) ?? "",
    lastMessageAt: (r.lastMessageAt as Date | null) ?? null,
    messageCount: Number(r.messageCount ?? 0),
  }));
}

export async function askAssistant(
  user: CurrentUser,
  raw: unknown,
  caller?: AgentCaller,
  onEvent?: (e: AssistantStreamEvent) => void
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
      toolCatalog: compactCatalog(),
    });

    const toolCalls: AssistantToolCall[] = [];
    const pendingActions: AssistantPendingAction[] = [];
    let cost = 0;
    let reply: string | null = null;

    for (let step = 0; step <= MAX_TOOL_CALLS; step += 1) {
      const mustAnswer = step === MAX_TOOL_CALLS;
      const run = await runAgent({
        agentVersion: ASSISTANT_PROMPT_VERSION,
        model: modelForTask("workspace_assistant"),
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
      // Three sources, in precedence order (spec 096): MCP observer tools,
      // then the assistant belt — whose confirm tier NEVER executes from
      // here: it mints a pending action for the operator's Confirm button.
      emitEvent(onEvent, { type: "tool_start", tool: toolName });
      const isObserver = OBSERVER_TOOLS.some((t) => t.name === toolName);
      const assistantTool = getAssistantTool(toolName);
      let result: { ok: true; data: unknown } | { ok: false; error: { kind: string; message: string } };
      if (isObserver) {
        result = await invokeTool(user, toolName, toolInput);
      } else if (assistantTool && CONFIRM_REQUIRED.has(toolName)) {
        try {
          const pending = await mintPendingAction(user, conversationId, toolName, toolInput);
          pendingActions.push({ id: pending.id, tool: pending.tool, summary: pending.summary, token: pending.token });
          result = {
            ok: true,
            data: {
              requires_confirmation: true,
              summary: pending.summary,
              note: "A Confirm button is now shown to the operator. Nothing has executed. Tell them what it will do and wait — do not retry this tool.",
            },
          };
        } catch (err) {
          result = {
            ok: false,
            error: {
              kind: "validation",
              message: err instanceof Error ? err.message : "could not stage the action",
            },
          };
        }
      } else if (assistantTool) {
        try {
          result = { ok: true, data: await runAssistantTool(user, toolName, toolInput, caller) };
        } catch (err) {
          const message = err instanceof Error ? err.message : "tool failed";
          result = { ok: false, error: { kind: "validation", message } };
        }
      } else {
        result = {
          ok: false,
          error: {
            kind: "validation",
            message: `Unknown tool "${toolName}".`,
          },
        };
      }
      const summary = result.ok
        ? toolResultForTranscript(result.data)
        : `ERROR (${result.error.kind}): ${result.error.message}`;
      toolCalls.push({
        tool: toolName,
        input: toolInput,
        ok: result.ok,
        summary: summary.slice(0, 400),
      });
      emitEvent(onEvent, {
        type: "tool_end",
        tool: toolName,
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
    const replyPayload: AssistantReply = {
      conversationId,
      reply: finalReply,
      toolCalls,
      costMicroUsd: Math.round(cost),
      pendingActions,
    };
    emitEvent(onEvent, { type: "done", reply: replyPayload });
    return ok(replyPayload);
  } catch (err) {
    return fail(err);
  }
}
