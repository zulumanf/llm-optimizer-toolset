/**
 * Reclassify authority-signal evidence (spec-090 rollout, 2026-08-19).
 *
 * Sets prospect_authority_signals.source_type for signals whose source_url
 * matches a substring — the operator correction for coverage discovered to
 * be sponsored/self-reported after ingestion (e.g. Team Moza's Jersey Digs
 * feature). Nothing auto-detects sponsorship: this is a deliberate,
 * per-source human call, recorded in the audit log.
 *
 * The label/value/URL of the signal are untouched — evidence is
 * reclassified, never rewritten. The audit page shows the new badge (and
 * the authority score applies its discount) after the next republish
 * (scripts/republish-audits.ts).
 *
 * Usage:
 *   npx tsx scripts/set-signal-source-type.ts --match jerseydigs.com --type sponsored
 *   npx tsx scripts/set-signal-source-type.ts --match jerseydigs.com --type sponsored --apply
 *   ... optionally --prospect <uuid> to scope to one prospect.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { systemUser } from "@/lib/auth";
import { SIGNAL_SOURCE_TYPES } from "@/lib/prospects/constants";

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}
const MATCH = flag("--match");
const TYPE = flag("--type");
const ONLY_PROSPECT = flag("--prospect");
const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  if (!MATCH || !TYPE) {
    console.error(
      "Usage: tsx scripts/set-signal-source-type.ts --match <url-substring> --type <" +
        SIGNAL_SOURCE_TYPES.join("|") +
        "> [--prospect <uuid>] [--apply]"
    );
    process.exit(1);
  }
  if (!(SIGNAL_SOURCE_TYPES as readonly string[]).includes(TYPE)) {
    console.error(`Unknown source type "${TYPE}" — one of: ${SIGNAL_SOURCE_TYPES.join(", ")}`);
    process.exit(1);
  }

  const rows = await sql`
    select s.id, s.prospect_id, s.kind, s.label, s.source_url, s.source_type,
      p.business_name
    from prospect_authority_signals s
    join prospects p on p.id = s.prospect_id
    where s.source_url ilike ${"%" + MATCH + "%"}
      and (${ONLY_PROSPECT}::uuid is null or s.prospect_id = ${ONLY_PROSPECT})
    order by p.business_name, s.created_at
  `;
  console.log(
    `${rows.length} signal(s) match "${MATCH}"${APPLY ? "" : " (dry-run — pass --apply)"}`
  );
  for (const r of rows) {
    console.log(
      `  ${r.businessName} · ${r.kind} · "${(r.label as string).slice(0, 80)}"` +
        ` · ${r.sourceUrl} · ${r.sourceType ?? "unclassified"} → ${TYPE}`
    );
  }
  if (!APPLY || rows.length === 0) {
    await sql.end();
    return;
  }

  const actor = await systemUser();
  await sql.begin(async (tx) => {
    for (const r of rows) {
      await tx`
        update prospect_authority_signals
        set source_type = ${TYPE}
        where id = ${r.id}
      `;
      await writeAudit(tx, {
        userId: actor.id,
        action: "prospect.signal_reclassify",
        entity: "prospect_authority_signal",
        entityId: r.id as string,
        detail: {
          prospectId: r.prospectId,
          from: r.sourceType ?? null,
          to: TYPE,
          match: MATCH,
          reason: "Operator evidence-classification correction (spec-090 rollout).",
        },
      });
    }
  });
  console.log(`reclassified ${rows.length} signal(s) as "${TYPE}"`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
