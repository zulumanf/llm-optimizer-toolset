/**
 * Weekly cycle kickoff (spec 017). Point a Monday-morning scheduler here and
 * every configured client's week runs itself up to the first judgement call.
 * Idempotent: a repeat fire in the same week is a no-op.
 */
import { NextResponse } from "next/server";
import { startWeeklyCycles } from "@/lib/cycles/service";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export async function POST(request: Request): Promise<Response> {
  const denied = requireCronSecret(request);
  if (denied) return denied;
  try {
    const result = await startWeeklyCycles();
    return NextResponse.json(result);
  } catch (err) {
    log("error", "cron.weekly_cycle_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Cycle start failed" }, { status: 500 });
  }
}
