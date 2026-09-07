/**
 * Campaign week 2026-09-08: triage of EVIDENCE_CORRECTION candidates (paused
 * sequences with a material sent-claim correction whose corrected frozen
 * evidence still passes the mismatch gate). Descriptive only, using the
 * existing rules: eligibility thresholds, mismatchStrength (production ratio
 * ≤ 0.8 and gap ≥ 3 = strong), distinct competitor questions, and entity
 * confidence from the RealTrends match + lead-alias derivation. Writes a
 * review table; renders the correction preview for STRONG rows only.
 * Creates no drafts, sends nothing.
 *
 * Run: npx tsx scripts/campaign-0908-correction-triage.ts [--out path]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "@/db/client";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { deriveLeadAgentAliases, leadAgentRelationships } from "@/lib/prospects/entity-aliases";
import { deliveredTouch1, distinctCompetitorQuestions, firstNameFrom, marketTimezone, sequenceForProspect } from "@/lib/prospects/followups";
import { qaStrongCorrection, renderStrongCorrection } from "@/lib/prospects/correction-templates";
import { mismatchStrength, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const oi = process.argv.indexOf("--out");
const OUT = oi >= 0 ? process.argv[oi + 1]! : ".local-data/prospecting/campaign-0908/correction-triage.md";
type Rec = "STRONG_CORRECTION_CANDIDATE" | "VALID_BUT_LOW_PRIORITY" | "STOP" | "HUMAN_REVIEW_REQUIRED";

function eligible(s: MismatchEvidenceSnapshot): boolean {
  const gap = s.competitor.recommendationCount - s.prospect.recommendationCount;
  const ratio = s.competitor.productionRatio;
  return gap >= MISMATCH_THRESHOLDS.minRecommendationGap && (ratio === null || ratio <= MISMATCH_THRESHOLDS.maxCompetitorProductionRatio);
}

/** Entity confidence for one side: RealTrends match status + whether the
 * lead relationship is resolvable (multi-token lead, or an operator-verified alias). */
async function sideConfidence(companyId: string): Promise<{ level: "high" | "medium" | "low"; why: string }> {
  const [rel] = await leadAgentRelationships([companyId]);
  if (!rel) return { level: "low", why: "company not found" };
  const [rt] = await sql`select match_status, entity_type, team_lead from realtrends_records where company_id = ${companyId} order by production_year desc nulls last limit 1`;
  const d = deriveLeadAgentAliases(rel);
  const status = (rt?.matchStatus as string | null) ?? "none";
  if (status !== "high_confidence" && status !== "confirmed") return { level: "low", why: `RealTrends match ${status}` };
  if (d.status === "ENTITY_REVIEW_REQUIRED") {
    const lead = (rel.teamLead ?? "").trim().toLowerCase();
    const manual = lead && rel.existingAliases.some((a) => a.toLowerCase().split(/\s+/)[0] === lead && a.trim().split(/\s+/).length >= 2);
    return manual ? { level: "high", why: `operator-verified alias for lead "${rel.teamLead}"` } : { level: "medium", why: d.reason };
  }
  if (rel.entityType === "team" && !rel.teamLead) return { level: "medium", why: "team without a lead on file" };
  return { level: "high", why: rel.entityType === "team" ? `lead ${rel.teamLead} resolved (${rel.existingAliases.length} aliases)` : "individual record" };
}

// Rendering + QA live in lib/prospects/correction-templates (founder framing 2026-09-06).

interface Row { name: string; market: string; sent: string; pc: number; cc: number; gap: number; prodP: string; prodC: string; ratio: number | null; distinct: number; conf: string; touch: string; rec: Rec; tier: string; why: string; preview: string | null; lint: string }

