/**
 * Weekly baseline cron (docs/07: cadence; docs/10: CRON_SECRET auth).
 * For each active project with a configured baseline set, starts a scheduled
 * run of the latest frozen version — unless one already exists for this ISO
 * week (UTC), in which case it no-ops with an alert log.
 */
import { sql } from "@/db/client";
import { startRun } from "@/lib/runs/service";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";
import type { ProviderConfig } from "@/lib/runs/cells";

export const dynamic = "force-dynamic";

interface BaselineConfig {
  providers: ProviderConfig[];
  budgetUsd: number;
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireCronSecret(request);
  if (denied) {
    log("warn", "cron.baseline.unauthorized", {});
    return denied;
  }

  const projects = await sql`
    select id, name, baseline_prompt_set_id, baseline_config
    from projects
    where status = 'active' and baseline_prompt_set_id is not null
  `;

  const results: Array<{ projectId: string; outcome: string }> = [];
  for (const project of projects) {
    const projectId = project.id as string;
    const config = project.baselineConfig as BaselineConfig | null;
    if (!config?.providers?.length || !config.budgetUsd) {
      log("warn", "cron.baseline.misconfigured", { projectId });
      results.push({ projectId, outcome: "misconfigured" });
      continue;
    }

    const [latest] = await sql`
      select id from prompt_set_versions
      where prompt_set_id = ${project.baselinePromptSetId as string}
      order by version desc limit 1
    `;
    if (!latest) {
      log("warn", "cron.baseline.never_frozen", { projectId });
      results.push({ projectId, outcome: "never_frozen" });
      continue;
    }

    // Dedupe key: ISO week (UTC) of started_at for scheduled runs
    const [existing] = await sql`
      select id from runs
      where project_id = ${projectId} and trigger = 'scheduled'
        and to_char(started_at at time zone 'UTC', 'IYYY-IW')
          = to_char(now() at time zone 'UTC', 'IYYY-IW')
    `;
    if (existing) {
      log("warn", "cron.baseline.duplicate_week", { projectId });
      results.push({ projectId, outcome: "already_ran_this_week" });
      continue;
    }

    const week = new Date().toISOString().slice(0, 10);
    const started = await startRun(
      null,
      {
        projectId,
        promptSetVersionId: latest.id as string,
        providers: config.providers,
        budgetUsd: config.budgetUsd,
        label: `Weekly baseline ${week}`,
      },
      "scheduled"
    );
    if (started.ok) {
      log("info", "cron.baseline.started", { projectId, runId: started.data.id });
      results.push({ projectId, outcome: "started" });
    } else {
      log("error", "cron.baseline.failed", {
        projectId,
        error: started.error.message,
      });
      results.push({ projectId, outcome: `failed: ${started.error.kind}` });
    }
  }

  return Response.json({ results });
}
