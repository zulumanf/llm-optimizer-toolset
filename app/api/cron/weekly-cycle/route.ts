/**
 * Weekly cycle kickoff (spec 017). Point a Monday-morning scheduler here and
 * every configured client's week runs itself up to the first judgement call.
 * Idempotent: a repeat fire in the same week is a no-op.
 *
 * The same fire starts each client's weekly_brief_v1 workflow (C4) — the
 * brief covers the trailing seven days (last week's completed measurement)
 * and is the only writer of client health snapshots, so before this it was
 * never scheduled and the control tower's health panel stayed empty.
 * Idempotent per (project, week) via the run's idempotency key.
 */
import { NextResponse } from "next/server";
import { sql } from "@/db/client";
import { startWeeklyCycles, weekStart } from "@/lib/cycles/service";
import { startWorkflow } from "@/lib/workflow/engine";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

async function startWeeklyBriefs(): Promise<{ started: number; skipped: number }> {
  const week = weekStart();
  const today = new Date();
  const periodStart = new Date(today.getTime() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const periodEnd = today.toISOString().slice(0, 10);

  const projects = await sql`select id from projects where status = 'active'`;
  let started = 0;
  let skipped = 0;
  for (const project of projects) {
    try {
      await startWorkflow({
        definitionKey: "weekly_brief_v1",
        projectId: project.id as string,
        input: { periodStart, periodEnd },
        idempotencyKey: `weekly-brief:${project.id}:${week}`,
      });
      started += 1;
    } catch (err) {
      // One client's brief failing to start must not stop the others'.
      skipped += 1;
      log("warn", "cron.weekly_brief_start_failed", {
        projectId: project.id,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return { started, skipped };
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireCronSecret(request);
  if (denied) return denied;
  try {
    const result = await startWeeklyCycles();
    const briefs = await startWeeklyBriefs();
    return NextResponse.json({ ...result, briefs });
  } catch (err) {
    log("error", "cron.weekly_cycle_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Cycle start failed" }, { status: 500 });
  }
}
