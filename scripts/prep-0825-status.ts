/**
 * Read-only prep status for the 2026-08-25 AM send batch:
 *   A. JC contacted prospects (batch 1) — behavioral intent + recommended action
 *   B. JC batch-2 draft inventory (approved-unsent, pending)
 *   C. Wilmington DE readiness — run, findings, audits, contacts, drafts
 *   D. Send-machine health — gmail status, trailing-24h cap usage
 * No writes. `npx tsx scripts/prep-0825-status.ts`
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { prospectFacts } from "@/lib/prospects/dashboard";
import { deriveIntent, compareByPriority } from "@/lib/prospects/intent";
import { GMAIL_DAILY_SEND_CAP } from "@/lib/prospects/constants";

async function main(): Promise<void> {
  const now = new Date();
  const launches = await sql`
    select id, name from market_launches
    where name ilike '%jersey%' or name ilike '%wilmington%'`;
  console.log("LAUNCHES:", launches.map((l) => `${l.name} (${(l.id as string).slice(0, 8)})`).join(" | "));
  const jc = launches.find((l) => (l.name as string).toLowerCase().includes("jersey"));
  const wil = launches.find((l) => (l.id as string).startsWith("c0bd8d88"));
  if (!jc) throw new Error("JC launch not found");

  // A. JC contacted prospects — intent
  const facts = await prospectFacts({ launchId: jc.id as string });
  const contacted = facts.filter((f) => f.sentAts.length > 0).map((f) => deriveIntent(f, now));
  contacted.sort(compareByPriority);
  console.log(`\n=== A. JC CONTACTED (${contacted.length}) ===`);
  for (const p of contacted) {
    const e = p.engagement;
    console.log(JSON.stringify({
      name: p.businessName, id: p.prospectId.slice(0, 8), stage: p.stage,
      quality: p.qualityScore, touches: p.sales.touches,
      lastSent: p.sales.lastSentAt?.toISOString(), replied: p.sales.replied,
      opens: p.opens, views: e.postOutreachViews, sessions: e.sessions,
      engagedSec: e.engagedSeconds, scroll: e.maxScrollPercent,
      competitors: e.competitorSectionViewed, evidence: e.evidenceExpanded,
      cta: e.ctaClicked, attribution: e.attribution,
      lastActivity: e.lastActivityAt?.toISOString(),
      label: p.intentLabel, score: p.intentScore, tier: p.priorityTier,
      followUpDue: p.followUpDue, action: p.recommendedAction,
    }));
  }

  // B. JC draft inventory (unsent)
  const jcDrafts = await sql`
    select p.business_name, d.id, d.channel, d.status, d.version,
      d.scheduled_send_at, d.last_send_error,
      (select count(*)::int from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as sent
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where p.launch_id = ${jc.id} and d.sent_recorded_at is null
      and d.status in ('draft','approved') and p.archived_at is null
    order by p.business_name, d.version desc`;
  console.log(`\n=== B. JC UNSENT DRAFTS (${jcDrafts.length}) ===`);
  for (const d of jcDrafts)
    console.log(`${d.businessName} v${d.version} ${d.channel} ${d.status} sched=${d.scheduledSendAt ?? "-"} priorSends=${d.sent} err=${d.lastSendError ?? "-"}`);

  // C. Wilmington readiness
  if (wil) {
    const run = await sql`
      select id, status from runs where id::text like '66af5cdb%'`;
    console.log(`\n=== C. WILMINGTON (${(wil.id as string).slice(0, 8)}) ===`);
    console.log("run:", run.map((r) => `${(r.id as string).slice(0, 8)} ${r.status}`).join() || "not found");
    const rows = await sql`
      select p.business_name, p.stage, p.qualification_score,
        (select count(*)::int from prospect_findings f where f.prospect_id = p.id and f.status = 'approved') as findings,
        exists(select 1 from prospect_findings f where f.prospect_id = p.id and f.is_primary and f.status = 'approved') as has_primary,
        exists(select 1 from prospect_audits a where a.prospect_id = p.id and a.status = 'published') as published,
        (select count(*)::int from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null and c.email is not null) as contacts,
        (select count(*)::int from outreach_drafts d where d.prospect_id = p.id and d.sent_recorded_at is null and d.status in ('draft','approved')) as drafts,
        (select count(*)::int from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as sent
      from prospects p
      where p.launch_id = ${wil.id} and p.archived_at is null
      order by p.qualification_score desc nulls last`;
    console.log(`prospects: ${rows.length}`);
    for (const r of rows)
      console.log(`${r.businessName} | stage=${r.stage} q=${r.qualificationScore} findings=${r.findings} primary=${r.hasPrimary} audit=${r.published} contacts=${r.contacts} drafts=${r.drafts} sent=${r.sent}`);
  } else console.log("\n=== C. WILMINGTON launch c0bd8d88 not found ===");

  // D. Machine health
  const { machineHealth } = await import("@/lib/prospects/dashboard");
  const h = await machineHealth();
  console.log(`\n=== D. HEALTH ===`);
  console.log(JSON.stringify({ ...h, cap: GMAIL_DAILY_SEND_CAP }));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
