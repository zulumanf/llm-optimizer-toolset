/**
 * Notification sync endpoint (docs/17 B2). Point a scheduler at this hourly
 * so the inbox reflects reality without anyone opening the app. Same shared
 * secret as the weekly-baseline cron; the sync itself is idempotent, so a
 * double-fire is harmless.
 */
import { NextResponse } from "next/server";
import { syncNotifications } from "@/lib/notifications/service";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = getEnv().CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
