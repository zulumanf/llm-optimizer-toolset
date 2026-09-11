/**
 * Publish (or republish) the private mismatch report for one prospect
 * through the one existing path, then run the deterministic evidence QA and
 * print the serialized report the review agents read. Spec 129's handoff
 * script needs a follow-up sequence; this one does not (spec 130: a prospect
 * who replied to a Saturday Touch 1 before enrollment).
 *
 * Run: npx tsx scripts/publish-report.ts --prospect <uuid> [--apply] [--out <path>]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { mismatchBlockForProspect, type AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";
import { REPORT_HANDOFF } from "@/lib/prospects/constants";
import { deliveredTouch1, prospectEntityType } from "@/lib/prospects/followups";
import { marketShortName } from "@/lib/prospects/mismatch";
import { qaMismatchReport, serializeReportForReview } from "@/lib/prospects/report-handoff";
import { publishAudit } from "@/lib/prospects/service";
import { brandedAuditUrl } from "@/lib/prospects/urls";

const pi = process.argv.indexOf("--prospect");
const prospectId = pi >= 0 ? process.argv[pi + 1]! : null;
const APPLY = process.argv.includes("--apply");
const oi = process.argv.indexOf("--out");
const OUT = oi >= 0 ? process.argv[oi + 1]! : null;

async function operatorUser(): Promise<CurrentUser> {
  // The founder's operator row (the actor on every cohort contact/send); an
  // active fallback only for environments without it.
  const [u] = await sql`select id, email, name, role from users where active order by (id = '2a01d915-35ad-40bb-94cc-78a86d3619ba') desc, created_at asc limit 1`;
  if (!u) throw new Error("no active user");
  return { id: u.id as string, email: u.email as string, name: (u.name as string | null) ?? null, role: u.role as CurrentUser["role"] } as CurrentUser;
}

async function main(): Promise<void> {
  if (!prospectId) throw new Error("--prospect <uuid> required");
  const user = await operatorUser();
  const t1 = await deliveredTouch1(prospectId);
  if (!t1) throw new Error("no delivered mismatch Touch 1");
  const o = t1.originalSnapshot;
  const e = t1.evidenceSnapshot;
  console.log(
    `Touch 1 sent ${t1.sentAt.toISOString()} · frozen ${o.prospect.recommendationCount}/${o.competitor.recommendationCount} of ${o.answerCount}` +
      (t1.correction ? ` · CORRECTED ${e.prospect.recommendationCount}/${e.competitor.recommendationCount} (${t1.correction.id.slice(0, 8)})` : " · no correction")
  );
  let block: AuditMismatchBlock | null = null;
  if (APPLY) {
    let res = await publishAudit(user, { prospectId });
    if (!res.ok) {
      const msg = res.error.message;
      const blocked = msg.match(/Publish blocked by (\d+) disqualification signal\(s\): (.*) — acknowledge with a reason/);
      if (blocked && blocked[1] === "1" && blocked[2]!.includes(REPORT_HANDOFF.autoAckWarningPrefix)) {
        res = await publishAudit(user, { prospectId, acknowledgeWarnings: { reason: `${REPORT_HANDOFF.autoAckReason} Spec 130 corrected republish.` } });
      }
    }
    if (!res.ok) throw new Error(`publish refused: ${res.error.message}`);
    console.log(`published audit ${res.data.auditId} (replaced=${res.data.replaced}) warnings=${JSON.stringify(res.data.warnings)}`);
    const [a] = await sql`select snapshot->'mismatch' as block from prospect_audits where id = ${res.data.auditId}`;
    block = (a?.block as AuditMismatchBlock | null) ?? null;
  } else {
    block = await mismatchBlockForProspect(prospectId);
  }
  if (!block) throw new Error("no mismatch block");
  const [p] = await sql`
    select p.business_name, m.name as market, l.slug, l.key from prospects p
    join market_launches ml on ml.id = p.launch_id join markets m on m.id = ml.market_id
    left join prospect_audit_links l on l.prospect_id = p.id and l.revoked_at is null where p.id = ${prospectId}`;
  if (!p) throw new Error("prospect not found");
  const entityType = await prospectEntityType(e);
  const qa = qaMismatchReport(block, e, entityType);
  console.log(`DETERMINISTIC QA vs effective evidence: ${qa.length ? "FAIL" : "pass"}`);
  for (const x of qa) console.log(`  [${x.check}] ${x.detail}`);
  const url = p.slug && p.key ? brandedAuditUrl(p.slug as string, p.key as string) : null;
  console.log(`branded url: ${url ?? "(APP_URL unset or no link)"}`);
  const serialized = serializeReportForReview(block, { prospectName: p.businessName as string, market: marketShortName(p.market as string) });
  if (OUT) {
    writeFileSync(OUT, serialized);
    console.log(`serialized report → ${OUT}`);
  } else console.log(serialized);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
