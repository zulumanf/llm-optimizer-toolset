/**
 * Spec 129: inspect or run the positive-reply report handoff for one
 * prospect. `--dry` (default) prints the handoff state, the deterministic
 * QA of the published report against the frozen evidence, the serialized
 * report the agents would read, and the delivery email as it would render.
 * `--run` enqueues (if needed) and advances the handoff through the real
 * pipeline (publishes, calls both agents, schedules the reply).
 *
 * Run: npx tsx scripts/report-handoff.ts --prospect <uuid> [--run]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { getFollowupSequence, prospectEntityType, sequenceForProspect, firstNameFrom, footerTailFrom } from "@/lib/prospects/followups";
import {
  advanceReportHandoff, enqueueReportHandoffs, handoffForProspect, lintReportDelivery, qaMismatchReport,
  renderReportDelivery, serializeReportForReview, approvedEvidenceFromBlock,
} from "@/lib/prospects/report-handoff";
import { verifyEvidenceRelease } from "@/lib/prospects/evidence-release";
import { compileFactManifest } from "@/lib/prospects/fact-manifest";
import { marketShortName } from "@/lib/prospects/mismatch";
import { brandedAuditUrl } from "@/lib/prospects/urls";
import type { AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";

const i = process.argv.indexOf("--prospect");
const prospectId = i >= 0 ? process.argv[i + 1] : undefined;
const run = process.argv.includes("--run");

async function main(): Promise<void> {
  if (!prospectId) throw new Error("--prospect <uuid> is required");
  const seq = await sequenceForProspect(prospectId);
  if (!seq) throw new Error("prospect has no follow-up sequence");
  let h = await handoffForProspect(prospectId).catch((e: Error) => {
    if (run) throw e;
    console.log(`handoff table unavailable (${e.message.split("\n")[0]}) — migration 103 not applied here; preview only`);
    return null;
  });
  console.log(`handoff: ${h ? `${h.status} (${h.reason ?? "-"}) attempts ${h.attempts}` : "none"}`);
  if (run) {
    const n = await enqueueReportHandoffs();
    console.log(`enqueued ${n}`);
    h = await handoffForProspect(prospectId);
    if (!h) throw new Error("no positive reply with a Gmail message id on this prospect");
    const after = await advanceReportHandoff(h, new Date());
    console.log(`→ ${after.status} (${after.reason ?? "-"})`);
    const runs = await sql`select kind, passed, left(coalesce(error, output::text), 300) as detail from prospect_report_qa_runs where handoff_id = ${h.id} order by created_at`;
    for (const r of runs) console.log(`  ${r.kind}: ${r.passed ? "pass" : "FAIL"} ${r.detail}`);
  }
  const [a] = await sql`
    select a.snapshot->'mismatch' as block, p.business_name, m.name as market, l.slug, l.key,
      (select body from outreach_drafts where id = ${seq.touch1DraftId}) as t1_body
    from prospect_audits a join prospects p on p.id = a.prospect_id
    join market_launches ml on ml.id = p.launch_id join markets m on m.id = ml.market_id
    left join prospect_audit_links l on l.prospect_id = p.id and l.revoked_at is null
    where a.prospect_id = ${prospectId} and a.status = 'published' limit 1
  `;
  if (!a) { console.log("no published report yet"); await sql.end(); return; }
  const block = a.block as AuditMismatchBlock | null;
  const full = (await getFollowupSequence(seq.id))!;
  const entityTypeForQa = await prospectEntityType(full.evidenceSnapshot);
  const qa = qaMismatchReport(block, full.evidenceSnapshot, entityTypeForQa);
  console.log(`\nDETERMINISTIC QA: ${qa.length ? "FAIL" : "pass"}`);
  for (const x of qa) console.log(`  [${x.check}] ${x.detail}`);
  if (!block) { await sql.end(); return; }
  console.log(`\n--- SERIALIZED REPORT (what the agents read) ---\n${serializeReportForReview(block, { prospectName: a.businessName as string, market: marketShortName(a.market as string) })}`);
  const url = a.slug && a.key ? brandedAuditUrl(a.slug as string, a.key as string) : null;
  const entityType = await prospectEntityType(full.evidenceSnapshot);
  if (url && entityType) {
    const verdict = await verifyEvidenceRelease(full.evidenceSnapshot, { prospectId, sendId: full.touch1SendId });
  const compiled = compileFactManifest({ snapshot: full.evidenceSnapshot, verdict, market: marketShortName(a.market as string), prospectEntityType: entityType, approvedExampleIds: approvedEvidenceFromBlock(block).exampleIds, approvedFirstActionId: approvedEvidenceFromBlock(block).firstActionId });
  if (!compiled.ok) throw new Error(`manifest not compilable: ${compiled.reason}`);
    const r = renderReportDelivery({ firstName: firstNameFrom(a.t1Body as string), brandedUrl: url, manifest: compiled.manifest, footerTail: footerTailFrom(a.t1Body as string) });
    const lint = lintReportDelivery(r.body, url);
    console.log(`\n--- DELIVERY EMAIL (${lint.length ? "LINT FAIL: " + lint.map((x) => x.detail).join(" ") : "lint ok"}) ---\n${r.body}`);
  } else {
    console.log(`\nno delivery preview: url=${url ?? "none (APP_URL / link)"} entityType=${entityType ?? "unknown"}`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
