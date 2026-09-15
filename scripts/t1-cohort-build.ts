/**
 * Touch 1 cohort build (2026-09-11): FIND → VERIFY → QUALIFY → PRIORITIZE →
 * FREEZE over the canonical services. Nothing here sends, schedules or
 * enrolls. The pure layer is lib/prospects/t1-cohort.ts; this file only
 * assembles facts from the DB, persists the frozen snapshot (append-only
 * audit_log rows + a local JSON), and optionally generates the unapproved
 * Touch 1 drafts (frozen evidence snapshots) for the selected members.
 *
 * Run:
 *   npx tsx scripts/t1-cohort-build.ts --cohort t1-cohort-002            (dry: report only)
 *   npx tsx scripts/t1-cohort-build.ts --cohort t1-cohort-002 --freeze   (persist members)
 *   npx tsx scripts/t1-cohort-build.ts --cohort t1-cohort-002 --freeze --drafts
 * Idempotent: a rerun with the same facts adds no membership rows and no
 * duplicate drafts (an identical unapproved mismatch draft is reused).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { JSONValue } from "postgres";
import type { CurrentUser } from "@/lib/auth";
import { checkSuppression } from "@/lib/outreach/suppression";
import {
  BROKERAGE_CUT_COMMA,
  BROKERAGE_CUT_SUFFIX,
  MISMATCH_TEMPLATE_VERSION,
  RECONTACT_PERSON_WINDOW_DAYS,
  normalizeBrokerage,
  type ProvenanceLabel,
} from "@/lib/prospects/constants";
import { buildEvidenceSnapshot, competitiveMismatchReview, MISMATCH_PROVIDER, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { verifyEvidenceRelease } from "@/lib/prospects/evidence-release";
import { mismatchQuestions } from "@/lib/prospects/audit-mismatch";
import { providerRecommendationCounts, runSummary } from "@/lib/prospects/benchmark";
import { launchGeographies } from "@/lib/prospects/realtrends-dataset";
import { listBuyingSignals } from "@/lib/prospects/buying-signals";
import { createOutreachDraft } from "@/lib/prospects/service";
import { qaDraft } from "@/lib/prospects/draft-qa";
import {
  PROTECTED_MARKET_NAMES,
  T1_COHORT_POLICY_VERSION,
  brokerageCapKey,
  cohortVerdict,
  contactBottleneck,
  dedupeBuyingUnits,
  evaluateCandidate,
  evidenceBottleneck,
  featuresFromSnapshot,
  freezeCohort,
  isGenericEmail,
  membershipKey,
  newMembers,
  revalidateBeforeFreeze,
  selectCohort,
  type T1CandidateFacts,
  type T1CohortMember,
  type T1Evaluation,
} from "@/lib/prospects/t1-cohort";

const AUDIT_ACTION = "outreach.t1_cohort_member";
const POSITIVE_REPLIES = ["positive_interest", "question", "proof_request", "referral"];
const DECLINE_REPLIES = ["decline", "not_interested", "unsubscribe"];
const SANDBOX_MARKET_PREFIX = "QA134";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const norm = (s: string | null | undefined): string | null => {
  const t = (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
};
function firstLast(name: string | null): string | null {
  const parts = (norm(name) ?? "").split(" ").filter((p) => p.length > 1);
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : null;
}

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

interface Row { id: string; businessName: string; prospectType: string; companyId: string | null; brokerageAffiliation: string | null; teamLeader: string | null; website: string | null; stage: string; doNotContact: boolean; conflictStatus: string; launchId: string; launchStatus: string; marketId: string; marketName: string; stateCode: string | null; contactId: string | null; contactName: string | null; contactRole: string | null; contactEmail: string | null; contactProvenance: string | null }

async function protectedMarketIds(): Promise<Set<string>> {
  const rows = await sql`
    with recursive tree as (
      select id, name, parent_id, (lower(name) = any(${[...PROTECTED_MARKET_NAMES]}::text[])) as prot from markets
    ), down as (
      select id from tree where prot
      union
      select m.id from markets m join down d on m.parent_id = d.id
    )
    select id from down`;
  return new Set(rows.map((r) => r.id as string));
}

/** Markets covered by a live (active/reserved) exclusivity scope: the scope
 * market, its descendants and its ancestors all conflict (spec 052). */
