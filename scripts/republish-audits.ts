/**
 * Republish live prospect audits (spec-090 rollout, 2026-08-19).
 *
 * Snapshot-side evidence-precision fixes — retitled diagnoses
 * (prospect-diagnosis-v3), topSources actionability categories, authority
 * signal sourceType badges — only appear in snapshots generated AFTER the
 * fix, so every live audit needs one mechanical republish. This script
 * runs the normal publishAudit path for each published, unexpired audit:
 *
 * - The access token is preserved (supersede-in-place, spec 057) — no
 *   prospect link changes.
 * - humanFinding / adoptionStat / expiresAt are carried forward from the
 *   live snapshot; the republish is regeneration, not re-authoring.
 * - preparedBy stays the ORIGINAL publisher (their user row is loaded and
 *   passed as the acting user), so the signature on the page is unchanged.
 * - Stale-benchmark and disqualifying warnings are acknowledged with a
 *   recorded reason naming this rollout — every acknowledgment lands in
 *   the audit log as usual. Hard blocks (running/empty runs, mock data,
 *   evidence-gate mismatches) still refuse; failures are reported and the
 *   sweep continues.
 *
 * Usage:
 *   npx tsx scripts/republish-audits.ts            # dry-run: list what would republish
 *   npx tsx scripts/republish-audits.ts --apply    # do it
 *   npx tsx scripts/republish-audits.ts --apply --prospect <uuid>   # one prospect
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { publishAudit, type AuditSnapshot } from "@/lib/prospects/audits";
import type { CurrentUser } from "@/lib/auth";

const APPLY = process.argv.includes("--apply");
const prospectFlag = process.argv.indexOf("--prospect");
const ONLY_PROSPECT: string | null =
  (prospectFlag !== -1 ? process.argv[prospectFlag + 1] : null) ?? null;

const ACK_REASON =
  "Mechanical republish to apply spec-090 evidence-precision snapshot fixes " +
  "(diagnosis retitles, cited-surface categories, evidence badges); " +
  "measurement basis unchanged.";

async function main(): Promise<void> {
  const rows = await sql`
    select a.id, a.prospect_id, a.expires_at, a.snapshot,
      u.id as user_id, u.email, u.name, u.role
    from prospect_audits a
    join users u on u.id = a.published_by
    where a.status = 'published'
      and (a.expires_at is null or a.expires_at > now())
      and (${ONLY_PROSPECT}::uuid is null or a.prospect_id = ${ONLY_PROSPECT})
    order by a.published_at asc
  `;
  console.log(
    `${rows.length} live audit(s) to republish${APPLY ? "" : " (dry-run — pass --apply)"}`
  );

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const snapshot = row.snapshot as AuditSnapshot;
    const label = `${snapshot.prospectName} (${row.prospectId})`;
    if (!APPLY) {
      console.log(
        `would republish: ${label}` +
          `${snapshot.humanFinding ? " +humanFinding" : ""}` +
          `${snapshot.adoptionStat ? " +adoptionStat" : ""}` +
          `${row.expiresAt ? "" : " [no expiry on file — republish sets the 45-day default]"}`
      );
      continue;
    }
    const publisher: CurrentUser = {
      id: row.userId as string,
      email: row.email as string,
      name: row.name as string,
      role: row.role as CurrentUser["role"],
    };
    const result = await publishAudit(publisher, {
      prospectId: row.prospectId as string,
      ...(row.expiresAt
        ? { expiresAt: new Date(row.expiresAt as Date).toISOString() }
        : {}),
      ...(snapshot.humanFinding ? { humanFinding: snapshot.humanFinding } : {}),
      ...(snapshot.adoptionStat ? { adoptionStat: snapshot.adoptionStat } : {}),
      acknowledgeStale: true,
      acknowledgeWarnings: { reason: ACK_REASON },
    });
    if (result.ok) {
      ok += 1;
      console.log(
        `republished: ${label} (audit ${result.data.auditId}, token ${
          result.data.replaced ? "preserved" : "NEW"
        })${result.data.warnings.length > 0 ? ` — ${result.data.warnings.length} warning(s) acknowledged/logged` : ""}`
      );
      for (const w of result.data.warnings) console.log(`    · ${w}`);
    } else {
      failed += 1;
      console.error(`FAILED: ${label} — ${result.error.message}`);
    }
  }
  if (APPLY) console.log(`done: ${ok} republished, ${failed} failed`);
  await sql.end();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
