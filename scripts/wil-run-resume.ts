/** Resume partial Wilmington run 66af5cdb (openai quota fixed). Read-write: responses only. */
import "dotenv/config";
import { executeRun } from "@/lib/runs/execute";
import { sql } from "@/db/client";
const RUN_ID = "66af5cdb-d8cb-48a5-9646-7b961ee3328e";
async function main() {
  await executeRun(RUN_ID);
  const [run] = await sql`select status, status_detail, cost_usd from runs where id = ${RUN_ID}`;
  if (!run) throw new Error("run not found");
  console.log("final:", run.status, run.statusDetail, "cost", run.costUsd);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
