/**
 * Spec 154 — client onboarding and 90-day delivery, end to end, on a
 * SYNTHETIC Medina-like client (mock provider; no real client data):
 *
 *   commercial gate → welcome → extended intake → 64-question import →
 *   question approval → protocol acceptance (immutable) → baseline gate →
 *   pending → measured portal → roadmap draft/publish → approval bound to
 *   wording → weekly update (canonical, immutable once sent) → check-in →
 *   external measurement (hidden until verified) → Day-90 review (no fee
 *   decision) → offboarding, plus tenant isolation and client write refusal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { drainJobs, seedProspect, type PipelineModules } from "../helpers/prospect-fixtures";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "client-delivery", "synthetic-64-seller-questions.csv"), "utf8");

const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };
const clientViewer: CurrentUser = { id: "00000000-0000-4000-8000-000000000002", email: "client@test.local", name: "Client", role: "client_viewer" };

const SCOPE = "AI recommendation diagnosis, evidence improvements, implementation of high-confidence changes, monitoring, remeasurement on the same instrument.";

describe.skipIf(!TEST_URL)("client onboarding and 90-day delivery (integration, spec 154)", () => {
  let m: PipelineModules;
  let sql: PipelineModules["sql"];
  let eng: typeof import("@/lib/engagements/service");
  let intake: typeof import("@/lib/engagements/onboarding-intake");
  let delivery: typeof import("@/lib/engagements/delivery");
  let portal: typeof import("@/lib/portal/delivery");
  let tasks: typeof import("@/lib/tasks/service");
  let plans: typeof import("@/lib/plans/service");
  let auth: typeof import("@/lib/auth");

  beforeAll(async () => {
    const { sql: s } = await import("@/db/client");
    sql = s;
    m = {
      sql: s,
      projectSvc: await import("@/lib/projects/service"),
      setSvc: await import("@/lib/prompts/set-service"),
      promptSvc: await import("@/lib/prompts/prompt-service"),
      runSvc: await import("@/lib/runs/service"),
      execute: await import("@/lib/runs/execute"),
      jobs: await import("@/db/jobs"),
      companySvc: await import("@/lib/companies/service"),
      claims: await import("@/lib/claims/service"),
      parsing: await import("@/lib/parsing/service"),
      scoring: await import("@/lib/scoring/compute"),
      exclusivity: await import("@/lib/exclusivity/service"),
      svc: await import("@/lib/prospects/service"),
    };
    eng = await import("@/lib/engagements/service");
    intake = await import("@/lib/engagements/onboarding-intake");
    delivery = await import("@/lib/engagements/delivery");
    portal = await import("@/lib/portal/delivery");
    tasks = await import("@/lib/tasks/service");
    plans = await import("@/lib/plans/service");
    auth = await import("@/lib/auth");
    await seedTestActors(sql);
    await sql`update users set role = 'operator' where id = ${operator.id}`;
    await sql`update users set role = 'client_viewer' where id = ${clientViewer.id}`;
  });

  beforeEach(async () => {
    const { truncateAll } = await import("../helpers/db");
    await truncateAll(sql);
    await sql`update users set role = 'operator' where id = ${operator.id}`;
    await sql`update users set role = 'client_viewer' where id = ${clientViewer.id}`;
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Signed, contract recorded, activation payment received, onboarding started. */
  async function onboardedClient() {
    const f = await seedProspect(m, operator, admin, { projectKind: "prospect" });
    await sql`update prospects set company_id = ${f.subjectCompanyId}, business_name = 'Lumina' where id = ${f.prospectId}`;
    await sql`insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by) values (${f.prospectId}, ${f.runId}, ${f.subjectCompanyId}, ${operator.id})`;
    const today = new Date().toISOString().slice(0, 10);
    const signed = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, startsOn: today, monthlyFeeUsd: 1000, totalValueUsd: 1000, priceOverrideReason: "synthetic test terms (spec 154)", scopeSummary: SCOPE, primaryContactName: "Alex Synthetic" }));
    const e = (await eng.engagementForProject(signed.projectId))!;
    // Commercial gate fails closed: no welcome, no onboarding.
    expect((await delivery.generateWelcomeDraft(operator, { engagementId: e.id, agencyContactName: "Founder" })).ok).toBe(false);
    expect((await eng.startOnboarding(operator, { engagementId: e.id })).ok).toBe(false);
    unwrap(await eng.recordContractStatus(operator, { engagementId: e.id, status: "signed", contractRef: "drive://synthetic/contract.pdf" }));
    expect((await eng.startOnboarding(operator, { engagementId: e.id })).ok).toBe(false);
    unwrap(await eng.recordBillingEvent(operator, { engagementId: e.id, kind: "payment_received", amountUsd: 1000, externalInvoiceId: "SYN-001" }));
    unwrap(await eng.startOnboarding(operator, { engagementId: e.id }));
    const [acme] = await sql`select id from companies where name = 'Acme'`;
    const competitors = await import("@/lib/competitors/service");
    await competitors.addCompetitor(operator, { projectId: signed.projectId, companyId: acme!.id as string, tier: "primary" });
    await sql`insert into user_project_access (user_id, project_id) values (${clientViewer.id}, ${signed.projectId})`;
    return { f, projectId: signed.projectId, engagementId: e.id };
  }

  it("walks a synthetic client from activation to Day 90 without inventing a result", async () => {
    const { f, projectId, engagementId } = await onboardedClient();

    // ------------------------------------------------------------ welcome
    process.env.APP_URL = "https://app.example.test";
    const welcome = unwrap(await delivery.generateWelcomeDraft(operator, { engagementId, agencyContactName: "Founder" }));
    delete process.env.APP_URL;
    expect(welcome.body.text).toContain("https://app.example.test/portal");
    expect(welcome.body.text).not.toContain(projectId);
    expect(welcome.body.text).not.toMatch(/\$1,000|1000|SYN-001/);
    // Drafts never reach the client.
    expect((await portal.portalUpdates(clientViewer, projectId))!.updates).toHaveLength(0);
    unwrap(await delivery.markUpdateSent(operator, { updateId: welcome.updateId, channel: "email" }));
    await expect(sql`update engagement_updates set body = '{}'::jsonb where id = ${welcome.updateId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from engagement_updates where id = ${welcome.updateId}`).rejects.toThrow(/never deleted/);
    expect((await portal.portalUpdates(clientViewer, projectId))!.updates.map((u) => u.kind)).toEqual(["welcome"]);

    // ------------------------------------------------------------ pending
    let overview = (await portal.portalDeliveryOverview(clientViewer, projectId))!;
    expect(overview.results.status).toBe("pending");
    expect(overview.results.baseline).toBeNull();
    expect(overview.currentStep?.key).toBe("details");
    expect(JSON.stringify(overview)).not.toMatch(/SYN-001|override|payment|1000/);

    // ------------------------------------------------------- extended intake
    const prefill = (await intake.onboardingPrefill(engagementId))!;
    expect(prefill.prefilled).toContain("primaryContactName");
    unwrap(await intake.completeOnboardingIntake(operator, {
      engagementId,
      legalName: "Synthetic Seller Team LLC",
      brandName: "Lumina",
      website: "https://lumina.example.test",
      primaryContactName: "Alex Synthetic",
      contactEmail: "alex@lumina.example.test",
      marketDefinition: "City of Albuquerque plus confirmed metro communities; residential seller listings only.",
      priorities: ["Seller listings $300K+"],
      websiteControl: "client_applies_changes",
      customerSegments: ["Sellers $300K–$499K", "Luxury sellers"],
      minPropertyValueUsd: 300_000,
      neighborhoods: ["Northeast Heights", "North Valley"],
      surroundingMarkets: ["Corrales"],
      nameVariants: ["Lumina Team"],
      approvers: [{ name: "Alex Synthetic", email: "alex@lumina.example.test" }],
    }));
    const [subjectRow] = await sql`select aliases from companies where id = ${f.subjectCompanyId}`;
    expect(subjectRow!.aliases).toEqual([]); // name variants are recorded, never auto-applied

    // ------------------------------------------------------- question import
    const bad = await delivery.importClientQuestions(operator, { engagementId, setName: "Bad", content: "question,segment\nIs Lumina good for selling?,Core $300K–$499K\nSell my $200K home?,Core $300K–$499K" });
    expect(bad.ok).toBe(false);
    expect((await sql`select count(*)::int as n from prompt_sets where project_id = ${projectId}`)[0]!.n).toBe(0);
    const dry = unwrap(await delivery.importClientQuestions(operator, { engagementId, setName: "Seller questions", content: FIXTURE, dryRun: true }));
    expect(dry.review.rows).toHaveLength(64);
    expect(dry.floorUsd).toBe(300_000);
    expect(dry.versionId).toBeNull();
    const imported = unwrap(await delivery.importClientQuestions(operator, { engagementId, setName: "Seller questions", content: FIXTURE, defaultAudience: "seller" }));
    const [version] = await sql`select frozen_prompts from prompt_set_versions where id = ${imported.versionId}`;
    const frozen = version!.frozenPrompts as { priceTier: string | null; audience: string | null }[];
    expect(frozen).toHaveLength(64);
    expect(frozen.filter((q) => q.priceTier === "Estate $1.5M+")).toHaveLength(8);
    expect(frozen.every((q) => q.audience === "seller")).toBe(true);

    // --------------------------------------------------------- protocol
    const draft = unwrap(await delivery.saveProtocolDraft(operator, {
      engagementId, promptSetVersionId: imported.versionId!, provider: "mock", model: "mock-model",
      geographicContext: "Albuquerque metro (synthetic)", repetitions: 1, baselineWindow: "Week 1", finalWindow: "Days 80–85",
      entityAliases: ["Lumina", "Lumina Team"],
    }));
    let accept = await delivery.acceptProtocol(operator, { protocolId: draft.protocolId, clientActor: "Alex Synthetic", channel: "email" });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.error.message).toMatch(/not approved the question set/);
    unwrap(await delivery.recordSubjectDecision(operator, { engagementId, subjectKind: "question_set", subjectRef: imported.versionId!, decision: "changes_requested", channel: "email", clientActor: "Alex Synthetic", note: "Swap one area" }));
    expect((await delivery.acceptProtocol(operator, { protocolId: draft.protocolId, clientActor: "Alex", channel: "email" })).ok).toBe(false);
    unwrap(await delivery.recordSubjectDecision(operator, { engagementId, subjectKind: "question_set", subjectRef: imported.versionId!, decision: "approved", channel: "email", clientActor: "Alex Synthetic" }));
    accept = await delivery.acceptProtocol(operator, { protocolId: draft.protocolId, clientActor: "Alex Synthetic", channel: "email" });
    expect(accept.ok).toBe(false);
    if (!accept.ok) expect(accept.error.message).toMatch(/successCriteria/);
    unwrap(await delivery.saveProtocolDraft(operator, {
      engagementId, promptSetVersionId: imported.versionId!, provider: "mock", model: "mock-model",
      geographicContext: "Albuquerque metro (synthetic)", repetitions: 1, baselineWindow: "Week 1", finalWindow: "Days 80–85",
      entityAliases: ["Lumina", "Lumina Team"], successCriteria: "Synthetic: agreed threshold written here by people.",
    }));
    unwrap(await delivery.acceptProtocol(operator, { protocolId: draft.protocolId, clientActor: "Alex Synthetic", channel: "email" }));
    await expect(sql`update engagement_protocols set success_criteria = 'moved goalposts' where id = ${draft.protocolId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from engagement_protocols where id = ${draft.protocolId}`).rejects.toThrow(/never deleted/);
    expect((await delivery.recordSubjectDecision(operator, { engagementId, subjectKind: "protocol", subjectRef: draft.protocolId, decision: "approved", channel: "email", clientActor: "x" })).ok).toBe(false);

    // ---------------------------------------------------------- baseline gate
    expect((await eng.freezeBaseline(operator, { engagementId })).ok).toBe(false); // run is explicit
    const wrongRun = await eng.freezeBaseline(operator, { engagementId, runId: f.runId, acknowledgeWarnings: true });
    expect(wrongRun.ok).toBe(false);
    if (!wrongRun.ok) expect(wrongRun.error.message).toMatch(/different question set version/);
    const run = unwrap(await m.runSvc.startRun(operator, { projectId, promptSetVersionId: imported.versionId!, providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }], budgetUsd: 5, label: "baseline" }));
    await sql`update runs set reuse_captures = false where id = ${run.id}`;
    // Interrupted pipeline: captured but not parsed → refused.
    await m.execute.executeRun(run.id); // capture only; parse jobs stay queued
    const notParsed = await eng.freezeBaseline(operator, { engagementId, runId: run.id, acknowledgeWarnings: true });
    expect(notParsed.ok).toBe(false);
    if (!notParsed.ok) expect(notParsed.error.message).toMatch(/not parsed|Agreed name variants/);
    await drainJobs(m);
    const missingAlias = await eng.freezeBaseline(operator, { engagementId, runId: run.id, acknowledgeWarnings: true });
    expect(missingAlias.ok).toBe(false);
    if (!missingAlias.ok) expect(missingAlias.error.message).toMatch(/Lumina Team/);
    await sql`update companies set aliases = array['Lumina Team'] where id = ${f.subjectCompanyId}`;
    const unacknowledged = await eng.freezeBaseline(operator, { engagementId, runId: run.id });
    expect(unacknowledged.ok).toBe(false);
    if (!unacknowledged.ok) expect(unacknowledged.error.message).toMatch(/Acknowledge/);
    const baseline = unwrap(await eng.freezeBaseline(operator, { engagementId, runId: run.id, acknowledgeWarnings: true }));
    expect(baseline.snapshot.answerCount).toBe(64);
    expect(baseline.snapshot.questions.filter((q) => q.segment?.priceTier === "Luxury $750K–$1.49M")).toHaveLength(16);
    // The accepted protocol cannot be replaced once the baseline is locked.
    const v2 = unwrap(await delivery.saveProtocolDraft(operator, { engagementId, promptSetVersionId: imported.versionId!, provider: "mock", model: "mock-model", geographicContext: "x", repetitions: 1, baselineWindow: "x", finalWindow: "x", successCriteria: "lower bar", entityAliases: ["Lumina"] }));
    expect((await delivery.acceptProtocol(operator, { protocolId: v2.protocolId, clientActor: "Alex", channel: "email" })).ok).toBe(false);

    // ---------------------------------------------------- measured portal
    overview = (await portal.portalDeliveryOverview(clientViewer, projectId))!;
    expect(overview.results.status).toBe("measured");
    expect(overview.results.latest?.isBaseline).toBe(true);
    expect(overview.results.change).toBeNull();
    expect(overview.results.baseline?.answers).toBe(64);
    expect(overview.results.baseline?.providerLabel).toMatch(/synthetic/i);
    const results = (await portal.portalResults(clientViewer, projectId))!;
    expect(results.segments!.priceTier.map((s) => s.segment)).toEqual(["Core $300K–$499K", "Move-up $500K–$749K", "Luxury $750K–$1.49M", "Estate $1.5M+"]);
    expect(results.caveats.join(" ")).toMatch(/does not represent all ChatGPT usage/);
    const answerId = results.questions[0]!.responseIds[0]!;
    const answer = await portal.portalAnswer(clientViewer, projectId, answerId);
    expect(answer.answer).toMatch(/mock answer/);

    // ---------------------------------------------------------- roadmap
    const drafted = unwrap(await delivery.draftPlanFromBaseline(operator, { projectId }));
    expect(await portal.portalPlan(clientViewer, projectId)).toBeNull(); // draft = not published
    const firstItem = unwrap(await delivery.addPlanItem(operator, { planId: drafted.planId, phase: "foundation", title: "Publish seller FAQ page", rationale: "Baseline answers rarely cite a seller-focused page from the client site.", owner: "operator", evidenceResponseIds: [answerId] }));
    const secondItem = unwrap(await delivery.addPlanItem(operator, { planId: drafted.planId, phase: "authority", title: "Request reviews from recent sellers", rationale: "Third-party seller reviews appear alongside rival recommendations.", owner: "client", dependsOn: [firstItem.planItemId] }));
    expect((await delivery.addPlanItem(operator, { planId: drafted.planId, phase: "foundation", title: "Foreign evidence", rationale: "Cites an answer from another tenant.", evidenceResponseIds: [(await sql`select id from responses where run_id = ${f.runId} limit 1`)[0]!.id as string] })).ok).toBe(false);
    unwrap(await delivery.applyPhaseDueDates(operator, { planId: drafted.planId }));
    unwrap(await plans.approvePlan(operator, { planId: drafted.planId }));
    const clientPlan = (await portal.portalPlan(clientViewer, projectId))!;
    const authority = clientPlan.phases.find((p) => p.key === "authority")!;
    expect(authority.items.find((i) => i.id === secondItem.planItemId)!.dependsOn).toEqual(["Publish seller FAQ page"]);
    expect(clientPlan.phases.every((p) => p.items.every((i) => i.dueOn))).toBe(true);

    // ------------------------------------- approval bound to exact wording
    const activated = unwrap(await plans.activatePlanItem(operator, { planItemId: firstItem.planItemId }));
    const taskId = activated.taskId;
    unwrap(await tasks.updateTaskDetails(operator, { taskId, clientVisible: true }));
    unwrap(await tasks.updateTaskProvenance(operator, { taskId, observation: "No seller FAQ.", hypothesis: "A seller FAQ gives assistants a citable seller page.", confidence: "medium_confidence", control: "we_control", clientApprovalRequired: true, targetUrl: "https://lumina.example.test/sell", beforeState: "No page.", afterState: "FAQ v1 wording." }));
    let approvals = (await portal.portalApprovals(clientViewer, projectId))!;
    expect(approvals.changes[0]).toMatchObject({ status: "waiting", proposedText: "FAQ v1 wording." });
    unwrap(await tasks.recordClientDecision(operator, { taskId, decision: "approved", channel: "email", clientActor: "Alex Synthetic" }));
    unwrap(await tasks.updateTaskProvenance(operator, { taskId, afterState: "FAQ v2 wording — changed after approval." }));
    expect((await sql`select client_approval from tasks where id = ${taskId}`)[0]!.clientApproval).toBe("required");
    expect((await tasks.startTask(operator, { taskId })).ok).toBe(false);
    unwrap(await tasks.recordClientDecision(operator, { taskId, decision: "approved", channel: "email", clientActor: "Alex Synthetic" }));
    unwrap(await tasks.startTask(operator, { taskId }));
    unwrap(await tasks.completeTask(operator, { taskId }));
    approvals = (await portal.portalApprovals(clientViewer, projectId))!;
    expect(approvals.changes[0]!.history.map((h) => h.wording)).toEqual(["FAQ v2 wording — changed after approval.", "FAQ v1 wording."]);
    expect(approvals.decisions.some((d) => d.subject === "Measurement protocol")).toBe(true);

    // ---------------------------------------------------- weekly update
    const intro = await delivery.generateWeeklyDraft(operator, { engagementId, intro: "Our FAQ led to a 20% lift." });
    expect(intro.ok).toBe(false);
    const weekly = unwrap(await delivery.generateWeeklyDraft(operator, { engagementId, intro: "A good first week." }));
    expect(weekly.body.text).toMatch(/Publish seller FAQ page \(https:\/\/lumina.example.test\/sell\) — now: FAQ v2/);
    expect(weekly.body.text).toMatch(/No comparable measurement was taken this week/);
    expect(weekly.body.refs.some((r) => r.id === taskId)).toBe(true);
    unwrap(await delivery.markUpdateSent(operator, { updateId: weekly.updateId, channel: "email" }));
    const view = (await eng.engagementOverview(projectId))!;
    expect(view.lastClientUpdate).not.toBeNull(); // cadence signal fed by the same audit action

    // --------------------------------------------------------- check-in
    const inTwoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const meeting = unwrap(await delivery.scheduleMeeting(operator, { engagementId, scheduledFor: inTwoWeeks }));
    overview = (await portal.portalDeliveryOverview(clientViewer, projectId))!;
    expect(overview.nextMeeting).not.toBeNull();
    unwrap(await delivery.recordMeetingNotes(operator, { meetingId: meeting.meetingId, status: "held", notes: "Reviewed FAQ.", actionItems: [{ text: "Send seller testimonials", owner: "client", dueOn: null }] }));
    await expect(sql`delete from engagement_meetings where id = ${meeting.meetingId}`).rejects.toThrow();

    // ------------------------------------------------ external measurement
    const ext = unwrap(await delivery.importExternalMeasurement(operator, { engagementId, providerLabel: "Third-party brand radar (synthetic)", capturedFrom: "2026-11-01", capturedTo: "2026-11-07", rawExport: "prompt,mentioned\nq1,yes", distinguishesRecommendation: "unknown" }));
    expect((await portal.portalResults(clientViewer, projectId))!.external).toHaveLength(0);
    expect((await delivery.setExternalMeasurementQa(operator, { id: ext.id, qaStatus: "pending", qaNote: "checked rows", clientVisible: true })).ok).toBe(false);
    await expect(sql`update external_measurements set raw_export = 'tampered' where id = ${ext.id}`).rejects.toThrow(/immutable/);
    unwrap(await delivery.setExternalMeasurementQa(operator, { id: ext.id, qaStatus: "verified", qaNote: "Rows match the vendor export.", clientVisible: true }));
    const ext2 = (await portal.portalResults(clientViewer, projectId))!.external;
    expect(ext2).toHaveLength(1);
    expect(JSON.stringify(ext2)).not.toMatch(/qaNote|tampered/);
    // The client's own rate is unchanged by the external import (never blended).
    expect((await portal.portalDeliveryOverview(clientViewer, projectId))!.results.baseline?.answers).toBe(64);

    // ------------------------------------------------------- Day 90
    const finalRun = unwrap(await m.runSvc.startRun(operator, { projectId, promptSetVersionId: imported.versionId!, providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }], budgetUsd: 5, label: "final" }));
    await sql`update runs set reuse_captures = false where id = ${finalRun.id}`;
    await drainJobs(m);
    const slot = (await eng.listMeasurements(engagementId)).find((x) => x.role === "final" && x.status === "planned")!;
    const measured = unwrap(await eng.recordMeasurement(operator, { engagementId, runId: finalRun.id, measurementId: slot.id }));
    expect(measured.comparability.grade).not.toBe("not_comparable");
    const review = unwrap(await delivery.generateFinalReviewDraft(operator, { engagementId }));
    expect(review.body.text).toMatch(/does not decide the outcome or any fee/);
    expect(review.body.text).toMatch(/Synthetic: agreed threshold/);
    expect(review.body.text).toMatch(/Publish seller FAQ page/);
    unwrap(await delivery.markUpdateSent(operator, { updateId: review.updateId, channel: "meeting" }));
    const [engRow] = await sql`select stage from client_engagements where id = ${engagementId}`;
    expect(engRow!.stage).toBe("onboarding"); // nothing advanced commercially by itself
    expect((await sql`select count(*)::int as n from billing_events where project_id = ${projectId}`)[0]!.n).toBe(1);

    // ----------------------------------------------------- offboarding
    const state = (await delivery.deliveryState(projectId))!;
    expect(state.offboarding.find((i) => i.key === "final_review")!.done).toBe(true);
    unwrap(await eng.closeEngagement(admin, { engagementId, outcome: "completed", reason: "Term ended (synthetic)." }));
    await expect(portal.portalDeliveryOverview(clientViewer, projectId)).rejects.toBeInstanceOf(auth.ProjectAccessError);
    // Historical records stay.
    expect((await sql`select count(*)::int as n from engagement_updates where engagement_id = ${engagementId} and status = 'sent'`)[0]!.n).toBe(3);
  }, 60_000);

  it("isolates tenants and keeps client roles read-only", async () => {
    const { projectId, engagementId } = await onboardedClient();
    const other = unwrap(await m.projectSvc.createProject(admin, { name: "Other client (synthetic)" }));
    const [foreignResponse] = await sql`select id from responses limit 1`;
    await expect(portal.portalDeliveryOverview(clientViewer, other.id)).rejects.toBeInstanceOf(auth.ProjectAccessError);
    await expect(portal.portalResults(clientViewer, other.id)).rejects.toBeInstanceOf(auth.ProjectAccessError);
    await expect(portal.portalApprovals(clientViewer, other.id)).rejects.toBeInstanceOf(auth.ProjectAccessError);
    // An answer from the shared market run is not this client's evidence (no frozen snapshot cites it).
    await expect(portal.portalAnswer(clientViewer, projectId, foreignResponse!.id as string)).rejects.toBeInstanceOf(auth.ProjectAccessError);
    await expect(portal.portalAnswer(clientViewer, projectId, "../../etc/passwd")).rejects.toBeInstanceOf(auth.ProjectAccessError);
    // Every new write refuses a client role.
    const writes = [
      delivery.importClientQuestions(clientViewer, { engagementId, setName: "x", content: FIXTURE }),
      delivery.recordSubjectDecision(clientViewer, { engagementId, subjectKind: "intake", decision: "approved", channel: "portal", clientActor: "me" }),
      delivery.saveProtocolDraft(clientViewer, { engagementId, promptSetVersionId: engagementId, provider: "mock", model: "m", repetitions: 1 }),
      delivery.generateWeeklyDraft(clientViewer, { engagementId }),
      delivery.scheduleMeeting(clientViewer, { engagementId, scheduledFor: "2026-12-01" }),
      delivery.importExternalMeasurement(clientViewer, { engagementId, providerLabel: "Synthetic vendor", capturedFrom: "2026-11-01", capturedTo: "2026-11-02", rawExport: "x", distinguishesRecommendation: "no" }),
      delivery.createManualPlan(clientViewer, { projectId }),
      delivery.draftPlanFromBaseline(clientViewer, { projectId }),
    ];
    for (const r of await Promise.all(writes)) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(`${r.error.kind}: ${r.error.message}`).toMatch(/^forbidden/);
    }
    // No baseline: no plan draft, no Day-90 review (nothing to compare).
    expect((await delivery.draftPlanFromBaseline(operator, { projectId })).ok).toBe(false);
    expect((await delivery.generateFinalReviewDraft(operator, { engagementId })).ok).toBe(false);
  }, 60_000);
});
