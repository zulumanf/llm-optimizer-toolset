/**
 * Campaign week 2026-09-08: CORRECTION_TOUCH previews for sequences paused
 * with a MATERIAL sent-claim error whose corrected evidence still passes the
 * mismatch gate (founder directive 2026-09-06). Facts control wording: the
 * sent numbers come from the delivered Touch 1's frozen snapshot, the
 * corrected numbers from the latest spec 130 correction on the SAME run.
 * Writes previews to a review file. Creates NO drafts, sends NOTHING —
 * founder approval is required before any correction touch exists as a
 * draft. Tracked as EVIDENCE_CORRECTION, never as T2/T3.
 *
 * Run: npx tsx scripts/campaign-0908-correction-previews.ts [--out path]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "@/db/client";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { deliveredTouch1, firstNameFrom, sequenceForProspect } from "@/lib/prospects/followups";
import { lintFollowupCopy } from "@/lib/prospects/followup-templates";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const oi = process.argv.indexOf("--out");
const OUT = oi >= 0 ? process.argv[oi + 1]! : ".local-data/prospecting/campaign-0908/correction-previews.md";

function eligible(s: MismatchEvidenceSnapshot): boolean {
  const gap = s.competitor.recommendationCount - s.prospect.recommendationCount;
  const ratio = s.competitor.productionRatio;
  return gap >= MISMATCH_THRESHOLDS.minRecommendationGap && (ratio === null || ratio <= MISMATCH_THRESHOLDS.maxCompetitorProductionRatio);
}

function render(first: string, o: MismatchEvidenceSnapshot, n: MismatchEvidenceSnapshot, entity: "team" | "individual" | null, footer: string[]): string {
  const you = entity === "team" ? "Your team" : "You";
  const comp = n.competitor.name;
  const N = n.answerCount;
  const prospectChanged = o.prospect.recommendationCount !== n.prospect.recommendationCount;
  const compChanged = o.competitor.recommendationCount !== n.competitor.recommendationCount;
  const what = prospectChanged && compChanged ? "both counts" : prospectChanged ? `the count for ${you.toLowerCase()}` : `the count for ${comp}`;
  return [
    `${first},`, ``,
    `I caught an entity-matching issue while checking these results again, and it changed ${what}.`, ``,
    `My first email said:`,
    `${you}: recommended in ${o.prospect.recommendationCount} of ${N} answers`,
    `${comp}: recommended in ${o.competitor.recommendationCount} of ${N}`, ``,
    `Using the same ${N} answers, the corrected count is:`,
    `${you}: recommended in ${n.prospect.recommendationCount} of ${N} answers`,
    `${comp}: recommended in ${n.competitor.recommendationCount} of ${N}`, ``,
    `The direction of the finding is the same. ${comp} still comes up more often, but I wanted to give you the right numbers rather than repeat the old ones.`, ``,
    `If you want the exact questions, I'll send them.`, ``,
    ...footer,
  ].join("\n");
}

async function main(): Promise<void> {
  const rows = await sql`
    select c.prospect_id, p.business_name, p.stage, c.corrected_snapshot, c.send_id
    from outreach_evidence_corrections c join prospects p on p.id = c.prospect_id
    order by p.business_name`;
  const out: string[] = [`# EVIDENCE_CORRECTION previews — generated ${new Date().toISOString()}`, ``, `Nothing here is a draft. Founder approval required before any of these is created or sent. Separate category from T1/T2/T3.`, ``];
  let prepared = 0, skipped = 0;
  for (const r of rows) {
    const seq = await sequenceForProspect(r.prospectId as string);
    const t1 = await deliveredTouch1(r.prospectId as string).catch(() => null);
    if (!seq || !t1) { skipped += 1; continue; }
    const pausedForCorrection = seq.status === "paused" && /MATERIAL_SENT_CLAIM_ERROR|Spec 130 evidence correction/.test(seq.pauseReason ?? "");
    if (!pausedForCorrection) { skipped += 1; continue; }
    const o = t1.originalSnapshot, n = t1.evidenceSnapshot;
    if (!eligible(n)) { skipped += 1; continue; }
    const [et] = await sql`select entity_type from realtrends_records where id::text = ${n.prospect.productionSignalId}`;
    const entity = (et?.entityType as "team" | "individual" | undefined) ?? null;
    const first = firstNameFrom(t1.body);
    // The signature and compliance footer exactly as the delivered Touch 1 carried them.
    const sepIdx = t1.body.split("\n").findIndex((l) => l.trim() === "--" || l.trim() === "—");
    const footer = sepIdx >= 0 ? t1.body.split("\n").slice(sepIdx) : ["--", "Francisco"];
    const body = render(first, o, n, entity, footer);
    const subject = `Re: ${t1.subject ?? ""}`;
    const lint = lintFollowupCopy(subject, body);
    prepared += 1;
    out.push(`## ${r.businessName}`, ``,
      `- Sent Touch 1: ${t1.sentAt.toISOString().slice(0, 10)} · subject "${t1.subject}" · send ${t1.sendId.slice(0, 8)} (thread reply)`,
      `- Sent claim: ${o.prospect.recommendationCount}/${o.competitor.recommendationCount} of ${o.answerCount} · corrected ${n.prospect.recommendationCount}/${n.competitor.recommendationCount} of ${n.answerCount} · gap ${n.competitor.recommendationCount - n.prospect.recommendationCount} · direction holds: yes`,
      `- Entity level: ${entity ?? "UNKNOWN (fails closed)"} · sequence ${seq.status} (${seq.pauseReason})`,
      `- Copy lint: ${lint.length ? lint.map((i) => `[${i.check}] ${i.detail}`).join(" ") : "pass"}`,
      ``, "```", body, "```", ``);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out.join("\n"));
  console.log(`prepared ${prepared} · skipped ${skipped} · ${OUT}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
