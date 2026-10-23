/**
 * Re-score historical runs FORWARD under the current SCORING_VERSION
 * (spec 151 A10, AGENTS.md: new scoring versions re-score forward, old
 * scores stay).
 *
 *   npx tsx scripts/rescore.ts                 # dry run: what would be scored
 *   npx tsx scripts/rescore.ts --apply         # write v-current rows
 *   npx tsx scripts/rescore.ts --apply --project <uuid>
 *
 * Reads only immutable rows (responses, mentions, frozen prompts, cohorts);
 * writes only insert-only `scores` / `score_estimates` rows with
 * `on conflict do nothing`, so it is idempotent and safe to resume. Makes no
 * provider calls and publishes no movement events. Writes v1.2 only: it
 * never adds v1.1 rows to a historical run (release 151 cutover). Runs whose review queue
 * is not clear are skipped and listed — scoring refuses them by design.
 *
 * Running this against production is a deployment step that needs the
 * founder's explicit approval (docs/engineering/production-readiness.md).
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { SCORING_VERSION } from "@/lib/constants";
import { computeScores } from "@/lib/scoring/compute";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx >= 0 ? (args[projectIdx + 1] ?? null) : null;
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();

  const runs = await sql`
    select r.id, r.label, r.started_at from runs r
    where r.status in ('completed', 'partial')
      and (${projectId}::uuid is null or r.project_id = ${projectId})
      and not exists (
        select 1 from score_estimates e
        where e.run_id = r.id and e.scoring_version = ${SCORING_VERSION}
      )
    order by r.started_at asc
  `;
  console.log(`target ${host} · version ${SCORING_VERSION} · ${runs.length} run(s) without ${SCORING_VERSION} estimates · ${apply ? "APPLY" : "dry run"}`);
  if (!apply) {
    for (const r of runs.slice(0, 20)) console.log(`  would score ${r.id as string} ${r.label as string}`);
    await sql.end();
    return;
  }
  let scored = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const r of runs) {
    try {
      await computeScores(r.id as string, { publishMovement: false, writeLegacy: false });
      scored += 1;
    } catch (err) {
      skipped.push({ id: r.id as string, reason: err instanceof Error ? err.message : "unknown" });
    }
  }
  console.log(`scored ${scored}; skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
