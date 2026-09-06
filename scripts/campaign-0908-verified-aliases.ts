/**
 * Campaign week 2026-09-08: record team-lead aliases verified on an
 * AUTHORITATIVE public page (the team's own site or the brokerage's agent
 * profile stating the person AND the team together) for RealTrends records
 * whose team_lead is a single name, so spec 130 derivation could not act.
 * Written through the registry (upsertCompany) with an audit row carrying
 * the source URL and quote, then re-resolved on the SAME frozen run(s) the
 * prospect's evidence came from, recounted, and — for a delivered Touch 1 —
 * recorded as an evidence correction when counts changed. Nothing resumes,
 * nothing is scheduled, nothing sends.
 *
 * Run: npx tsx scripts/campaign-0908-verified-aliases.ts [--dry]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { upsertCompany } from "@/lib/companies/service";
import { parseCompanyIntoRun } from "@/lib/parsing/service";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { recordEvidenceCorrection } from "@/lib/prospects/evidence-corrections";
import { deliveredTouch1, sequenceForProspect } from "@/lib/prospects/followups";
import { competitiveMismatchReview, MISMATCH_PROVIDER, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const dry = process.argv.includes("--dry");
const VERIFIED: { business: string; aliases: string[]; sourceUrl: string; quote: string; confidence: string }[] = [
  { business: "Christina Valkanoff Realty Group", aliases: ["Christina Valkanoff"], sourceUrl: "https://cvrealtygroup.com/agents/christina-valkanoff/", quote: "As the founder and lead agent of Christina Valkanoff Realty Group (CVRG), she leads with heart", confidence: "high" },
  { business: "Pink Team", aliases: ["Monica Breckenridge", "Monica M Breckenridge"], sourceUrl: "https://pinkrealty.com/our-team", quote: "Monica Breckenridge is the CEO of Pink Realty and Pink Real Estate.", confidence: "high" },
  { business: "Morton Bradbury Real Estate Group", aliases: ["Tanner Bradbury"], sourceUrl: "https://www.mortonbradbury.com/agents/tanner-bradbury/", quote: "As a Co-Founder of Morton Bradbury Real Estate Group, Tanner Bradbury guides the company's vision and overall growth.", confidence: "high" },
  { business: "Kirsch Team", aliases: ["Laura Kirsch"], sourceUrl: "https://kirschrealestateteam.com/agent/laura-kirsch", quote: "in 2021 she brought on business partner Dilyn Rooker to expand The Kirsch Team's reach and capacity.", confidence: "high" },
  { business: "Behr and Behr of The Platinum Group, Realtors", aliases: ["Ed Behr"], sourceUrl: "https://platinumhomesales.com/agent/ed-behr", quote: "Behr and Behr have designed an intense marketing plan ... The Behrs are pleased to be one of the seven owners/brokers of The Platinum Group.", confidence: "medium (page prints Ed, RealTrends prints Edward)" },
];

function eligible(s: MismatchEvidenceSnapshot, p: number, c: number): boolean {
  const ratio = s.competitor.productionRatio;
  return c - p >= MISMATCH_THRESHOLDS.minRecommendationGap && (ratio === null || ratio <= MISMATCH_THRESHOLDS.maxCompetitorProductionRatio);
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  for (const v of VERIFIED) {
    const [p] = await sql`select p.id, p.company_id, c.name, c.aliases, c.domain, c.market_id from prospects p join companies c on c.id = p.company_id where p.business_name = ${v.business}`;
    if (!p) { console.log(`${v.business}: prospect/company not found`); continue; }
    const existing = (p.aliases as string[]) ?? [];
    const add = v.aliases.filter((a) => !existing.map((x) => x.toLowerCase()).includes(a.toLowerCase()));
    console.log(`\n${v.business} (${p.name}) · existing ${JSON.stringify(existing)} · add ${JSON.stringify(add)} · ${v.confidence} · ${v.sourceUrl}`);
    if (dry) continue;
    if (add.length) {
      const res = await upsertCompany(user, { id: p.companyId as string, name: p.name as string, aliases: [...existing, ...add], ...(p.domain ? { domain: p.domain as string } : {}), marketId: (p.marketId as string | null) ?? null });
      if (!res.ok) { console.log(`  alias refused: ${res.error.message}`); continue; }
      await sql.begin(async (tx) => {
        await writeAudit(tx, { userId: user.id, action: "company.alias_verified", entity: "company", entityId: p.companyId as string,
          detail: { aliases: add, provenance: { kind: "public_page", url: v.sourceUrl, quote: v.quote, confidence: v.confidence, verifiedOn: "2026-09-06", policy: "founder directive 2026-09-06: authoritative full-name verification for single-name RealTrends leads" }, spec: 130 } });
      });
    }
    // Same frozen run: a delivered Touch 1's run, else the live review's run.
    const t1 = await deliveredTouch1(p.id as string).catch(() => null);
    const seq = await sequenceForProspect(p.id as string);
    const review = await competitiveMismatchReview(p.id as string);
    const runId = t1?.originalSnapshot.runId ?? review?.runId ?? null;
    if (!runId) { console.log("  no frozen run"); continue; }
    const res = await parseCompanyIntoRun(runId, p.companyId as string);
    console.log(`  re-resolved on run ${runId.slice(0, 8)}: scanned ${res.scanned} hits ${res.hits} rows added ${res.inserted} (recommended ${res.recommended})`);
    if (t1) {
      const o = t1.originalSnapshot;
      const counts = await providerRecommendationCounts(runId, MISMATCH_PROVIDER, [o.prospect.companyId, o.competitor.companyId]);
      const pa = counts.recommendedByCompany[o.prospect.companyId] ?? 0, ca = counts.recommendedByCompany[o.competitor.companyId] ?? 0;
      const changed = pa !== o.prospect.recommendationCount || ca !== o.competitor.recommendationCount;
      const elig = eligible(o, pa, ca);
      const outcome = !changed ? "VERIFIED_UNCHANGED (sent claim holds; stays paused for founder decision)" : elig ? "PAUSED_SEQUENCE_CORRECTED_STILL_ELIGIBLE" : "NO_LONGER_ELIGIBLE";
      console.log(`  sent ${o.prospect.recommendationCount}/${o.competitor.recommendationCount} of ${o.answerCount} → now ${pa}/${ca} of ${counts.answerCount} · ${outcome} · sequence ${seq?.status ?? "none"}`);
      if (changed) {
        const rec = await recordEvidenceCorrection(user, { prospectId: p.id as string, evidenceDraftId: t1.evidenceDraftId, sendId: t1.sendId, original: o,
          reason: "Founder directive 2026-09-06: team-lead alias verified on an authoritative public page; re-resolved against the same frozen run.",
          change: { aliasesAdded: { [p.companyId as string]: { aliases: add, realtrendsRecordId: null } }, mentionRowsAdded: { [p.companyId as string]: res.inserted } } });
        console.log(`  correction recorded: ${rec.correction?.id?.slice(0, 8) ?? "none"}`);
      }
    } else {
      const after = await competitiveMismatchReview(p.id as string);
      const e = after?.evaluation;
      console.log(`  T1 candidate: ${e?.eligible && e.selected ? `NEW_T1_ELIGIBLE vs ${e.selected.displayName} gap ${e.selected.recommendationGap}` : `not eligible (${e?.reasonCodes.join(",") ?? "no review"})`} · prospect count now ${after?.prospect.recommendationCount}`);
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
