/**
 * Weekly baseline cron endpoint (docs/07: cadence; docs/10: CRON_SECRET
 * auth). The worker's tick is the primary caller now (lib/ops/tick.ts —
 * the sweep runs enrolled projects of ANY kind); this route remains for
 * manual pokes and external schedulers. Idempotent per ISO week (UTC).
 */
import { runWeeklyBaselines } from "@/lib/ops/tick";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const denied = requireCronSecret(request);
  if (denied) {
    log("warn", "cron.baseline.unauthorized", {});
    return denied;
  }
  return Response.json({ results: await runWeeklyBaselines() });
}
