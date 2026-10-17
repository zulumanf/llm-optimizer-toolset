/**
 * Release 151 scoring cutover (docs/engineering/deployment-checklist-151.md).
 *
 *   npx tsx scripts/scoring-cutover.ts status
 *   npx tsx scripts/scoring-cutover.ts verify
 *   npx tsx scripts/scoring-cutover.ts apply --reason "<why>" [--accept-uncovered] [--accept-differences]
 *   npx tsx scripts/scoring-cutover.ts rollback --reason "<why>"
 *   npx tsx scripts/scoring-cutover.ts retire-legacy --reason "<why>" --confirm
 *
 * `apply` re-runs verification and refuses on gaps unless each class of
 * exception is explicitly accepted. The flip is one transaction; readers
 * pick it up on their next query. Against production this needs the
 * founder's approval.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { scoringState } from "@/db/scores";
import { applyCutover, retireLegacyWriter, rollbackCutover, verifyCutover } from "@/lib/scoring/cutover";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const reason = arg("--reason");
  const who = process.env.USER ?? "operator";
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();
  console.log(`target ${host}`);
  if (command === "status") {
    console.log(await scoringState());
  } else if (command === "verify") {
    const v = await verifyCutover();
    console.log(JSON.stringify({ ...v, parityDifferences: v.parityDifferences.slice(0, 20) }, null, 2));
    process.exitCode = v.ok ? 0 : 1;
  } else if (command === "apply") {
    if (!reason) throw new Error("--reason is required");
    const r = await applyCutover({
      reason,
      changedBy: who,
      acceptUncovered: process.argv.includes("--accept-uncovered"),
      acceptDifferences: process.argv.includes("--accept-differences"),
    });
    console.log(r.applied ? "cutover applied: readers now use v1.2" : `REFUSED: ${r.refusal}`);
    process.exitCode = r.applied ? 0 : 1;
  } else if (command === "rollback") {
    if (!reason) throw new Error("--reason is required");
    await rollbackCutover(reason, who);
    console.log("rolled back: readers use v1.1");
  } else if (command === "retire-legacy") {
    if (!reason || !process.argv.includes("--confirm")) throw new Error("--reason and --confirm are required");
    await retireLegacyWriter(reason, who);
    console.log("legacy v1.1 writer retired");
  } else {
    throw new Error(`unknown command ${command}`);
  }
  await sql.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await sql.end();
  process.exit(1);
});
