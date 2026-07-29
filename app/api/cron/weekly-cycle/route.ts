/**
 * Weekly cycle kickoff (spec 017). Point a Monday-morning scheduler here and
 * every configured client's week runs itself up to the first judgement call.
 * Idempotent: a repeat fire in the same week is a no-op.
 */
import { NextResponse } from "next/server";
import { startWeeklyCycles } from "@/lib/cycles/service";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = getEnv().CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
