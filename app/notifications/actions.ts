"use server";

import { revalidatePath } from "next/cache";
import { makeActionRunner } from "@/lib/actions/run";
import { assertRole, getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/notifications/service";

// The inbox is a cross-client operator surface — the digest names every
// client with an open issue. Staff only; these actions ran without any
// caller check before the 2026-07 audit.

export async function syncNotifications(): Promise<
  ActionResult<svc.SyncResult>
> {
  try {
    assertRole(await getCurrentUser(), "operator");
    const result = await svc.syncNotifications();
    revalidatePath("/", "layout");
    return { ok: true, data: result };
  } catch (err) {
    return fail(err);
  }
}

// The other three actions here wrap non-ActionResult service calls behind
// an operator role gate, so they keep their explicit shape; this one is the
// textbook runner case.
const run = makeActionRunner(["/", "layout"]);

export async function setNotificationStatus(input: unknown) {
  return run((user) => svc.setNotificationStatus(user, input));
}

export async function markAllRead(): Promise<ActionResult<{ count: number }>> {
  try {
    assertRole(await getCurrentUser(), "operator");
    const count = await svc.markAllRead();
    revalidatePath("/", "layout");
    return { ok: true, data: { count } };
  } catch (err) {
    return fail(err);
  }
}

export async function copyDigest(): Promise<ActionResult<{ text: string }>> {
  try {
    assertRole(await getCurrentUser(), "operator");
    return { ok: true, data: { text: await svc.digestText() } };
  } catch (err) {
    return fail(err);
  }
}
