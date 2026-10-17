/**
 * Copy existing local artifacts into S3-compatible object storage, write-once
 * (release 151 durable artifacts). Dry run by default.
 *
 *   ARTIFACT_STORE=s3 S3_*=… npx tsx scripts/artifacts-sync.ts            # what would upload
 *   ARTIFACT_STORE=s3 S3_*=… npx tsx scripts/artifacts-sync.ts --apply    # upload
 *   ARTIFACT_STORE=s3 S3_*=… DATABASE_URL=… npx tsx scripts/artifacts-sync.ts --audit
 *       # every evidence_artifacts / evidence_exports / knowledge source row
 *       # must exist in the store with its recorded sha256 (read-only)
 *
 * Run on the machine/volume that currently holds the files (the founder's
 * workstation or the current worker volume). Never deletes anything.
 */
import "dotenv/config";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { artifactRoot } from "@/lib/storage/root";
import { objectKeyFor, sha256Of } from "@/lib/storage/content-addressed";
import { getObject, objectStoreConfig, objectStoreEnabled, putObjectOnce } from "@/lib/storage/object-store";

const ROOTS = ["evidence", "knowledge", "video-assets"];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (!name.includes(".part-")) out.push(p);
  }
  return out;
}

async function audit(): Promise<void> {
  const { sql } = await import("@/db/client");
  const rows = [
    ...(await sql`select storage_key, sha256 from evidence_artifacts`).map((r) => ({ root: "evidence", key: r.storageKey as string, sha: r.sha256 as string })),
    ...(await sql`select storage_key, sha256 from evidence_exports where status = 'completed' and storage_key is not null`).map((r) => ({ root: "evidence", key: r.storageKey as string, sha: r.sha256 as string })),
  ];
  let missing = 0;
  let mismatched = 0;
  for (const r of rows) {
    const bytes = await getObject(objectKeyFor(r.root, r.key));
    if (!bytes) missing += 1;
    else if (sha256Of(bytes) !== r.sha) mismatched += 1;
  }
  console.log(`audited ${rows.length} recorded artifacts: missing ${missing}, sha mismatch ${mismatched}`);
  await sql.end();
  process.exitCode = missing + mismatched === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  if (!objectStoreEnabled()) throw new Error("Set ARTIFACT_STORE=s3 and the S3_* variables first.");
  const cfg = objectStoreConfig();
  console.log(`object store ${new URL(cfg.endpoint).host} bucket ${cfg.bucket}${cfg.prefix ? ` prefix ${cfg.prefix}` : ""}`);
  if (process.argv.includes("--audit")) return audit();
  const apply = process.argv.includes("--apply");
  const base = artifactRoot();
  let uploaded = 0;
  let present = 0;
  let total = 0;
  for (const name of ROOTS) {
    const root = join(base, name);
    for (const file of walk(root)) {
      total += 1;
      const key = relative(root, file);
      if (!apply) continue;
      const bytes = readFileSync(file);
      const r = await putObjectOnce(objectKeyFor(root, key), bytes, sha256Of(bytes), cfg);
      if (r === "uploaded") uploaded += 1;
      else present += 1;
    }
  }
  console.log(apply ? `uploaded ${uploaded}, already present ${present}, of ${total} local files` : `dry run: ${total} local files under ${base} would be synced (--apply)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
