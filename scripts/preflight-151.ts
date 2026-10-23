/**
 * Release 151 preflight — READ-ONLY. Prints PASS / WARN / BLOCK per check and
 * exits 1 on any BLOCK. Run against the target database before each gate of
 * docs/engineering/deployment-checklist-151.md.
 *
 *   DATABASE_URL=<target> npx tsx scripts/preflight-151.ts [--phase pre-deploy|post-migrate|pre-cutover]
 *
 * It writes nothing, calls no AI provider, sends nothing. The only network
 * call besides the database is a GET to OLLAMA_URL/api/tags.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { INTERNAL_TASK_TARGETS } from "@/lib/ai/routing";
import { ollamaHealth } from "@/lib/ai/internal/ollama";
import { artifactRoot } from "@/lib/storage/root";

type Level = "PASS" | "WARN" | "BLOCK";
const results: { level: Level; check: string; detail: string }[] = [];
const report = (level: Level, check: string, detail: string) => results.push({ level, check, detail });

const SPEC_151_MIGRATIONS = [
  "134_scores_staging_and_backup_runs.sql",
  "126_measurement_v2.sql",
  "127_gold_annotations.sql",
  "128_opportunities.sql",
  "129_intervention_plans.sql",
  "130_outcomes_and_labor.sql",
  "131_organizations.sql",
  "132_scoring_cutover.sql",
  "133_intervention_predictions.sql",
];

async function main(): Promise<void> {
  const phaseIdx = process.argv.indexOf("--phase");
  const phase = phaseIdx >= 0 ? process.argv[phaseIdx + 1] : "pre-deploy";
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "(unparseable)";
    }
  })();
  console.log(`preflight-151 · phase ${phase} · database ${host}`);

  // --- migrations -----------------------------------------------------------
  const applied = new Set(
    (await sql`select name from schema_migrations`.catch(() => [])).map((r) => r.name as string)
  );
  const missing = SPEC_151_MIGRATIONS.filter((m) => !applied.has(m));
  if (phase === "pre-deploy") {
    const latest = [...applied].sort().at(-1) ?? "none";
    report(missing.length === SPEC_151_MIGRATIONS.length ? "PASS" : "WARN", "migrations", `latest applied ${latest}; spec-151 migrations not yet applied: ${missing.length}`);
  } else {
    report(missing.length === 0 ? "PASS" : "BLOCK", "migrations", missing.length === 0 ? "126–134 applied" : `missing ${missing.join(", ")}`);
  }

  // --- in-flight work -------------------------------------------------------
  const [inflight] = await sql`
    select (select count(*)::int from runs where status in ('pending', 'running')) as runs,
      (select count(*)::int from jobs where status = 'running') as jobs
  `;
  report(
    Number(inflight?.runs) + Number(inflight?.jobs) === 0 ? "PASS" : "WARN",
    "in-flight work",
    `${inflight?.runs ?? 0} pending/running runs, ${inflight?.jobs ?? 0} running jobs — deploy when idle`
  );

  // --- scoring switch and coverage -------------------------------------------
  if (applied.has("132_scoring_cutover.sql")) {
    const [state] = await sql`select read_version, write_legacy from scoring_state where id = 1`;
    report(state ? "PASS" : "BLOCK", "scoring_state", state ? `read ${state.readVersion}, legacy writer ${state.writeLegacy ? "on" : "off"}` : "row missing");
    const [{ v12 }] = (await sql`select count(*)::int as v12 from scores where scoring_version = 'v1.2'`) as unknown as [{ v12: number }];
    report(
      "PASS",
      "application rollback",
      v12 === 0
        ? "scores holds no v1.2 rows: redeploying the pre-151 image is safe"
        : `scores holds ${v12} v1.2 rows (post-cutover): only post-151 images may be deployed; roll back readers with scripts/scoring-cutover.ts rollback`
    );
    if (phase === "pre-cutover") {
      const { verifyCutover } = await import("@/lib/scoring/cutover");
      const v = await verifyCutover();
      report(
        v.ok ? "PASS" : "BLOCK",
        "v1.2 coverage",
        `${v.runsWithLegacy} runs with v1.1; missing v1.2 scores ${v.runsMissingV12Scores.length}, estimates ${v.runsMissingV12Estimates.length}; parity differences ${v.parityDifferences.length}/${v.parityChecked}`
      );
    }
  }

  // --- environment ----------------------------------------------------------
  const env = process.env;
  report(env.BACKUP_ENCRYPTION_KEY ? "PASS" : "BLOCK", "backup encryption", env.BACKUP_ENCRYPTION_KEY ? "set" : "BACKUP_ENCRYPTION_KEY unset");
  report(env.BACKUP_UPLOAD_CMD ? "PASS" : "WARN", "backup off-box", env.BACKUP_UPLOAD_CMD ? "set" : "BACKUP_UPLOAD_CMD unset: backups stay on one disk");
  report(env.ERROR_WEBHOOK_URL ? "PASS" : "WARN", "error tracking", env.ERROR_WEBHOOK_URL ? "set" : "ERROR_WEBHOOK_URL unset: errors go to logs only");
  for (const flag of ["ALLOW_MOCK_PROVIDER", "ALLOW_MOCK_SCORING", "MEASUREMENT_DEFAULT_INSTRUMENT"]) {
    if (env[flag]) report("BLOCK", flag, "must not be set in production");
  }
  const root = artifactRoot();
  const { objectStoreEnabled, objectStoreConfig, probeMissingObjectStatus } = await import("@/lib/storage/object-store");
  if (objectStoreEnabled()) {
    try {
      const cfg = objectStoreConfig();
      // Read-only HEAD of a key that never exists: 404 proves the credential
      // can tell "missing" from "forbidden" (needs s3:ListBucket).
      const probe = await probeMissingObjectStatus(cfg);
      if (probe === 404) {
        report("PASS", "artifact storage", `S3-compatible store ${new URL(cfg.endpoint).host}/${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ""}; credential OK (missing → 404); local cache ${root}. Run scripts/artifacts-sync.ts --audit after the first deploy`);
      } else {
        report("BLOCK", "artifact storage", `probe HEAD returned ${probe}: the credential needs s3:GetObject, s3:PutObject and s3:ListBucket on the bucket (403 means ListBucket is missing or the key is wrong)`);
      }
    } catch (err) {
      report("BLOCK", "artifact storage", err instanceof Error ? err.message : "invalid S3 configuration");
    }
  } else {
    report("BLOCK", "artifact storage", `ARTIFACT_STORE is not s3: artifacts live only in container-local ${root}; the web service cannot read what the worker wrote, and a redeploy loses them`);
  }

  // --- backups --------------------------------------------------------------
  if (applied.has("134_scores_staging_and_backup_runs.sql")) {
    const [b] = await sql`select max(finished_at) filter (where ok) as last_ok from backup_runs`;
    const lastOk = (b?.lastOk as Date | null) ?? null;
    const fresh = lastOk !== null && Date.now() - lastOk.getTime() < 26 * 3600_000;
    report(fresh ? "PASS" : "BLOCK", "recent backup", lastOk ? `last successful backup ${lastOk.toISOString()}` : "no successful backup recorded in backup_runs");
  }

  // --- internal inference host ----------------------------------------------
  const ollamaTasks = Object.entries(INTERNAL_TASK_TARGETS).filter(([, t]) => t?.backend === "ollama");
  const health = await ollamaHealth([...new Set(ollamaTasks.map(([, t]) => t!.model))]);
  report(
    health.reachable && health.missingModels.length === 0 ? "PASS" : "WARN",
    "internal inference",
    health.reachable
      ? `reachable; missing models: ${health.missingModels.join(", ") || "none"}`
      : `unreachable (${health.error ?? "?"}); ${ollamaTasks.map(([k]) => k).join(", ")} will fail closed`
  );

  // --- worker identity ------------------------------------------------------
  const [hb] = await sql`
    select version, handlers, last_seen_at from worker_heartbeats order by last_seen_at desc limit 1
  `.catch(() => []);
  if (phase !== "pre-deploy") {
    const handlers = (hb?.handlers as string[] | undefined) ?? [];
    report(
      handlers.includes("start_baseline_wave") ? "PASS" : "BLOCK",
      "worker handlers",
      hb ? `version ${hb.version ?? "?"}, start_baseline_wave ${handlers.includes("start_baseline_wave") ? "present" : "ABSENT"}` : "no heartbeat"
    );
  }

  for (const r of results) console.log(`${r.level.padEnd(5)} ${r.check}: ${r.detail}`);
  const blocked = results.some((r) => r.level === "BLOCK");
  console.log(blocked ? "PREFLIGHT BLOCKED" : "PREFLIGHT OK (review WARN lines)");
  await sql.end();
  process.exitCode = blocked ? 1 : 0;
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await sql.end();
  process.exit(1);
});
