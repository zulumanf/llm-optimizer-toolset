"use server";

import { getCurrentUser } from "@/lib/auth";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import * as assistant from "@/lib/assistant/service";
import * as confirm from "@/lib/assistant/confirm";
import type { AssistantMessageRow } from "@/lib/assistant/service";

export async function askAssistant(input: unknown) {
  try {
    const user = await getCurrentUser();
    return await assistant.askAssistant(user, input);
  } catch (err) {
    return fail(err);
  }
}

export async function getAssistantConversation(
  conversationId: string
): Promise<ActionResult<AssistantMessageRow[]>> {
  try {
    const user = await getCurrentUser();
    return ok(await assistant.getConversationMessages(user, conversationId));
  } catch (err) {
    return fail(err);
  }
}

export async function confirmAssistantAction(input: unknown) {
  try {
    const user = await getCurrentUser();
    return await confirm.confirmAssistantAction(user, input);
  } catch (err) {
    return fail(err);
  }
}

export async function cancelAssistantAction(input: unknown) {
  try {
    const user = await getCurrentUser();
    return await confirm.cancelAssistantAction(user, input);
  } catch (err) {
    return fail(err);
  }
}

export async function getPendingAssistantActions(conversationId: string) {
  try {
    const user = await getCurrentUser();
    return ok(await confirm.listPendingActions(user, conversationId));
  } catch (err) {
    return fail(err);
  }
}
