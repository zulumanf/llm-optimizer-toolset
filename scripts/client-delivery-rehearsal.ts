/**
 * Spec 154 — first-client rehearsal on SYNTHETIC data, through the real
 * services and the mock provider. Seeds two clearly fake clients in a LOCAL
 * sandbox database:
 *
 *   A. "SYNTHETIC — pending client": onboarding, questions imported, protocol
 *      drafted, no baseline (shows the honest pending state).
 *   B. "SYNTHETIC — delivery client": questions approved, protocol accepted,
 *      baseline locked, plan published, one change delivered, one approval
 *      waiting, welcome + weekly update sent, check-in scheduled.
 *
 * Refuses unless DATABASE_URL points at localhost AND the database name
 * contains sandbox|demo|rehearsal|test|e2e, and ALLOW_MOCK_PROVIDER=1.
 * REHEARSAL_STATE_FILE (optional) receives the two project ids as JSON. Never
 * touches production, sends nothing, spends nothing.
 *
 *   DATABASE_URL=postgres://localhost:5433/rf_onboarding_sandbox ALLOW_MOCK_PROVIDER=1 AUTH_MODE=dev \
 *     npx tsx --tsconfig tsconfig.json scripts/client-delivery-rehearsal.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.DATABASE_URL ?? "";
const parsedUrl = (() => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
})();
if (!parsedUrl || !["localhost", "127.0.0.1"].includes(parsedUrl.hostname) || !/(sandbox|demo|rehearsal|test|e2e)/.test(parsedUrl.pathname)) {
  console.error("Refusing: DATABASE_URL must be a LOCAL sandbox database (name containing sandbox|demo|rehearsal|test|e2e).");
  process.exit(1);
}
if (process.env.ALLOW_MOCK_PROVIDER !== "1") {
  console.error("Refusing: set ALLOW_MOCK_PROVIDER=1 (the rehearsal uses the mock provider only).");
  process.exit(1);
}

type R<T> = { ok: true; data: T } | { ok: false; error: { message: string } };
function must<T>(label: string, r: R<T>): T {
  if (!r.ok) throw new Error(`${label}: ${r.error.message}`);
  return r.data;
}

async function main() {
  const { sql } = await import("@/db/client");
  const { DEV_USER_ID } = await import("@/lib/auth");
  const companies = await import("@/lib/companies/service");
  const exclusivity = await import("@/lib/exclusivity/service");
  const prospects = await import("@/lib/prospects/service");
  const eng = await import("@/lib/engagements/service");
  const intake = await import("@/lib/engagements/onboarding-intake");
  const delivery = await import("@/lib/engagements/delivery");
  const competitors = await import("@/lib/competitors/service");
  const runs = await import("@/lib/runs/service");
  const execute = await import("@/lib/runs/execute");
  const jobs = await import("@/db/jobs");
  const parsing = await import("@/lib/parsing/service");
  const scoring = await import("@/lib/scoring/compute");
  const plans = await import("@/lib/plans/service");
  const tasks = await import("@/lib/tasks/service");

  const op = { id: DEV_USER_ID, email: "dev@avos.local", name: "Rehearsal Operator", role: "admin" as const };
  const csv = readFileSync(join(__dirname, "..", "tests", "fixtures", "client-delivery", "synthetic-64-seller-questions.csv"), "utf8");
  const today = new Date().toISOString().slice(0, 10);

  async function drain() {
    for (let i = 0; i < 500; i += 1) {
      const job = await jobs.claimNextJob("rehearsal");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response") await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores") await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  async function client(tag: string, subjectName: string) {
    const getOrCreate = async (name: string) => {
      const [row] = await sql`select id, name, aliases from companies where lower(name) = lower(${name}) and archived_at is null limit 1`;
      return row ? { id: row.id as string } : must(name, await companies.upsertCompany(op, { name }));
    };
    const subject = await getOrCreate(subjectName);
    const rival = await getOrCreate("Acme");
    const market = must("market", await exclusivity.createMarket(op, { name: `Synthetic Metro ${tag}`, kind: "city", aliases: [] }));
    const launch = must("launch", await prospects.createLaunch(op, { name: `SYNTHETIC launch ${tag}`, marketId: market.marketId, priceSegment: "seller $300K+", serviceCategory: "residential brokerage" }));
    const prospect = must("prospect", await prospects.createProspect(op, { launchId: launch.launchId, businessName: `SYNTHETIC — ${tag} client`, prospectType: "team", companyId: subject.id, teamLeader: "Alex Synthetic", website: `https://${tag.toLowerCase()}.example.test` }));
    const signed = must("sign", await eng.signClient(op, { prospectId: prospect.prospectId, startsOn: today, monthlyFeeUsd: 1000, totalValueUsd: 1000, priceOverrideReason: "SYNTHETIC rehearsal terms", primaryContactName: "Alex Synthetic" }));
    await sql`update projects set name = ${`SYNTHETIC — ${tag} client`} where id = ${signed.projectId}`;
    const e = (await eng.engagementForProject(signed.projectId))!;
    must("contract", await eng.recordContractStatus(op, { engagementId: e.id, status: "signed", contractRef: "synthetic://contract" }));
    must("payment", await eng.recordBillingEvent(op, { engagementId: e.id, kind: "payment_received", amountUsd: 1000, externalInvoiceId: `SYN-${tag}` }));
    must("onboarding", await eng.startOnboarding(op, { engagementId: e.id }));
    await competitors.addCompetitor(op, { projectId: signed.projectId, companyId: rival.id, tier: "primary" });
    await sql`insert into user_project_access (user_id, project_id, granted_by) values (${DEV_USER_ID}, ${signed.projectId}, ${DEV_USER_ID}) on conflict do nothing`;
    must("intake", await intake.completeOnboardingIntake(op, {
      engagementId: e.id, legalName: `SYNTHETIC ${tag} Seller Team LLC`, brandName: subjectName, website: `https://${tag.toLowerCase()}.example.test`,
      primaryContactName: "Alex Synthetic", contactEmail: "alex@example.test", marketDefinition: "Synthetic metro: city plus confirmed surrounding communities; seller listings only.",
      priorities: ["Seller listings $300K+"], websiteControl: "client_can_delegate", minPropertyValueUsd: 300_000,
      neighborhoods: ["Northeast Heights", "North Valley", "Nob Hill"], surroundingMarkets: ["Corrales"], nameVariants: [`${subjectName} Team`],
      approvers: [{ name: "Alex Synthetic", email: "alex@example.test" }],
    }));
    const welcome = must("welcome", await delivery.generateWelcomeDraft(op, { engagementId: e.id, agencyContactName: "Rehearsal Operator" }));
    must("welcome sent", await delivery.markUpdateSent(op, { updateId: welcome.updateId, channel: "email" }));
    const imported = must("import", await delivery.importClientQuestions(op, { engagementId: e.id, setName: "Seller questions (synthetic)", content: csv, defaultAudience: "seller" }));
    const protocol = {
      engagementId: e.id, promptSetVersionId: imported.versionId!, provider: "mock", model: "mock-model", repetitions: 1,
      geographicContext: "Synthetic metro (rehearsal)", baselineWindow: "Week 1", finalWindow: "Days 80–85",
      successCriteria: "SYNTHETIC: success threshold is written here by people from the contract.", entityAliases: [subjectName, `${subjectName} Team`],
    };
    const draft = must("protocol", await delivery.saveProtocolDraft(op, protocol));
    return { e, projectId: signed.projectId, subject, versionId: imported.versionId!, protocolId: draft.protocolId, subjectName };
  }

  const pending = await client("Pending", "Nova Synthetic Homes");
  console.log(`pending client project: ${pending.projectId}`);

  const d = await client("Delivery", "Lumina");
  must("question approval", await delivery.recordSubjectDecision(op, { engagementId: d.e.id, subjectKind: "question_set", subjectRef: d.versionId, decision: "approved", channel: "email", clientActor: "Alex Synthetic" }));
  must("protocol acceptance", await delivery.acceptProtocol(op, { protocolId: d.protocolId, clientActor: "Alex Synthetic", channel: "email" }));
  await sql`update companies set aliases = array[${`${d.subjectName} Team`}] where id = ${d.subject.id}`;
  const run = must("run", await runs.startRun(op, { projectId: d.projectId, promptSetVersionId: d.versionId, providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }], budgetUsd: 5, label: "SYNTHETIC baseline" }));
  await sql`update runs set reuse_captures = false where id = ${run.id}`;
  await drain();
  // Spec 160: a baseline refuses unreviewed keyword-fallback classifications.
  // The rehearsal has no classifier (mock provider, no API key), so its
  // operator reviews each fallback classification by hand and confirms it —
  // the same reviewed revision reviewMention writes, audited as such.
  const { CURRENT_REVISION } = await import("@/db/mentions");
  const { PARSER_VERSION_HEURISTIC } = await import("@/lib/constants");
  const { writeAudit } = await import("@/db/audit");
  await sql.begin(async (tx) => {
    const rows = await tx`
      select m.* from mentions m join responses r on r.id = m.response_id
      where r.run_id = ${run.id} and m.parser_version = ${PARSER_VERSION_HEURISTIC} and m.reviewed_by is null and ${CURRENT_REVISION}
    `;
    for (const m of rows) {
      await tx`
        insert into mentions (response_id, company_id, revision, mentioned, recommended, list_position, sentiment, excerpt, cited_urls,
          parser_version, confidence, needs_review, reviewed_by, reviewed_at)
        values (${m.responseId}, ${m.companyId}, ${(m.revision as number) + 1}, ${m.mentioned}, ${m.recommended}, ${m.listPosition},
          ${m.sentiment}, ${m.excerpt}, ${m.citedUrls}, ${m.parserVersion}, 1.0, false, ${op.id}, now())
      `;
    }
    await writeAudit(tx, { userId: op.id, action: "mention.review", entity: "run", entityId: run.id, detail: { rehearsal: true, confirmed: rows.length, reason: "synthetic rehearsal: operator confirmed every keyword-fallback classification by hand" } });
  });
  const preview = must("preview", await eng.previewBaselineFreeze(op, { engagementId: d.e.id, runId: run.id }));
  const frozen = must("freeze", await eng.freezeBaseline(op, { engagementId: d.e.id, runId: run.id, confirmedAnswerCount: preview.headline?.answerCount }));
  const plan = must("plan", await delivery.createManualPlan(op, { projectId: d.projectId }));
  const evidence = frozen.snapshot.questions[0]!.responseIds[0]!;
  const i1 = must("item 1", await delivery.addPlanItem(op, { planId: plan.planId, phase: "foundation", title: "Publish a seller FAQ page", rationale: "Baseline answers rarely cite a seller-focused page from the client's own site (synthetic).", owner: "operator", evidenceResponseIds: [evidence] }));
  const i2 = must("item 2", await delivery.addPlanItem(op, { planId: plan.planId, phase: "foundation", title: "Align About page with the team name", rationale: "Answers name the person and the team inconsistently (synthetic).", owner: "shared", evidenceResponseIds: [evidence] }));
  must("item 3", await delivery.addPlanItem(op, { planId: plan.planId, phase: "authority", title: "Request reviews from recent sellers", rationale: "Third-party seller reviews appear alongside rival recommendations (synthetic).", owner: "client", dependsOn: [i1.planItemId] }));
  must("item 4", await delivery.addPlanItem(op, { planId: plan.planId, phase: "compounding", title: "Neighborhood seller guides for priority areas", rationale: "Priority neighborhoods confirmed in intake (synthetic).", owner: "operator" }));
  must("dates", await delivery.applyPhaseDueDates(op, { planId: plan.planId }));
  must("publish", await plans.approvePlan(op, { planId: plan.planId }));
  const t1 = must("activate 1", await plans.activatePlanItem(op, { planItemId: i1.planItemId })).taskId;
  must("visible 1", await tasks.updateTaskDetails(op, { taskId: t1, clientVisible: true }));
  must("prov 1", await tasks.updateTaskProvenance(op, { taskId: t1, observation: "No seller FAQ page.", hypothesis: "A seller FAQ gives assistants a citable seller page.", confidence: "medium_confidence", control: "we_control", targetUrl: "https://delivery.example.test/sell", beforeState: "No seller FAQ page.", afterState: "Seller FAQ page published with 12 questions." }));
  must("start 1", await tasks.startTask(op, { taskId: t1 }));
  must("done 1", await tasks.completeTask(op, { taskId: t1 }));
  const t2 = must("activate 2", await plans.activatePlanItem(op, { planItemId: i2.planItemId })).taskId;
  must("visible 2", await tasks.updateTaskDetails(op, { taskId: t2, clientVisible: true }));
  must("prov 2", await tasks.updateTaskProvenance(op, { taskId: t2, observation: "About page names the team only.", hypothesis: "Consistent naming may help answers connect the person and the team.", confidence: "high_confidence", control: "client_controls", clientApprovalRequired: true, targetUrl: "https://delivery.example.test/about", beforeState: "About us — the Lumina Delivery Team.", afterState: "Alex Synthetic leads the Lumina Delivery Team, helping sellers across the synthetic metro since 2015." }));
  const weekly = must("weekly", await delivery.generateWeeklyDraft(op, { engagementId: d.e.id, intro: "A productive first week." }));
  must("weekly sent", await delivery.markUpdateSent(op, { updateId: weekly.updateId, channel: "email" }));
  must("meeting", await delivery.scheduleMeeting(op, { engagementId: d.e.id, scheduledFor: new Date(Date.now() + 7 * 86_400_000).toISOString() }));
  must("external", await delivery.importExternalMeasurement(op, { engagementId: d.e.id, providerLabel: "Third-party brand radar (SYNTHETIC)", instrument: "Custom prompts", capturedFrom: today, capturedTo: today, rawExport: "prompt,mentioned\nsynthetic,yes", distinguishesRecommendation: "unknown", summary: "Synthetic import for rehearsal — pending QA, hidden from the client." }));
  console.log(`delivery client project: ${d.projectId}`);
  if (process.env.REHEARSAL_STATE_FILE) {
    writeFileSync(process.env.REHEARSAL_STATE_FILE, JSON.stringify({ pendingProjectId: pending.projectId, deliveryProjectId: d.projectId }, null, 2));
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
