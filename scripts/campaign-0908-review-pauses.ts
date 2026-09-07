/**
 * Campaign week 2026-09-08: fail-closed handling of sequences whose sent
 * Touch 1 evidence was corrected (spec 130) or whose entity resolution
 * cannot be verified (single-name RealTrends team lead). Enrolls the one
 * out-of-office prospect the cohort enroller skips (canonical OOO pause),
 * pauses every ACTIVE sequence with a material correction or an
 * unverifiable lead alias, and prints the founder-review classification
 * for all of them. Nothing is sent, nothing historical is edited.
 *
 * Run: npx tsx scripts/campaign-0908-review-pauses.ts [--dry]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { enrollFollowupSequence, pauseFollowupSequence, sequenceForProspect } from "@/lib/prospects/followups";
import { mismatchStrength, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const dry = process.argv.includes("--dry");
const OOO_PROSPECT_NAME = "Michelle Corley";
const SINGLE_NAME_LEADS = ["Christina Valkanoff Realty Group", "Pink Team", "Damian Hall Team"];

type Cls = "SAFE_TO_RESUME" | "CORRECTED_STILL_ELIGIBLE" | "MATERIAL_SENT_CLAIM_ERROR" | "NO_LONGER_ELIGIBLE" | "HUMAN_REVIEW_REQUIRED";

function eligible(s: MismatchEvidenceSnapshot): boolean {
  const gap = s.competitor.recommendationCount - s.prospect.recommendationCount;
  const ratio = s.competitor.productionRatio;
  return gap >= MISMATCH_THRESHOLDS.minRecommendationGap && (ratio === null || ratio <= MISMATCH_THRESHOLDS.maxCompetitorProductionRatio);
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  const rows: string[] = [];

  // 1. Out-of-office prospect: enroll so the canonical OOO pause governs it.
  const [ooo] = await sql`select id from prospects where business_name = ${OOO_PROSPECT_NAME}`;
  if (ooo) {
    const existing = await sequenceForProspect(ooo.id as string);
    if (existing) rows.push(`OOO ${OOO_PROSPECT_NAME}: already enrolled (${existing.status}${existing.pausedUntil ? ` until ${existing.pausedUntil.toISOString()}` : ""})`);
    else if (dry) rows.push(`OOO ${OOO_PROSPECT_NAME}: would enroll`);
    else {
      const r = await enrollFollowupSequence(user, { prospectId: ooo.id as string });
      rows.push(`OOO ${OOO_PROSPECT_NAME}: ${r.ok ? `enrolled → ${r.data.status}` : `enroll refused: ${r.error.message}`}`);
      if (r.ok) { const s = await sequenceForProspect(ooo.id as string); rows.push(`    status ${s?.status} paused_until ${s?.pausedUntil?.toISOString() ?? "-"} reason ${s?.pauseReason ?? "-"}`); }
    }
  }

  // 2. Corrected sent claims (spec 130 ledger): classify + pause active ones.
  const corr = await sql`
    select c.prospect_id, p.business_name, p.stage, c.original_snapshot, c.corrected_snapshot, c.send_id
    from outreach_evidence_corrections c join prospects p on p.id = c.prospect_id
    order by p.business_name`;
  const summary: Record<Cls, number> = { SAFE_TO_RESUME: 0, CORRECTED_STILL_ELIGIBLE: 0, MATERIAL_SENT_CLAIM_ERROR: 0, NO_LONGER_ELIGIBLE: 0, HUMAN_REVIEW_REQUIRED: 0 };
  rows.push("", "CLASSIFICATION (sent Touch 1 evidence vs corrected, same frozen run)");
  for (const c of corr) {
    const o = c.originalSnapshot as MismatchEvidenceSnapshot, n = c.correctedSnapshot as MismatchEvidenceSnapshot;
    const seq = await sequenceForProspect(c.prospectId as string);
    const changed = o.prospect.recommendationCount !== n.prospect.recommendationCount || o.competitor.recommendationCount !== n.competitor.recommendationCount;
    let cls: Cls;
    if (seq?.status === "replied") cls = "SAFE_TO_RESUME"; // replied: out of cold automation regardless
    else if (!changed) cls = "SAFE_TO_RESUME";
    else if (!eligible(n)) cls = "NO_LONGER_ELIGIBLE";
    else cls = "MATERIAL_SENT_CLAIM_ERROR";
    summary[cls] += 1;
    const dir = n.competitor.recommendationCount - n.prospect.recommendationCount;
    const note = seq?.status === "replied" ? "replied; out of cold sequence" :
      cls === "NO_LONGER_ELIGIBLE" ? "corrected counts fail the mismatch gate; sent claim was wrong" :
      o.prospect.recommendationCount === n.prospect.recommendationCount ? "direction unchanged; competitor count understated in Touch 1" : "prospect count understated in Touch 1";
    rows.push(`${cls.padEnd(26)} ${(c.businessName as string).padEnd(40)} sent ${o.prospect.recommendationCount}/${o.competitor.recommendationCount} of ${o.answerCount} → ${n.prospect.recommendationCount}/${n.competitor.recommendationCount} (gap ${dir}, ${mismatchStrength({ productionRatio: n.competitor.productionRatio, recommendationGap: dir })}) · seq ${seq?.status ?? "none"} T${seq?.nextTouch ?? "-"} · ${note}`);
    if (seq && seq.status === "active" && cls !== "SAFE_TO_RESUME") {
      const reason = `${cls}: Spec 130 evidence correction ${o.prospect.recommendationCount}/${o.competitor.recommendationCount} → ${n.prospect.recommendationCount}/${n.competitor.recommendationCount} of ${n.answerCount}; sent Touch 1 states the original; founder review before any follow-up`;
      if (dry) rows.push(`    would pause: ${reason}`);
      else { const r = await pauseFollowupSequence(user, { sequenceId: seq.id, reason: reason.slice(0, 300) }); rows.push(`    ${r.ok ? "PAUSED" : "pause refused: " + r.error.message}`); }
    }
  }

  // 3. Single-name team leads: alias unverifiable → possible undercount of the
  // prospect's own count; fail closed for founder review. Report how many
  // frozen-run answers name the prospect's leader (from prospects.team_leader,
  // read-only probe, NOT applied as an alias).
  rows.push("", "HUMAN_REVIEW_REQUIRED (single-name RealTrends team lead; alias not derivable)");
  for (const name of SINGLE_NAME_LEADS) {
    const [p] = await sql`select p.id, p.team_leader, p.company_id from prospects p where p.business_name = ${name}`;
    if (!p) { rows.push(`  ${name}: prospect not found`); continue; }
    const seq = await sequenceForProspect(p.id as string);
    const leader = ((p.teamLeader as string | null) ?? "").trim();
    let probe = "no two-token leader name on the prospect";
    if (seq && leader.split(/\s+/).length >= 2) {
      const pat = `\\m${leader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\M`;
      const [r] = await sql`
        select count(*)::int as n from responses r
        where r.run_id = ${seq.evidenceSnapshot.runId} and r.provider = ${seq.evidenceSnapshot.provider} and r.error is null
          and r.response_text ~* ${pat}
          and not exists (select 1 from mentions m where m.response_id = r.id and m.company_id = ${p.companyId})`;
      probe = `${r?.n ?? 0} frozen-run answers name "${leader}" without a mention row for the company`;
    }
    summary.HUMAN_REVIEW_REQUIRED += 1;
    rows.push(`  ${name.padEnd(36)} seq ${seq?.status ?? "none"} T${seq?.nextTouch ?? "-"} · ${probe}`);
    if (seq && seq.status === "active") {
      const reason = `HUMAN_REVIEW_REQUIRED: RealTrends team lead is a single name; lead-agent alias cannot be verified (spec 130), so the sent count may be understated; founder review before any follow-up`;
      if (dry) rows.push(`    would pause`);
      else { const r = await pauseFollowupSequence(user, { sequenceId: seq.id, reason }); rows.push(`    ${r.ok ? "PAUSED" : "pause refused: " + r.error.message}`); }
    }
  }
  rows.push("", `SUMMARY ${JSON.stringify(summary)}`);
  console.log(rows.join("\n"));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
