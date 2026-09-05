/**
 * Spec 130: cohort audit for the lead-agent alias failure mode.
 *
 * For every competitive-mismatch prospect (any Touch 1 draft, sent or not)
 * and its frozen competitor, derive the verified RealTrends relationship,
 * scan the SAME frozen run for answers that name the lead agent without a
 * current mention row, and bucket the prospect. With --apply: write the
 * aliases through the registry, re-resolve ONLY the uncredited answers
 * (`parseCompanyIntoRun`, append-only revisions, same 256 answers), recount
 * with the canonical counter, record an evidence correction for delivered
 * Touch 1s, retire unsent drafts that restate the old counts and pause the
 * follow-up sequence. Nothing is sent; nothing historical is edited.
 *
 * Run: npx tsx scripts/entity-alias-audit.ts [--apply] [--prospect <uuid>] [--json <path>]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { parseCompanyIntoRun } from "@/lib/parsing/service";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { applyVerifiedAliases, deriveLeadAgentAliases, leadAgentRelationships, type AliasDerivation } from "@/lib/prospects/entity-aliases";
import { recordEvidenceCorrection, retireDraftsStatingOriginal, type EvidenceCorrection } from "@/lib/prospects/evidence-corrections";
import { deliveredTouch1, pauseFollowupSequence, sequenceForProspect } from "@/lib/prospects/followups";
import { mismatchStrength, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const APPLY = process.argv.includes("--apply");
const pi = process.argv.indexOf("--prospect");
const ONLY = pi >= 0 ? process.argv[pi + 1]! : null;
const ji = process.argv.indexOf("--json");
const JSON_OUT = ji >= 0 ? process.argv[ji + 1]! : null;
const PROVIDER = "openai";

type Bucket = "UNAFFECTED" | "CORRECTED_BUT_STILL_ELIGIBLE" | "MATERIAL_COUNT_CHANGE" | "NO_LONGER_ELIGIBLE" | "NEEDS_HUMAN_REVIEW";

interface Side {
  companyId: string;
  name: string;
  derivation: AliasDerivation;
  aliases: string[];
  /** Answers naming an alias with no current mention row for the company. */
  uncredited: number;
  applied: string[];
  inserted: number;
  before: number;
  after: number;
}
interface Row {
  prospectId: string;
  businessName: string;
  sent: boolean;
  draftStatus: string;
  runId: string;
  answerCount: number;
  sequenceStatus: string | null;
  prospect: Side;
  competitor: Side;
  gapBefore: number;
  gapAfter: number;
  tierBefore: string;
  tierAfter: string | null;
  eligibleAfter: boolean | null;
  bucket: Bucket;
  notes: string[];
  correctionId: string | null;
  retiredDrafts: number;
  sequencePaused: boolean;
}

async function operatorUser(): Promise<CurrentUser> {
  // The founder's operator row (the actor on every cohort contact/send); an
  // active fallback only for environments without it.
  const [u] = await sql`select id, email, name, role from users where active order by (id = '2a01d915-35ad-40bb-94cc-78a86d3619ba') desc, created_at asc limit 1`;
  if (!u) throw new Error("no active user");
  return { id: u.id as string, email: u.email as string, name: (u.name as string | null) ?? null, role: u.role as CurrentUser["role"] } as CurrentUser;
}

function wordRegex(name: string): string {
  return `\\m${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\M`;
}

async function uncreditedAnswers(runId: string, companyId: string, aliases: string[]): Promise<number> {
  if (aliases.length === 0) return 0;
  const patterns = aliases.map(wordRegex);
  const [r] = await sql`
    select count(*)::int as n from responses r
    where r.run_id = ${runId} and r.provider = ${PROVIDER} and r.error is null
      and exists (select 1 from unnest(${patterns}::text[]) p where r.response_text ~* p)
      and not exists (select 1 from mentions m where m.response_id = r.id and m.company_id = ${companyId})
  `;
  return Number(r?.n ?? 0);
}

async function side(companyId: string, fallbackName: string, runId: string): Promise<Side> {
  const [rel] = await leadAgentRelationships([companyId]);
  const derivation: AliasDerivation = rel ? deriveLeadAgentAliases(rel) : { status: "none", reason: "company not found" };
  const aliases = derivation.status === "aliases" ? derivation.aliases : [];
  const uncredited = await uncreditedAnswers(runId, companyId, aliases);
  return { companyId, name: rel?.companyName ?? fallbackName, derivation, aliases, uncredited, applied: [], inserted: 0, before: 0, after: 0 };
}

