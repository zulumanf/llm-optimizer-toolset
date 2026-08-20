/**
 * The assistant's human gate (spec 096). A confirm-tier tool call mints a
 * pending action here — single-use, expiring, bound to the exact tool +
 * input and to the requesting user. The model never sees the token; the
 * dock renders it as a Confirm button, and only the confirm server action
 * (a human click in the operator's own session) executes.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import {
  CONFIRM_REQUIRED,
  getAssistantTool,
  runAssistantTool,
} from "@/lib/assistant/tools";

export const PENDING_ACTION_TTL_MINUTES = 15;

export interface PendingActionRow {
  id: string;
  tool: string;
  summary: string;
  token: string;
  status: string;
  createdAt: Date;
}

export async function mintPendingAction(
  user: CurrentUser,
  conversationId: string,
  tool: string,
  input: Record<string, unknown>
): Promise<PendingActionRow> {
  const def = getAssistantTool(tool);
  if (!def || !CONFIRM_REQUIRED.has(tool)) {
    throw new ClassifiedError("validation", `"${tool}" is not a confirm-gated tool.`);
  }
  // Validate NOW so a malformed proposal can never be confirmed later.
  const parsed = def.schema.safeParse(input);
  if (!parsed.success) {
    throw new ClassifiedError(
      "validation",
      `Invalid input for ${tool}: ${parsed.error.issues[0]?.message ?? "bad shape"}`
    );
  }
  const summary = def.summarize
    ? def.summarize(parsed.data as Record<string, unknown>)
    : `Run ${tool}`;
  const token = randomBytes(24).toString("hex");
  const [row] = await sql`
    insert into assistant_pending_actions
      (conversation_id, user_id, tool, input, summary, token)
    values (${conversationId}, ${user.id}, ${tool},
      ${sql.json(parsed.data as never)}, ${summary}, ${token})
    returning id, tool, summary, token, status, created_at
  `;
  return {
    id: row!.id as string,
    tool: row!.tool as string,
    summary: row!.summary as string,
    token: row!.token as string,
    status: row!.status as string,
    createdAt: row!.createdAt as Date,
  };
}

/** Pending actions for a conversation the dock still needs to render. */
export async function listPendingActions(
  user: CurrentUser,
  conversationId: string
): Promise<PendingActionRow[]> {
  const rows = await sql`
    select a.id, a.tool, a.summary, a.token, a.status, a.created_at
    from assistant_pending_actions a
    join assistant_conversations c on c.id = a.conversation_id
    where a.conversation_id = ${conversationId} and c.user_id = ${user.id}
      and a.status = 'pending'
      and a.created_at > now() - make_interval(mins => ${PENDING_ACTION_TTL_MINUTES})
    order by a.created_at asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    tool: row.tool as string,
    summary: row.summary as string,
    token: row.token as string,
    status: row.status as string,
    createdAt: row.createdAt as Date,
  }));
}

const decisionSchema = z.object({ token: z.string().min(20).max(120) });

async function claimPending(
  user: CurrentUser,
  token: string,
  toStatus: "confirmed" | "cancelled"
): Promise<{ id: string; conversationId: string; tool: string; input: Record<string, unknown>; summary: string }> {
  // Single-use claim: the status flip IS the lock — a second click, a
  // replay, or a race gets zero rows and refuses.
  // input::text, parsed by hand: the client's camel-casing rewrites jsonb
  // keys on read (snake_case tool inputs would fail re-validation), and the
  // action must execute with EXACTLY the keys that were minted.
  const [row] = await sql`
    update assistant_pending_actions set status = ${toStatus}, decided_at = now()
    where token = ${token} and user_id = ${user.id} and status = 'pending'
      and created_at > now() - make_interval(mins => ${PENDING_ACTION_TTL_MINUTES})
    returning id, conversation_id, tool, input::text as input_raw, summary
  `;
  if (!row) {
    // Expire stale rows lazily so the table reads honestly.
    await sql`
      update assistant_pending_actions set status = 'expired', decided_at = now()
      where token = ${token} and status = 'pending'
        and created_at <= now() - make_interval(mins => ${PENDING_ACTION_TTL_MINUTES})
    `;
    throw new ClassifiedError(
      "not_found",
      "This action is no longer confirmable — already decided, expired, or not yours. Ask the assistant to propose it again."
    );
  }
  return {
    id: row.id as string,
    conversationId: row.conversationId as string,
    tool: row.tool as string,
    input: JSON.parse((row.inputRaw as string) ?? "{}") as Record<string, unknown>,
    summary: row.summary as string,
  };
}

export async function confirmAssistantAction(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ summary: string; result: unknown }>> {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid token."));
  try {
    const claimed = await claimPending(user, parsed.data.token, "confirmed");
    let result: unknown;
    let outcome: string;
    try {
      result = await runAssistantTool(user, claimed.tool, claimed.input);
      outcome = `Confirmed and executed: ${claimed.summary}.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      result = { error: message };
      outcome = `Confirmed, but the action failed: ${message}`;
    }
    await sql`
      update assistant_pending_actions set result = ${sql.json(
        (typeof result === "object" && result !== null ? result : { value: result }) as never
      )}
      where id = ${claimed.id}
    `;
    // The outcome joins the conversation so the thread stays the record.
    await sql`
      insert into assistant_messages (conversation_id, role, content, tool_calls)
      values (${claimed.conversationId}, 'assistant', ${outcome}, ${sql.json([
        { tool: claimed.tool, input: {}, ok: !(result as { error?: string })?.error, summary: claimed.summary },
      ] as never)})
    `;
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "assistant.action_confirmed",
        entity: "assistant_pending_action",
        entityId: claimed.id,
        detail: { tool: claimed.tool, summary: claimed.summary },
      })
    );
    return ok({ summary: claimed.summary, result });
  } catch (err) {
    return fail(err);
  }
}

export async function cancelAssistantAction(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ summary: string }>> {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid token."));
  try {
    const claimed = await claimPending(user, parsed.data.token, "cancelled");
    await sql`
      insert into assistant_messages (conversation_id, role, content, tool_calls)
      values (${claimed.conversationId}, 'assistant',
        ${`Dismissed without executing: ${claimed.summary}.`}, '[]'::jsonb)
    `;
    return ok({ summary: claimed.summary });
  } catch (err) {
    return fail(err);
  }
}
