/**
 * Spec 124 data pass — purchased RealTrends dataset operations.
 *
 * Usage:
 *   npx tsx scripts/ingest-realtrends.ts import --file "<workbook.xlsx | rows.json>"
 *   npx tsx scripts/ingest-realtrends.ts match
 *   npx tsx scripts/ingest-realtrends.ts review
 *   npx tsx scripts/ingest-realtrends.ts confirm --record <id> --company <id|none>
 *
 * `import` converts an .xlsx via scripts/realtrends-xlsx-to-json.py into the
 * gitignored .local-data/realtrends/ working dir, then loads it (idempotent —
 * a rerun of the same workbook inserts nothing). `match` resolves records
 * onto canonical companies per market. `review` lists ambiguous matches for
 * a human; `confirm` records the human's decision (company "none" rejects).
 * The licensed workbook itself is read in place and never copied into a
 * tracked path.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import {
  confirmDatasetMatch,
  importDatasetRows,
  matchDatasetRecords,
  setMarketState,
  type ParsedSheetJson,
} from "@/lib/prospects/realtrends-dataset";

const LOCAL_DIR = ".local-data/realtrends";

/** Scripts act as the operator on record (the city-prep.ts pattern). */
async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  if (!u) throw new Error("Operator user not found.");
  return {
    id: u.id as string,
    email: u.email as string,
    name: u.name as string,
    role: u.role as CurrentUser["role"],
  };
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function importCommand(): Promise<void> {
  const file = arg("--file");
  if (!file) throw new Error('import requires --file "<workbook.xlsx | rows.json>"');
  let jsonPath = file;
  if (file.toLowerCase().endsWith(".xlsx")) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    jsonPath = join(LOCAL_DIR, "records.json");
    execFileSync("python3", ["scripts/realtrends-xlsx-to-json.py", file, jsonPath], {
      stdio: "inherit",
    });
  }
  if (!existsSync(jsonPath)) throw new Error(`No such file: ${jsonPath}`);
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as {
    sheets: ParsedSheetJson[];
  };
  const user = await operatorUser();
  const result = await importDatasetRows(user, parsed.sheets);
  if (!result.ok) throw new Error(result.error.message);
  const { parsed: n, imported, duplicates, rejected } = result.data;
  console.log(`Parsed ${n} rows · imported ${imported} · duplicates skipped ${duplicates}`);
  for (const [reason, count] of Object.entries(rejected)) {
    console.log(`rejected ${reason}: ${count}`);
  }
}

async function matchCommand(): Promise<void> {
  const user = await operatorUser();
  const result = await matchDatasetRecords(user);
  if (!result.ok) throw new Error(result.error.message);
  const c = result.data;
  console.log(
    `Considered ${c.consideredRecords} in-market records · high-confidence ${c.highConfidence} · review ${c.reviewRequired} · conflict ${c.conflict} · unmatched ${c.unmatched}`
  );
  if (c.launchesWithoutState.length > 0) {
    console.log(
      `Launches skipped (no resolvable state — add a city pipeline row or an RT signal with state): ${c.launchesWithoutState.join(", ")}`
    );
  }
}

async function reviewCommand(): Promise<void> {
  const rows = await sql`
    select r.id, r.entity_name, r.entity_type, r.city, r.state, r.brokerage,
      r.match_status, r.match_confidence, r.match_detail, c.name as company_name
    from realtrends_records r
    left join companies c on c.id = r.company_id
    where r.match_status in ('review_required', 'conflict')
    order by r.state, r.city, r.entity_name
  `;
  for (const r of rows) {
    const detail = r.matchDetail as {
      reason?: string;
      candidates?: { companyId: string; name: string; confidence: number }[];
    } | null;
    console.log(
      `${r.id}  [${r.matchStatus}] ${r.entityName} (${r.entityType}, ${r.city}, ${r.state}, ${r.brokerage ?? "—"})`
    );
    console.log(`    reason: ${detail?.reason ?? "—"}`);
    for (const cand of detail?.candidates ?? []) {
      console.log(`    candidate ${cand.companyId}  ${cand.name}  (${cand.confidence})`);
    }
  }
  console.log(`\n${rows.length} records need review. Resolve with:`);
  console.log(`  npx tsx scripts/ingest-realtrends.ts confirm --record <id> --company <id|none>`);
}

async function confirmCommand(): Promise<void> {
  const recordId = arg("--record");
  const company = arg("--company");
  if (!recordId || !company) {
    throw new Error("confirm requires --record <id> --company <id|none>");
  }
  const user = await operatorUser();
  const result = await confirmDatasetMatch(user, {
    recordId,
    companyId: company === "none" ? null : company,
  });
  if (!result.ok) throw new Error(result.error.message);
  console.log(`${result.data.recordId} → ${result.data.status}`);
}

async function geoCommand(): Promise<void> {
  const market = arg("--market");
  const state = arg("--state");
  if (!market || !state) throw new Error("geo requires --market <name> --state <code>");
  const user = await operatorUser();
  const result = await setMarketState(user, { marketName: market, state });
  if (!result.ok) throw new Error(result.error.message);
  console.log(`Market ${market} → state ${result.data.state}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "import") await importCommand();
  else if (command === "match") await matchCommand();
  else if (command === "review") await reviewCommand();
  else if (command === "confirm") await confirmCommand();
  else if (command === "geo") await geoCommand();
  else {
    console.error(
      "Usage: import --file <xlsx|json> | match | review | confirm --record <id> --company <id|none> | geo --market <name> --state <code>"
    );
    process.exit(1);
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