async function exclusiveMarketIds(): Promise<Set<string>> {
  const rows = await sql`
    with recursive scoped as (
      select s.market_id from exclusivity_scopes s join exclusivity_agreements a on a.id = s.agreement_id
      where a.status in ('active','reserved') and a.terminated_at is null
    ), down as (
      select market_id as id from scoped
      union select m.id from markets m join down d on m.parent_id = d.id
    ), up as (
      select market_id as id from scoped
      union select m.parent_id as id from markets m join up u on m.id = u.id where m.parent_id is not null
    )
    select id from down union select id from up`;
  return new Set(rows.map((r) => r.id as string));
}

async function competitorRank(runId: string, launchId: string, competitorId: string, geos: Awaited<ReturnType<typeof launchGeographies>>): Promise<{ rank: number; universe: number } | null> {
  const geo = geos.find((g) => g.launchId === launchId);
  if (!geo?.state) return null;
  const pool = await sql`
    select distinct company_id from realtrends_records
    where lower(city) = ${geo.city.toLowerCase()} and state = ${geo.state}
      and match_status in ('high_confidence','confirmed') and company_id is not null`;
  const ids = pool.map((r) => r.companyId as string);
  if (!ids.includes(competitorId)) return null;
  const counts = await providerRecommendationCounts(runId, MISMATCH_PROVIDER, ids);
  const ordered = ids.map((id) => counts.recommendedByCompany[id] ?? 0).sort((a, b) => b - a);
  const mine = counts.recommendedByCompany[competitorId] ?? 0;
  return { rank: ordered.findIndex((v) => v <= mine) + 1, universe: ids.length };
}

