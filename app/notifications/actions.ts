"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/notifications/service";

export async function syncNotifications(): Promise<
  ActionResult<svc.SyncResult>
> {
  try {
    const result = await svc.syncNotifications();
    revalidatePath("/", "layout");
    return { ok: true, data: result };
  } catch (err) {
    return fail(err);
  }
}

export async function setNotificationStatus(input: unknown) {
  try {
    const user = await getCurrentUser();
    const result = await svc.setNotificationStatus(user, input);
    if (result.ok) revalidatePath("/", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function markAllRead(): Promise<ActionResult<{ count: number }>> {
  try {
    const count = await svc.markAllRead();
    revalidatePath("/", "layout");
    return { ok: true, data: { count } };
  } catch (err) {
    return fail(err);
  }
}

export async function copyDigest(): Promise<ActionResult<{ text: string }>> {
  try {
    return { ok: true, data: { text: await svc.digestText() } };
  } catch (err) {
    return fail(err);
  }
}
