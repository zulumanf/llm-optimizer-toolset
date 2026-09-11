/**
 * The automation heartbeat endpoint. The worker's internal ticker is the
 * primary clock (workers/index.ts, 2026-08-17); this route remains for
 * manual pokes and any external scheduler. Safe to call at any frequency,
 * from any number of schedulers — the tick's idempotency is structural
 * (windowed fire keys, (event, subscription) delivery keys); see
 * lib/ops/tick.ts, the one implementation both callers share.
 */
import { NextResponse } from "next/server";
import { runAutomationTick } from "@/lib/ops/tick";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Refuse rather than run open. An unauthenticated automation heartbeat is a
  // way for anyone to make the platform act.
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const url = new URL(request.url);
  // Health probes cost real provider calls, so they run on their own cadence
  // rather than every tick.
  const includeHealth = url.searchParams.get("health") === "true";

  try {
    const report = await runAutomationTick({ includeHealth });
    return NextResponse.json(report);
  } catch (err) {
    log("error", "cron.automation_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Automation dispatch failed" }, { status: 500 });
  }
}
