/**
 * Notification sync endpoint (docs/17 B2). Point a scheduler at this hourly
 * so the inbox reflects reality without anyone opening the app. Same shared
 * secret as the weekly-baseline cron; the sync itself is idempotent, so a
 * double-fire is harmless.
 */
import { NextResponse } from "next/server";
import { syncNotifications, deliverDigest } from "@/lib/notifications/service";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export async function POST(request: Request): Promise<Response> {
  const denied = requireCronSecret(request);
  if (denied) return denied;
  try {
    const result = await syncNotifications();
    // ?digest=1 also pushes the open-items digest to DIGEST_WEBHOOK_URL
    // (plan 5.6). The scheduler decides the cadence: point an hourly job at
    // the bare route and one daily job at ?digest=1.
    if (new URL(request.url).searchParams.get("digest") === "1") {
      const digest = await deliverDigest();
      return NextResponse.json({ ...result, digest });
    }
    return NextResponse.json(result);
  } catch (err) {
    log("error", "cron.notifications_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