async function assemble(p: Row, ctx: { now: Date; protectedIds: Set<string>; exclusiveIds: Set<string>; geos: Awaited<ReturnType<typeof launchGeographies>> }): Promise<{ facts: T1CandidateFacts; snapshot: MismatchEvidenceSnapshot | null; rawReasons: string[] }> {
  const [sendRow] = await sql`select 1 from prospect_outreach_sends where prospect_id = ${p.id} and allowed limit 1`;
  const [seqRow] = await sql`select 1 from outreach_followup_sequences where prospect_id = ${p.id} and status in ('active','paused') limit 1`;
  const [posRow] = await sql`select 1 from prospect_replies where prospect_id = ${p.id} and classification = any(${POSITIVE_REPLIES}::text[]) limit 1`;
  const [decRow] = await sql`select 1 from prospect_replies where prospect_id = ${p.id} and classification = any(${DECLINE_REPLIES}::text[]) limit 1`;
  const [engRow] = await sql`select 1 from client_engagements where prospect_id = ${p.id} limit 1`;
  let suppressed = false;
  let personRecent = false;
  if (p.contactEmail) {
    suppressed = (await checkSuppression({ email: p.contactEmail, projectId: null })).suppressed;
    const [pr] = await sql`select 1 from prospect_outreach_sends where allowed and lower(recipient_email) = ${p.contactEmail.toLowerCase()} and sent_at > now() - make_interval(days => ${RECONTACT_PERSON_WINDOW_DAYS}) limit 1`;
    personRecent = Boolean(pr);
  }
  const review = await competitiveMismatchReview(p.id, { now: ctx.now });
  const e = review?.evaluation;
  let snapshot: MismatchEvidenceSnapshot | null = null;
  let release: T1CandidateFacts["release"] = null;
  let features: T1CandidateFacts["features"] = null;
  const rawReasons: string[] = [...(e?.reasonCodes ?? ["NO_REVIEW"])];
  if (review && e?.eligible && e.selected) {
    snapshot = buildEvidenceSnapshot(review, e.selected);
    const v = await verifyEvidenceRelease(snapshot, { prospectId: p.id, sendId: null });
    release = { verified: v.verified, reasons: v.reasons };
    if (!v.verified) rawReasons.push(...v.reasons);
    const run = await runSummary(snapshot.runId);
    const dq = await mismatchQuestions(snapshot);
    const compProd = e.selected.production;
    features = featuresFromSnapshot({
      runId: snapshot.runId, provider: snapshot.provider, answerCount: snapshot.answerCount, modelCount: snapshot.modelCount, completedAt: snapshot.completedAt, benchmarkAgeDays: e.benchmarkAgeDays,
      expectedResponses: run ? run.promptCount * Math.max(1, snapshot.modelCount) : null, validResponses: snapshot.answerCount,
      prospect: { recommendationCount: snapshot.prospect.recommendationCount, productionValue: snapshot.prospect.productionValue, productionYear: snapshot.prospect.productionYear, productionSignalId: snapshot.prospect.productionSignalId },
      competitor: { companyId: snapshot.competitor.companyId, name: snapshot.competitor.name, recommendationCount: snapshot.competitor.recommendationCount, productionValue: snapshot.competitor.productionValue, productionSignalId: snapshot.competitor.productionSignalId, productionRatio: snapshot.competitor.productionRatio, recommendationGap: snapshot.competitor.recommendationGap, entityLevel: compProd?.entityType ?? null },
      metricType: snapshot.metricType,
      distinctQuestions: { prospect: dq.filter((q) => q.prospectRecommended > 0).length, competitor: dq.filter((q) => q.competitorRecommended > 0).length },
      competitorRank: await competitorRank(snapshot.runId, p.launchId, snapshot.competitor.companyId, ctx.geos),
    });
  }
  const signals = (await listBuyingSignals(p.id)).map((s) => ({ kind: s.kind, label: s.label, sourceUrl: s.sourceUrl, observedOn: s.observedOn, provenance: s.provenance }));
  // Lead person with provenance only: the RealTrends record's team_lead (team) or the record's own entity (individual).
  let leadPersonKey: string | null = null;
  if (p.companyId) {
    const [rt] = await sql`select entity_type, entity_name, team_lead from realtrends_records where company_id = ${p.companyId} and match_status in ('high_confidence','confirmed') order by (match_status='confirmed') desc limit 1`;
    if (rt) leadPersonKey = rt.entityType === "team" ? firstLast(rt.teamLead as string | null) : firstLast(rt.entityName as string);
  }
  const contactFL = firstLast(p.contactName);
  const leadFL = firstLast(p.prospectType === "team" ? p.teamLeader : p.businessName) ?? firstLast(p.teamLeader);
  const facts: T1CandidateFacts = {
    prospectId: p.id, companyId: p.companyId, name: p.businessName, prospectType: p.prospectType,
    entityLevel: review?.prospect.production?.entityType ?? null,
    market: { launchId: p.launchId, name: `${p.marketName}, ${p.stateCode ?? "?"}`, stateCode: p.stateCode, protected: ctx.protectedIds.has(p.marketId), exclusiveConflict: ctx.exclusiveIds.has(p.marketId) || ["possible", "partial", "direct", "blocked"].includes(p.conflictStatus), launchStatus: p.launchStatus },
    outreach: { stage: p.stage, contacted: Boolean(sendRow), activeSequence: Boolean(seqRow), positiveReply: Boolean(posRow), engagement: Boolean(engRow), declined: Boolean(decRow), doNotContact: p.doNotContact, suppressed, personRecentlyContacted: personRecent },
    mismatch: { eligible: Boolean(e?.eligible && e.selected), reasonCodes: e?.reasonCodes ?? ["NO_REVIEW"] },
    release,
    pendingCorrection: Boolean(release && release.reasons.some((r) => r === "PENDING_CORRECTION" || r === "UNRESOLVED_EVIDENCE_ISSUE")),
    contact: p.contactId && p.contactEmail ? { id: p.contactId, name: p.contactName ?? "", role: p.contactRole, email: p.contactEmail, provenance: (p.contactProvenance ?? "manual") as ProvenanceLabel, generic: isGenericEmail(p.contactEmail), isDecisionMaker: contactFL !== null && contactFL === leadFL } : null,
    firstName: review?.firstName ?? null,
    features, buyerSignals: signals, websiteOnFile: Boolean(p.website),
    dedupe: { brokerageKey: p.brokerageAffiliation ? normalizeBrokerage(p.brokerageAffiliation) : null, leadPersonKey },
  };
  return { facts, snapshot, rawReasons };
}

