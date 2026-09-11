/**
 * Weekly cycle kickoff endpoint (spec 017). The worker's internal ticker is
 * the primary caller now (workers/index.ts, 2026-08-17); this route remains
 * for manual pokes and any external scheduler. Idempotent per ISO week — a
 * repeat fire is a no-op. The logic lives in lib/ops/tick.ts +
 * lib/cycles/service.ts, shared with the worker.
 */
import { NextResponse } from "next/server";
import { runWeeklyKick } from "@/lib/ops/tick";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const denied = requireCronSecret(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await runWeeklyKick());
  } catch (err) {
    log("error", "cron.weekly_cycle_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Cycle start failed" }, { status: 500 });
  }
}