async function main(): Promise<void> {
  const corr = await sql`
    select c.prospect_id, p.business_name, split_part(l.name, ' —', 1) as market
    from outreach_evidence_corrections c join prospects p on p.id = c.prospect_id join market_launches l on l.id = p.launch_id
    order by p.business_name`;
  const rows: Row[] = [];
  for (const r of corr) {
    const seq = await sequenceForProspect(r.prospectId as string);
    const t1 = await deliveredTouch1(r.prospectId as string).catch(() => null);
    if (!seq || !t1 || seq.status !== "paused" || !/MATERIAL_SENT_CLAIM_ERROR|Spec 130 evidence correction/.test(seq.pauseReason ?? "")) continue;
    const o = t1.originalSnapshot, n = t1.evidenceSnapshot;
    const gap = n.competitor.recommendationCount - n.prospect.recommendationCount;
    const tier = mismatchStrength({ productionRatio: n.competitor.productionRatio, recommendationGap: gap });
    const distinct = await distinctCompetitorQuestions(n);
    const pConf = await sideConfidence(n.prospect.companyId), cConf = await sideConfidence(n.competitor.companyId);
    const conf = pConf.level === "high" && cConf.level === "high" ? "high" : pConf.level === "low" || cConf.level === "low" ? "low" : "medium";
    const [et] = await sql`select entity_type from realtrends_records where id::text = ${n.prospect.productionSignalId}`;
    const entity = (et?.entityType as "team" | "individual" | undefined) ?? null;
    let rec: Rec, why: string;
    if (!eligible(n)) { rec = "STOP"; why = "corrected evidence fails the mismatch gate"; }
    else if (conf !== "high") { rec = "HUMAN_REVIEW_REQUIRED"; why = `entity confidence ${conf}: ${pConf.level !== "high" ? pConf.why : cConf.why}`; }
    else if (!entity) { rec = "HUMAN_REVIEW_REQUIRED"; why = "entity level unknown (you/your team wording fails closed)"; }
    else if (tier === "strong" && distinct >= 3) { rec = "STRONG_CORRECTION_CANDIDATE"; why = `strong tier (ratio ${n.competitor.productionRatio?.toFixed(2)}, gap ${gap}) across ${distinct} distinct questions`; }
    else { rec = "VALID_BUT_LOW_PRIORITY"; why = tier === "strong" ? `strong tier but only ${distinct} distinct competitor questions` : `valid tier only (ratio ${n.competitor.productionRatio?.toFixed(2)}, gap ${gap})`; }
    let preview: string | null = null, lint = "";
    if (rec === "STRONG_CORRECTION_CANDIDATE" && entity) {
      const lines = t1.body.split("\n");
      const sepIdx = lines.findIndex((l) => l.trim() === "--" || l.trim() === "—");
      const { marketName } = await marketTimezone(r.prospectId as string);
      preview = renderStrongCorrection({ firstName: firstNameFrom(t1.body), marketName, entityType: entity, original: o, corrected: n, footer: sepIdx >= 0 ? lines.slice(sepIdx) : ["--", "Francisco"] }).body;
      const issues = qaStrongCorrection(`Re: ${t1.subject ?? ""}`, preview, o, n, { touch1Body: t1.body, entityType: entity, entityConfidence: conf as "high" | "medium" | "low" });
      lint = issues.length ? issues.map((i) => `[${i.check}] ${i.detail}`).join(" ") : "pass";
    }
    rows.push({ name: r.businessName as string, market: r.market as string, sent: `${o.prospect.recommendationCount}/${o.competitor.recommendationCount} of ${o.answerCount}`, pc: n.prospect.recommendationCount, cc: n.competitor.recommendationCount, gap, prodP: n.prospect.productionDisplay, prodC: n.competitor.productionDisplay, ratio: n.competitor.productionRatio, distinct, conf: `${conf} (prospect: ${pConf.why}; competitor: ${cConf.why})`, touch: `next T${seq.nextTouch} (paused)`, rec, tier, why, preview, lint });
  }
  const order: Rec[] = ["STRONG_CORRECTION_CANDIDATE", "VALID_BUT_LOW_PRIORITY", "HUMAN_REVIEW_REQUIRED", "STOP"];
  rows.sort((a, b) => order.indexOf(a.rec) - order.indexOf(b.rec) || (a.ratio ?? 1) - (b.ratio ?? 1) || b.gap - a.gap);
  const out: string[] = [`# EVIDENCE_CORRECTION triage — ${new Date().toISOString()}`, ``, `| PROSPECT | MARKET | ORIGINAL_SENT_CLAIM | CORR_P | CORR_C | GAP | PROD_P | PROD_C | RATIO | DISTINCT_Q | ENTITY_CONF | TOUCH | TIER | RECOMMENDATION | WHY |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`];
  for (const r of rows) out.push(`| ${r.name} | ${r.market} | ${r.sent} | ${r.pc} | ${r.cc} | ${r.gap} | ${r.prodP} | ${r.prodC} | ${r.ratio?.toFixed(2) ?? "-"} | ${r.distinct} | ${r.conf} | ${r.touch} | ${r.tier} | ${r.rec} | ${r.why} |`);
  out.push(``, `## Previews (STRONG only)`, ``);
  for (const r of rows.filter((x) => x.preview)) out.push(`### ${r.name} — lint ${r.lint}`, ``, "```", r.preview!, "```", ``);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out.join("\n"));
  const summary: Record<Rec, number> = { STRONG_CORRECTION_CANDIDATE: 0, VALID_BUT_LOW_PRIORITY: 0, STOP: 0, HUMAN_REVIEW_REQUIRED: 0 };
  for (const r of rows) summary[r.rec] += 1;
  console.log(JSON.stringify(summary));
  for (const r of rows) console.log(`${r.rec.padEnd(27)} ${r.name.padEnd(34)} ${r.market.padEnd(17)} sent ${r.sent.padEnd(14)} → ${r.pc}/${r.cc} gap ${String(r.gap).padStart(2)} · ${r.prodP} vs ${r.prodC} (ratio ${r.ratio?.toFixed(2)}) · ${r.distinct}q · conf ${r.conf.split(" ")[0]} · ${r.tier} · ${r.why}`);
  console.log(`\n${OUT}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
