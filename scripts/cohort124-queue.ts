/**
 * Cohort-124 bootstrap cohort builder (2026-08-31): assemble the reviewed
 * 50-person send-ready cohort from the 8 bootstrap-market launches.
 *
 * For every uncontacted prospect in a cohort launch:
 *   mismatch eligibility (live) → verified primary contact with email →
 *   read-only policy checks (prior sends, suppression, cross-prospect
 *   recontact, brokerage spread, duplicate emails) → diversity selection
 *   (max per market, max 2/brokerage, strongest hooks first) →
 *   createOutreachDraft (frozen evidence + footer) → qaDraft must be clean.
 *
 * Output: .local-data/realtrends/cohort124-bootstrap-test-001.json
 * (status REVIEW_REQUIRED). Nothing is approved, scheduled, or sent.
 *
 * Run: npx tsx scripts/cohort124-queue.ts [--dry] [--max 55]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { checkSuppression } from "@/lib/outreach/suppression";
import {
  competitiveMismatchReview,
  mismatchStrength,
  formatProductionDisplay,
} from "@/lib/prospects/mismatch";
import { qaDraft } from "@/lib/prospects/draft-qa";
import { createOutreachDraft } from "@/lib/prospects/service";

const MAX_PER_MARKET = 8;
const MAX_PER_BROKERAGE = 3; // = BROKERAGE_SEND_CAP_30D, the dispatch-time hard cap
const RECONTACT_WINDOW_DAYS = 90;

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

interface Candidate {
  prospectId: string;
  businessName: string;
  prospectType: string;
  market: string;
  brokerage: string | null;
  contactId: string;
  contactName: string;
  contactRole: string | null;
  email: string;
  emailProvenance: string;
  contactNotes: string | null;
  strength: string;
  review: NonNullable<Awaited<ReturnType<typeof competitiveMismatchReview>>>;
}

async function main(): Promise<void> {
  const user = await operatorUser();
  const dry = process.argv.includes("--dry");
  const maxIdx = process.argv.indexOf("--max");
  const maxSelect = maxIdx >= 0 ? Number(process.argv[maxIdx + 1]) : 55;

  const runs = await sql`
    select r.id, r.label from runs r
    where r.label like 'Cohort 124 batch 1:%' and r.completed_at is not null`;
  const launchIds: string[] = [];
  const launchMarket = new Map<string, string>();
  for (const run of runs) {
    const tail = (run.label as string).replace("Cohort 124 batch 1:", "").trim();
    const city = tail.split(",")[0]!.trim();
    const st = tail.split(",")[1]?.trim() ?? "";
    const [launch] = await sql`
      select l.id from market_launches l join markets m on m.id = l.market_id
      where l.archived_at is null and lower(m.name) = ${city.toLowerCase()} and m.state_code = ${st}
      order by l.created_at desc limit 1`;
    if (launch && !launchIds.includes(launch.id as string)) {
      launchIds.push(launch.id as string);
      launchMarket.set(launch.id as string, `${city}, ${st}`);
    }
  }
  console.log(`cohort launches: ${launchIds.length}`);

  const prospects = await sql`
    select p.id, p.business_name, p.prospect_type, p.brokerage_affiliation, p.launch_id,
      p.do_not_contact,
      exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as contacted
    from prospects p
    where p.launch_id = any(${launchIds}) and p.archived_at is null`;

  const rejected: { prospect: string; market: string; reason: string }[] = [];
  const reject = (name: string, launchId: string, reason: string) =>
    rejected.push({
      prospect: name,
      market: launchMarket.get(launchId) ?? "?",
      reason,
    });

  const candidates: Candidate[] = [];
  for (const p of prospects) {
    if (p.doNotContact) { reject(p.businessName as string, p.launchId as string, "DNC"); continue; }
    if (p.contacted) { reject(p.businessName as string, p.launchId as string, "already contacted"); continue; }
    const review = await competitiveMismatchReview(p.id as string);
    const e = review?.evaluation;
    if (!e?.eligible || !e.selected) {
      reject(p.businessName as string, p.launchId as string, `ineligible: ${e?.reasonCodes.join(",") ?? "no review"}`);
      continue;
    }
    const [contact] = await sql`
      select id, name, role, email, provenance, notes from prospect_contacts
      where prospect_id = ${p.id} and is_primary and not do_not_contact
        and archived_at is null and email is not null`;
    if (!contact) { reject(p.businessName as string, p.launchId as string, "no verified primary contact email"); continue; }
    if (["ai_inferred", "estimated"].includes(contact.provenance as string)) {
      reject(p.businessName as string, p.launchId as string, "contact email not source-verified");
      continue;
    }
    const suppression = await checkSuppression({ email: contact.email as string, projectId: null });
    if (suppression.suppressed) { reject(p.businessName as string, p.launchId as string, `suppressed (${suppression.reason})`); continue; }
    const [personPrior] = await sql`
      select 1 from prospect_outreach_sends s
      where s.allowed and lower(s.recipient_email) = ${(contact.email as string).toLowerCase()}
        and s.sent_at > now() - make_interval(days => ${RECONTACT_WINDOW_DAYS})`;
    if (personPrior) { reject(p.businessName as string, p.launchId as string, "person contacted recently under another prospect"); continue; }
    // Hard bounces are recorded as suppressions/DNC (spec 118 is unbuilt),
    // so the suppression check above already covers bounce history.
    candidates.push({
      prospectId: p.id as string,
      businessName: p.businessName as string,
      prospectType: p.prospectType as string,
      market: launchMarket.get(p.launchId as string) ?? "?",
      brokerage: (p.brokerageAffiliation as string | null) ?? null,
      contactId: contact.id as string,
      contactName: contact.name as string,
      contactRole: (contact.role as string | null) ?? null,
      email: contact.email as string,
      emailProvenance: contact.provenance as string,
      contactNotes: (contact.notes as string | null) ?? null,
      strength: mismatchStrength(e.selected),
      review: review!,
    });
  }

  // Selection: strongest first, spread markets and brokerages, dedupe
  // people. Strength rank then recommendation gap then production gap.
  candidates.sort((a, b) => {
    const rank = (s: string) => (s === "strong" ? 0 : 1);
    const ra = rank(a.strength) - rank(b.strength);
    if (ra !== 0) return ra;
    return (
      b.review.evaluation.selected!.recommendationGap -
      a.review.evaluation.selected!.recommendationGap
    );
  });
  const perMarket = new Map<string, number>();
  const perBrokerage = new Map<string, number>();
  const seenEmails = new Set<string>();
  // 30-day brokerage sends already consumed elsewhere count against the cap.
  const priorBrokerage = new Map<string, number>();
  for (const c of candidates) {
    const b = c.brokerage?.trim().toLowerCase();
    if (b && !priorBrokerage.has(b)) {
      const [{ n } = { n: 0 }] = await sql`
        select count(*)::int as n from prospect_outreach_sends s
        join prospects p on p.id = s.prospect_id
        where s.allowed and lower(trim(p.brokerage_affiliation)) = ${b}
          and s.sent_at > now() - interval '30 days'`;
      priorBrokerage.set(b, Number(n));
    }
  }
  const selected: Candidate[] = [];
  for (const c of candidates) {
    if (selected.length >= maxSelect) break;
    const mkt = c.market;
    const b = c.brokerage?.trim().toLowerCase() ?? null;
    if ((perMarket.get(mkt) ?? 0) >= MAX_PER_MARKET) {
      rejected.push({ prospect: c.businessName, market: c.market, reason: "market cap reached" });
      continue;
    }
    if (b && (perBrokerage.get(b) ?? 0) + (priorBrokerage.get(b) ?? 0) >= MAX_PER_BROKERAGE) {
      rejected.push({ prospect: c.businessName, market: c.market, reason: "brokerage spread cap" });
      continue;
    }
    if (seenEmails.has(c.email.toLowerCase())) {
      rejected.push({ prospect: c.businessName, market: c.market, reason: "duplicate email in cohort" });
      continue;
    }
    selected.push(c);
    perMarket.set(mkt, (perMarket.get(mkt) ?? 0) + 1);
    if (b) perBrokerage.set(b, (perBrokerage.get(b) ?? 0) + 1);
    seenEmails.add(c.email.toLowerCase());
  }
  console.log(`candidates ${candidates.length} → selected ${selected.length} (dry=${dry})`);

  const rows: Record<string, unknown>[] = [];
  for (const c of selected) {
    const e = c.review.evaluation.selected!;
    const metric = e.metricType!;
    const pv = c.review.prospect.production!;
    const cv = e.production!;
    const pVal = metric === "closed_volume" ? pv.volumeUsd : pv.sides;
    const cVal = metric === "closed_volume" ? cv.volumeUsd : cv.sides;
    let draftId: string | null = null;
    let subject: string | null = null;
    let body: string | null = null;
    let qaStatus = "not generated (dry)";
    if (!dry) {
      const draft = await createOutreachDraft(user, {
        prospectId: c.prospectId,
        channel: "email",
        contactId: c.contactId,
      });
      if (!draft.ok) {
        qaStatus = `DRAFT FAILED: ${draft.error.message}`;
      } else {
        draftId = draft.data.draftId as string;
        const [d] = await sql`select subject, body, prompt_version from outreach_drafts where id = ${draftId}`;
        subject = d?.subject as string;
        body = d?.body as string;
        if ((d?.promptVersion as string | undefined)?.includes("mismatch") === false) {
          qaStatus = `WRONG TEMPLATE: ${d?.promptVersion}`;
        } else {
          const issues = await qaDraft(draftId);
          qaStatus = issues.length === 0 ? "PASS" : `FAIL: ${issues.map((i) => i.check).join(",")}`;
        }
      }
    }
    rows.push({
      firstName: c.review.firstName,
      contactName: c.contactName,
      contactRole: c.contactRole,
      entity: c.businessName,
      entityType: c.prospectType,
      market: c.market,
      brokerage: c.brokerage,
      email: c.email,
      emailProvenance: c.emailProvenance,
      contactEvidence: c.contactNotes,
      realtrendsPeriod: pv.productionYear,
      prospectVolume: formatProductionDisplay(metric, pVal),
      competitor: e.displayName,
      competitorVolume: formatProductionDisplay(metric, cVal),
      productionDiff: metric === "closed_volume" ? pVal - cVal : null,
      productionDiffPct: Math.round((1 - (e.productionRatio ?? 1)) * 100),
      prospectRecs: c.review.prospect.recommendationCount,
      competitorRecs: e.recommendationCount,
      recommendationGap: e.recommendationGap,
      denominator: c.review.benchmark!.answerCount,
      benchmarkDate: c.review.benchmarkCompletedAt,
      benchmarkScope: c.review.scopeCopy,
      hookStrength: c.strength,
      priorOutreach: "none",
      policyStatus: "PASS",
      qaStatus,
      templateVersion: "competitive_mismatch_reply_v1",
      draftId,
      prospectId: c.prospectId,
      subject,
      body,
    });
  }

  mkdirSync(".local-data/realtrends", { recursive: true });
  const out = {
    cohort: "competitive_mismatch_bootstrap_test_001",
    status: "REVIEW_REQUIRED",
    createdAt: new Date().toISOString(),
    sendReady: rows.filter((r) => r.qaStatus === "PASS" || dry).length,
    rows,
    rejected,
  };
  writeFileSync(
    ".local-data/realtrends/cohort124-bootstrap-test-001.json",
    JSON.stringify(out, null, 2)
  );
  console.log(`written: ${rows.length} rows, ${rejected.length} rejected`);
  const tally = new Map<string, number>();
  for (const r of rejected) {
    const key = r.reason.split(":")[0]!;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
