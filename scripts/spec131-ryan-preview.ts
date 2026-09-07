/**
 * READ-ONLY preview of what the OS would populate if Ryan Ogle / Blu House
 * Properties signed tomorrow (spec 131). Writes nothing: no engagement, no
 * agreement, no billing row, no stage change, no email. Uses only canonical
 * records: the prospect, its linked benchmark run, the corrected evidence, the
 * market tree, and the measurement snapshot builder (which never persists).
 *
 *   npx tsx scripts/spec131-ryan-preview.ts
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { buildMeasurementSnapshot } from "@/lib/engagements/measurement";
import { measurementSchedule, termDates } from "@/lib/engagements/rules";
import { deliveredTouch1 } from "@/lib/prospects/followups";

const PROSPECT_NAME = "Blu House Properties";
const PROVIDER = "openai";
// HISTORICAL_TRUTH (spec 135): the terms Ryan was actually quoted on
// 2026-09-05 (founder_monthly_7500_v0). Not the current offer; this preview
// reproduces that moment and must not follow the active policy.
const MONTHLY = 7500;
const TERM_DAYS = 90;

async function main() {
  const [p] = await sql`
    select p.id, p.stage, p.business_name, p.company_id, p.promoted_project_id, p.do_not_contact,
      p.neighborhoods, p.website, l.market_id, l.service_category, l.price_segment, m.name as market_name, m.kind as market_kind,
      (select name from markets where id = m.parent_id) as parent_market
    from prospects p join market_launches l on l.id = p.launch_id join markets m on m.id = l.market_id
    where p.business_name = ${PROSPECT_NAME} and p.archived_at is null
  `;
  if (!p) throw new Error("prospect not found");
  const contacts = await sql`select name, email from prospect_contacts where prospect_id = ${p.id} and archived_at is null`;
  const [bench] = await sql`select run_id from prospect_benchmarks where prospect_id = ${p.id} order by created_at desc limit 1`;
  const touch1 = await deliveredTouch1(p.id as string);
  const rival = touch1?.evidenceSnapshot.competitor;
  const [engagement] = await sql`select id, stage from client_engagements where prospect_id = ${p.id}`.catch(() => [] as { id: string; stage: string }[]);
  const neighborhoods = await sql`select name from markets where parent_id = ${p.marketId} order by name`;
  const [company] = await sql`select name, aliases from companies where id = ${p.companyId}`;
  const [existingDef] = await sql`select 1 from client_engagements where market_id = ${p.marketId} and market_definition_confirmed_at is not null limit 1`.catch(() => [] as unknown[]);

  const snapshot = await buildMeasurementSnapshot({
    runId: bench!.runId as string,
    provider: PROVIDER,
    subjectCompanyId: p.companyId as string,
    competitorCompanyIds: rival ? [rival.companyId] : [],
  });
  const start = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const dates = termDates(start, TERM_DAYS);
  const schedule = measurementSchedule(start, dates.endsOn);
  const mask = (e: unknown) => String(e).replace(/^(.).*@/, "$1***@");
  const topGap = snapshot.questions
    .filter((q) => q.subjectRecommended === 0 && Object.values(q.competitorRecommended).some((n) => n > 0))
    .slice(0, 5)
    .map((q) => `${q.text} (rival ${Object.values(q.competitorRecommended)[0]} of ${q.answerCount})`);
  const neighborhoodQuestions = snapshot.questions.filter((q) => (q.category ?? "").toLowerCase().includes("neighborhood") || /eastown|ridgemoor|john ball|east hills|creston/i.test(q.text)).length;

  const preview = {
    READ_ONLY: true,
    safety: { engagementExists: Boolean(engagement), currentStage: p.stage, promoted: Boolean(p.promotedProjectId), doNotContact: p.doNotContact },
    CLIENT: {
      business: p.businessName,
      canonicalCompany: company?.name,
      verifiedAliases: company?.aliases,
      primaryContact: contacts.map((c) => `${c.name} <${mask(c.email)}>`),
      website: p.website,
    },
    MARKET: {
      name: p.marketName,
      kind: p.marketKind,
      parent: p.parentMarket,
      scope: { serviceCategory: p.serviceCategory, segment: p.priceSegment },
      neighborhoodsInTree: neighborhoods.map((n) => n.name),
      MARKET_DEFINITION_REQUIRED: existingDef ? "NO (already confirmed)" : "YES — boundary (city vs metro vs Kent County vs West Michigan) not confirmed",
    },
    COMMERCIAL: {
      monthlyFeeUsd: MONTHLY,
      termDays: TERM_DAYS,
      totalInitialUsd: MONTHLY * (TERM_DAYS / 30),
      startsOn: start,
      endsOn: dates.endsOn,
      renewalReviewOn: dates.renewalReviewOn,
      plannedRemeasurements: schedule,
      gates: ["CONTRACT_SIGNED (manual, reference required)", "PAYMENT_RECORDED (manual ledger) or admin override with reason", "MARKET_DEFINITION_CONFIRMED", "EXCLUSIVITY_ACTIVE", "BASELINE_FROZEN", "FIRST_PLAN"],
    },
    BASELINE: {
      runId: snapshot.runId,
      sourceProject: snapshot.sourceProjectId,
      provider: snapshot.provider,
      models: snapshot.models,
      repetitions: snapshot.repetitions,
      capturedAt: snapshot.capturedAt,
      questions: snapshot.questionCount,
      validAnswers: snapshot.answerCount,
      subject: `${snapshot.subject.name} = ${snapshot.subject.recommendedCount} / ${snapshot.answerCount} (${snapshot.subject.distinctQuestions} distinct questions)`,
      competitors: snapshot.competitors.map((c) => `${c.name} = ${c.recommendedCount} / ${snapshot.answerCount} (${c.distinctQuestions} distinct questions)`),
      historicalTouch1Claim: touch1 ? `${touch1.originalSnapshot.prospect.recommendationCount} / ${touch1.originalSnapshot.answerCount} (kept historical; correction ${touch1.correction ? "recorded" : "none"})` : "n/a",
      methodology: snapshot.versions,
      rawAnswersReferenced: snapshot.questions.reduce((s, q) => s + q.responseIds.length, 0),
    },
    FIRST_CONTEXT_QUESTIONS: [
      `Which neighborhoods matter most this year? (benchmark covers ${neighborhoodQuestions} neighborhood questions; tree lists ${neighborhoods.length} — none is confirmed as a priority)`,
      "Is buyer or seller business the bigger priority for the next 90 days?",
      `Which 2–3 teams are the real comparison set? (benchmark rival: ${rival?.name ?? "n/a"})`,
      `Which website pages and profiles can your team edit directly? (known site: ${p.website ?? "unknown"}; Zillow / Realtor.com / Homes.com / brokerage profile unknown)`,
      "Who approves public-facing changes, and by which channel?",
    ],
    ALREADY_KNOWN_DO_NOT_ASK: ["business and team name", "lead agent (verified alias)", "market and segment", "baseline numbers", "primary contact email", "reply history and pricing conversation"],
    FIRST_WORK_ITEMS_PREVIEW_ONLY: [
      { title: "Ryan Ogle / Blu House identity consistency on owned pages and profiles", observation: `Answers surface the person and the team separately (${snapshot.subject.aliases.length} verified alias${snapshot.subject.aliases.length === 1 ? "" : "es"}).`, hypothesis: "Consistent public person↔team identity may improve how consistently the track record is surfaced.", confidence: "high_confidence", control: "we_control", clientApproval: "required (public copy)", evidence: `${snapshot.questions.filter((q) => q.subjectRecommended > 0).length} baseline answers`, measurement: "same 64 questions, OpenAI, after implementation", status: "PREVIEW ONLY" },
      { title: "Third-party profile consistency (Zillow, Realtor.com, Homes.com, brokerage)", observation: "Portals repeatedly appear as sources in answers.", confidence: "medium_confidence", control: "third_party", clientApproval: "required for profile edits", status: "PREVIEW ONLY" },
      { title: "Target-neighborhood evidence", observation: `Rival leads on: ${topGap.join("; ") || "n/a"}`, blocked: "client_input — confirm which neighborhoods matter", status: "PREVIEW ONLY" },
    ],
  };
  console.log(JSON.stringify(preview, null, 2));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