function eligibleAfter(s: MismatchEvidenceSnapshot, p: number, c: number): boolean {
  const gap = c - p;
  const ratio = s.competitor.productionRatio;
  return gap >= MISMATCH_THRESHOLDS.minRecommendationGap && (ratio === null || ratio <= MISMATCH_THRESHOLDS.maxCompetitorProductionRatio);
}

async function main(): Promise<void> {
  const user = await operatorUser();
  const cohort = await sql`
    with t1 as (
      select distinct on (d.prospect_id) d.prospect_id, d.id as draft_id, d.status, d.evidence_snapshot as snap,
        exists (select 1 from prospect_outreach_sends s where s.draft_id = d.id and s.allowed) as sent
      from outreach_drafts d where d.prompt_version like 'competitive_mismatch%' and d.evidence_snapshot is not null
      order by d.prospect_id, d.created_at desc)
    select t1.prospect_id, p.business_name, p.company_id, t1.status as draft_status, t1.sent, t1.snap,
      (select status from outreach_followup_sequences q where q.prospect_id = p.id) as seq_status
    from t1 join prospects p on p.id = t1.prospect_id
    where ${ONLY}::uuid is null or t1.prospect_id = ${ONLY}
    order by p.business_name
  `;
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · ${cohort.length} mismatch prospects · acting as ${user.email}`);
  const rows: Row[] = [];
  for (const r of cohort) {
    const snap = r.snap as MismatchEvidenceSnapshot;
    const t1 = await deliveredTouch1(r.prospectId as string).catch(() => null);
    // Delivered prospects: the SENT Touch 1's frozen evidence is the claim to audit.
    const s = t1?.originalSnapshot ?? snap;
    const sent = Boolean(t1);
    const notes: string[] = [];
    const pros = await side(s.prospect.companyId, s.prospect.name, s.runId);
    const comp = await side(s.competitor.companyId, s.competitor.name, s.runId);
    pros.before = s.prospect.recommendationCount; comp.before = s.competitor.recommendationCount;
    pros.after = pros.before; comp.after = comp.before;
    const row: Row = {
      prospectId: r.prospectId as string, businessName: r.businessName as string, sent, draftStatus: r.draftStatus as string,
      runId: s.runId, answerCount: s.answerCount, sequenceStatus: (r.seqStatus as string | null) ?? null,
      prospect: pros, competitor: comp, gapBefore: comp.before - pros.before, gapAfter: comp.before - pros.before,
      tierBefore: mismatchStrength({ productionRatio: s.competitor.productionRatio, recommendationGap: comp.before - pros.before }),
      tierAfter: null, eligibleAfter: null, bucket: "UNAFFECTED", notes, correctionId: null, retiredDrafts: 0, sequencePaused: false,
    };
    for (const sd of [pros, comp]) {
      if (sd.derivation.status === "ENTITY_REVIEW_REQUIRED") notes.push(`${sd.name}: ${sd.derivation.reason}`);
    }
    const potentially = pros.uncredited + comp.uncredited > 0;
    const review = [pros, comp].some((sd) => sd.derivation.status === "ENTITY_REVIEW_REQUIRED");
    if (!APPLY && !potentially) {
      row.bucket = review ? "NEEDS_HUMAN_REVIEW" : "UNAFFECTED";
    } else if (!APPLY) {
      row.bucket = "NEEDS_HUMAN_REVIEW";
      notes.push(`dry run: ${pros.uncredited} uncredited answers name ${pros.name}'s lead; ${comp.uncredited} name ${comp.name}'s lead`);
    } else {
      // 1. aliases through the registry (collision-checked, audited).
      for (const sd of [pros, comp]) {
        if (sd.derivation.status !== "aliases" || sd.uncredited === 0) continue;
        const applied = await applyVerifiedAliases(user, sd.companyId);
        sd.applied = applied.added;
        if (applied.refused) { notes.push(`${sd.name}: alias refused: ${applied.refused}`); sd.derivation = applied.derivation; continue; }
        // 2. re-resolve only the answers that name the alias and have no row.
        const res = await parseCompanyIntoRun(s.runId, sd.companyId);
        sd.inserted = res.inserted;
        notes.push(`${sd.name}: aliases ${JSON.stringify(sd.applied)} · scanned ${res.scanned} · alias hits ${res.hits} · rows added ${res.inserted} (recommended ${res.recommended})`);
      }
      // 3. canonical recount on the same run — always, because a shared
      // competitor may have been re-resolved by an earlier row.
      const counts = await providerRecommendationCounts(s.runId, PROVIDER, [pros.companyId, comp.companyId]);
      if (counts.answerCount !== s.answerCount) notes.push(`DENOMINATOR DRIFT ${s.answerCount} → ${counts.answerCount}`);
      pros.after = counts.recommendedByCompany[pros.companyId] ?? 0;
      comp.after = counts.recommendedByCompany[comp.companyId] ?? 0;
      row.gapAfter = comp.after - pros.after;
      row.tierAfter = mismatchStrength({ productionRatio: s.competitor.productionRatio, recommendationGap: row.gapAfter });
      row.eligibleAfter = eligibleAfter(s, pros.after, comp.after);
      const changed = pros.after !== pros.before || comp.after !== comp.before;
      if (!changed) row.bucket = review ? "NEEDS_HUMAN_REVIEW" : "UNAFFECTED";
      else if (!row.eligibleAfter) row.bucket = "NO_LONGER_ELIGIBLE";
      else if (sent) row.bucket = "MATERIAL_COUNT_CHANGE";
      else row.bucket = "CORRECTED_BUT_STILL_ELIGIBLE";
      // 4. provenance for delivered Touch 1s; retire unsent restatements; pause.
      if (changed && t1) {
        const aliasesAdded: EvidenceCorrection["entityResolutionChange"]["aliasesAdded"] = {};
        const mentionRowsAdded: Record<string, number> = {};
        for (const sd of [pros, comp]) {
          if (sd.applied.length) aliasesAdded[sd.companyId] = { aliases: sd.applied, realtrendsRecordId: sd.derivation.status === "aliases" ? sd.derivation.provenance.realtrendsRecordId : null };
          if (sd.inserted) mentionRowsAdded[sd.companyId] = sd.inserted;
        }
        const rec = await recordEvidenceCorrection(user, {
          prospectId: row.prospectId, evidenceDraftId: t1.evidenceDraftId, sendId: t1.sendId, original: t1.originalSnapshot,
          reason: "Spec 130: verified lead-agent alias (RealTrends team lead) credited answers that named the person; re-resolved against the same frozen run.",
          change: { aliasesAdded, mentionRowsAdded },
        });
        row.correctionId = rec.correction?.id ?? null;
        if (rec.correction) row.retiredDrafts = (await retireDraftsStatingOriginal(row.prospectId, rec.correction)).length;
      } else if (changed) {
        const retired = await sql`
          update outreach_drafts set status = 'superseded', scheduled_send_at = null, send_claimed_at = null,
            last_send_error = ${"Spec 130: frozen counts superseded by corrected entity resolution; regenerate from corrected evidence."}
          where prospect_id = ${row.prospectId} and status = 'approved' and sent_recorded_at is null and evidence_snapshot is not null
          returning id`;
        row.retiredDrafts = retired.length;
      }
      if (changed) {
        const seq = await sequenceForProspect(row.prospectId);
        if (seq && seq.status === "active") {
          const paused = await pauseFollowupSequence(user, { sequenceId: seq.id, reason: `Spec 130 evidence correction: counts ${pros.before}/${comp.before} → ${pros.after}/${comp.after}; resume after review` });
          row.sequencePaused = paused.ok;
        }
      }
    }
    rows.push(row);
    console.log(`${row.bucket.padEnd(30)} ${row.businessName.padEnd(36)} sent=${sent ? "y" : "n"} ${pros.before}→${pros.after} vs ${comp.before}→${comp.after} (gap ${row.gapBefore}→${row.gapAfter})${notes.length ? " · " + notes.join(" | ") : ""}`);
  }
  const summary: Record<Bucket, number> = { UNAFFECTED: 0, CORRECTED_BUT_STILL_ELIGIBLE: 0, MATERIAL_COUNT_CHANGE: 0, NO_LONGER_ELIGIBLE: 0, NEEDS_HUMAN_REVIEW: 0 };
  for (const r of rows) summary[r.bucket] += 1;
  console.log("\nSUMMARY", JSON.stringify(summary));
  console.log(`potentially affected (uncredited alias answers > 0): ${rows.filter((r) => r.prospect.uncredited + r.competitor.uncredited > 0).length}; total uncredited answers: ${rows.reduce((n, r) => n + r.prospect.uncredited + r.competitor.uncredited, 0)}`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ apply: APPLY, at: new Date().toISOString(), summary, rows }, null, 1));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
