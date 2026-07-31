/**
 * Notification sync endpoint (docs/17 B2). Point a scheduler at this hourly
 * so the inbox reflects reality without anyone opening the app. Same shared
 * secret as the weekly-baseline cron; the sync itself is idempotent, so a
 * double-fire is harmless.
 */
import { NextResponse } from "next/server";
import { syncNotifications } from "@/lib/notifications/service";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export async function POST(request: Request): Promise<Response> {
  const denied = requireCronSecret(request);
  if (denied) return denied;
  try {
    const result = await syncNotifications();
    return NextResponse.json(result);
  } catch (err) {
    log("error", "cron.notifications_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
