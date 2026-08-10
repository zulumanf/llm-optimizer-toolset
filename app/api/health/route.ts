/**
 * Health endpoint (spec 059). Two audiences, one route:
 * - Unauthenticated (a platform health check): minimal {ok, db, worker},
 *   200/503 — enough to route traffic, leaking no operational detail.
 * - CRON_SECRET bearer: the full report — queue depth and age, drift,
 *   spend vs ceiling — the numbers the audit said no operator could ask.
 */
import { healthReport } from "@/lib/ops/health";
import { requireCronSecret } from "@/lib/security/cron-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const report = await healthReport();
  const status = report.ok ? 200 : 503;

  const denied = requireCronSecret(request);
  if (denied) {
    return Response.json(
      { ok: report.ok, db: report.db, worker: report.worker.alive },
      { status }
    );
  }
  return Response.json(report, { status });
}