async function loadUniverse(): Promise<Row[]> {
  const rows = await sql`
    select p.id, p.business_name, p.prospect_type, p.company_id, p.brokerage_affiliation, p.team_leader, p.website, p.stage, p.do_not_contact, p.conflict_status,
      l.id launch_id, l.status launch_status, m.id market_id, m.name market_name, m.state_code,
      c.id contact_id, c.name contact_name, c.role contact_role, c.email contact_email, c.provenance contact_provenance
    from prospects p join market_launches l on l.id = p.launch_id join markets m on m.id = l.market_id
    left join prospect_contacts c on c.prospect_id = p.id and c.is_primary and not c.do_not_contact and c.archived_at is null
    where p.archived_at is null and m.name not like ${SANDBOX_MARKET_PREFIX + "%"}
    order by m.name, p.business_name`;
  return rows as unknown as Row[];
}

async function priorBrokerageSends(items: { facts: T1CandidateFacts }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const { facts } of items) {
    const bk = facts.dedupe.brokerageKey;
    if (!bk) continue;
    const key = brokerageCapKey(facts.market.launchId, bk);
    if (out.has(key)) continue;
    const [{ n } = { n: 0 }] = await sql`
      select count(distinct s.prospect_id)::int as n from prospect_outreach_sends s join prospects p on p.id = s.prospect_id
      where s.allowed and p.launch_id = ${facts.market.launchId}
        and trim(regexp_replace(regexp_replace(lower(trim(p.brokerage_affiliation)), ${BROKERAGE_CUT_COMMA}, ''), ${BROKERAGE_CUT_SUFFIX}, '')) = ${bk}
        and s.sent_at > now() - interval '30 days'`;
    out.set(key, Number(n));
  }
  return out;
}

async function existingMembershipKeys(cohortId: string): Promise<Set<string>> {
  const rows = await sql`select detail->>'membershipKey' as k from audit_log where action = ${AUDIT_ACTION} and detail->>'cohortId' = ${cohortId}`;
  return new Set(rows.map((r) => r.k as string));
}

/** Reuse an identical unapproved mismatch draft; else generate one. Never approves, schedules or sends. */
async function ensureDraft(user: CurrentUser, m: T1CohortMember): Promise<{ draftId: string; reused: boolean; qa: string }> {
  const [d] = await sql`
    select id, evidence_snapshot from outreach_drafts
    where prospect_id = ${m.prospectId} and channel = 'email' and status = 'draft' and prompt_version = ${MISMATCH_TEMPLATE_VERSION}
      and contact_id = ${m.contact.id} and scheduled_send_at is null
    order by version desc limit 1`;
  const snap = d?.evidenceSnapshot as MismatchEvidenceSnapshot | null | undefined;
  if (d && snap && snap.runId === m.features.runId && snap.competitor.companyId === m.features.competitorCompanyId && snap.prospect.recommendationCount === m.features.prospectRecs && snap.competitor.recommendationCount === m.features.competitorRecs && snap.answerCount === m.features.denominator) {
    const issues = await qaDraft(d.id as string);
    return { draftId: d.id as string, reused: true, qa: issues.length === 0 ? "PASS" : `FAIL: ${issues.map((i) => i.check).join(",")}` };
  }
  const res = await createOutreachDraft(user, { prospectId: m.prospectId, channel: "email", contactId: m.contact.id, competitorCompanyId: m.features.competitorCompanyId });
  if (!res.ok) return { draftId: "", reused: false, qa: `DRAFT FAILED: ${res.error.message}` };
  const [nd] = await sql`select prompt_version from outreach_drafts where id = ${res.data.draftId}`;
  if (nd?.promptVersion !== MISMATCH_TEMPLATE_VERSION) return { draftId: res.data.draftId, reused: false, qa: `WRONG TEMPLATE: ${nd?.promptVersion}` };
  const issues = await qaDraft(res.data.draftId);
  return { draftId: res.data.draftId, reused: false, qa: issues.length === 0 ? "PASS" : `FAIL: ${issues.map((i) => i.check).join(",")}` };
}

async function main(): Promise<void> {
  const cohortId = arg("--cohort") ?? "t1-cohort-002";
  const freeze = process.argv.includes("--freeze");
  const drafts = process.argv.includes("--drafts");
  const now = new Date();
  const user = await operatorUser();
  const [protectedIds, exclusiveIds, geos] = await Promise.all([protectedMarketIds(), exclusiveMarketIds(), launchGeographies(sql)]);
  const universe = await loadUniverse();
  console.log(`cohort ${cohortId} · policy ${T1_COHORT_POLICY_VERSION} · template ${MISMATCH_TEMPLATE_VERSION} · universe ${universe.length}`);

  const items: { facts: T1CandidateFacts; evaluation: T1Evaluation; rawReasons: string[] }[] = [];
  for (const p of universe) {
    const { facts, rawReasons } = await assemble(p, { now, protectedIds, exclusiveIds, geos });
    items.push({ facts, evaluation: evaluateCandidate(facts, now), rawReasons });
  }
  const deduped = dedupeBuyingUnits(items).map((d) => ({ ...d, rawReasons: items.find((i) => i.facts.prospectId === d.facts.prospectId)!.rawReasons }));

  // Funnel (each stage nested in the previous; counts are actual).
  const f0 = deduped;
  const f1 = f0.filter((i) => !i.evaluation.blockers.some((b) => b === "MARKET_PROTECTED" || b === "MARKET_EXCLUSIVE_CONFLICT" || b === "MARKET_PAUSED"));
  const f2 = f1.filter((i) => !i.evaluation.blockers.some((b) => ["ALREADY_CONTACTED", "ACTIVE_SEQUENCE", "POSITIVE_RESPONDER", "CLIENT_OR_ENGAGEMENT", "DECLINED", "DO_NOT_CONTACT", "SUPPRESSED", "PERSON_RECENTLY_CONTACTED", "STAGE_NOT_FIRST_TOUCH"].includes(b)));
  const f3 = f2.filter((i) => !i.evaluation.blockers.includes("DUPLICATE_BUYING_UNIT"));
  const f4 = f3.filter((i) => i.facts.mismatch.eligible);
  const f5 = f4.filter((i) => i.facts.release?.verified && !i.evaluation.blockers.includes("PENDING_CORRECTION") && !i.evaluation.blockers.includes("ENTITY_TYPE_UNKNOWN"));
  const f6 = f5.filter((i) => contactBottleneck(i.evaluation.blockers) === null);
  const f7 = f6.filter((i) => i.facts.buyerSignals.length > 0);
  const ready = deduped.filter((i) => i.evaluation.sendReady);
  const funnel = { sourceUniverse: f0.length, marketAllowed: f1.length, firstTouchEligible: f2.length, deduped: f3.length, mismatchEligible: f4.length, evidenceVerified: f5.length, contactVerified: f6.length, buyerEnriched: f7.length, sendReady: ready.length };

  const evidenceBottlenecks: Record<string, number> = {};
  for (const i of f3.filter((i) => !f5.includes(i))) { const k = evidenceBottleneck(i.rawReasons); evidenceBottlenecks[k] = (evidenceBottlenecks[k] ?? 0) + 1; }
  const contactBottlenecks: Record<string, number> = {};
  for (const i of f5.filter((i) => !f6.includes(i))) { const k = contactBottleneck(i.evaluation.blockers) ?? "OTHER"; contactBottlenecks[k] = (contactBottlenecks[k] ?? 0) + 1; }

  const prior = await priorBrokerageSends(ready);
  const selection = selectCohort({ items: ready, priorBrokerageSends: prior });

  // Pre-freeze revalidation against fresh facts (corrections, agreements, replies landed meanwhile).
  const fresh = new Map<string, T1CandidateFacts>();
  for (const s of selection.selected) {
    const row = universe.find((u) => u.id === s.facts.prospectId)!;
    fresh.set(s.facts.prospectId, (await assemble(row, { now, protectedIds, exclusiveIds, geos })).facts);
  }
  const reval = revalidateBeforeFreeze(selection.selected, fresh, now);
  const members = freezeCohort(cohortId, reval.kept, now);
  const verdict = cohortVerdict(members.length);

  const count = (xs: T1CohortMember[], key: (m: T1CohortMember) => string) => xs.reduce<Record<string, number>>((acc, m) => { const k = key(m); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const report = {
    cohortId, verdict, policy: { cohortPolicyVersion: T1_COHORT_POLICY_VERSION, templateVersion: MISMATCH_TEMPLATE_VERSION }, builtAt: now.toISOString(), frozen: freeze,
    funnel, evidenceBottlenecks, contactBottlenecks,
    marketCoverage: count(members, (m) => m.market.name), entityMix: count(members, (m) => m.entityType), recMix: count(members, (m) => m.recBucket), bandMix: count(members, (m) => m.band),
    deferred: selection.deferred, droppedAtRevalidation: reval.dropped,
    members,
    nonMembers: deduped.filter((i) => !members.some((m) => m.prospectId === i.facts.prospectId)).map((i) => ({ prospectId: i.facts.prospectId, name: i.facts.name, market: i.facts.market.name, blockers: i.evaluation.blockers, rawReasons: i.rawReasons, band: i.evaluation.band })),
  };
  const dir = `.local-data/prospecting/${cohortId}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${freeze ? "snapshot" : "dry-run"}-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`, JSON.stringify(report, null, 1));

  console.log(JSON.stringify({ verdict, funnel, evidenceBottlenecks, contactBottlenecks, marketCoverage: report.marketCoverage, entityMix: report.entityMix, recMix: report.recMix, bandMix: report.bandMix, deferred: selection.deferred.length, dropped: reval.dropped }, null, 1));
  for (const m of members) console.log(`${m.band.padEnd(2)} ${m.market.name.padEnd(20)} ${m.entityType.padEnd(16)} ${m.name.padEnd(40)} ${m.features.prospectRecs}/${m.features.competitorRecs}/${m.features.denominator} gap ${m.features.absoluteGap} ratio ${m.features.competitorProductionRatio?.toFixed(2)} vs ${m.features.competitorName} · ${m.contact.name} <${m.contact.email}>`);

  if (freeze) {
    const existing = await existingMembershipKeys(cohortId);
    const toAdd = newMembers(existing, members);
    await sql.begin(async (tx) => {
      for (const m of toAdd) {
        await writeAudit(tx, { userId: user.id, action: AUDIT_ACTION, entity: "prospect", entityId: m.prospectId, detail: JSON.parse(JSON.stringify({ ...m, membershipKey: membershipKey(cohortId, m.prospectId) })) as JSONValue });
      }
    });
    console.log(`frozen: ${toAdd.length} new membership rows (${existing.size} already existed)`);
    if (drafts) {
      const results: Record<string, unknown>[] = [];
      for (const m of members) {
        const r = await ensureDraft(user, m);
        results.push({ prospect: m.name, ...r });
        console.log(`draft ${m.name}: ${r.reused ? "reused" : "created"} ${r.draftId} qa=${r.qa}`);
      }
      writeFileSync(`${dir}/drafts-${now.toISOString().slice(0, 10)}.json`, JSON.stringify(results, null, 1));
    }
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
