/**
 * Spec 131 — the first-client dry run, end to end, against a Ryan-shaped
 * fixture (a shared-market benchmark run the prospect never owned):
 *
 *   SIGNED → commercial gate → ONBOARDING → market definition → exclusivity
 *   → baseline frozen → context → work items with provenance → client
 *   approval gate → blocked item → ACTIVE → change log → remeasurement
 *   (comparable and non-comparable) → renewal by calendar → close/offboard
 *   → cooldown + dispatch gate.
 *
 * Load-bearing: nothing becomes ACTIVE by assertion, the baseline cannot be
 * mutated, a public change never starts before the client's decision is
 * recorded, a second live client in the same market is refused, and after
 * exclusivity a competing prospect's unattended send is refused.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { seedProspect, type PipelineModules } from "../helpers/prospect-fixtures";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };
const clientViewer: CurrentUser = { id: "00000000-0000-4000-8000-000000000002", email: "client@test.local", name: "Client", role: "client_viewer" };

const SCOPE = "AI recommendation diagnosis, evidence improvements, implementation of high-confidence changes, monitoring, remeasurement on the same instrument.";

describe.skipIf(!TEST_URL)("client engagement dry run (integration)", () => {
  let m: PipelineModules;
  let sql: PipelineModules["sql"];
  let eng: typeof import("@/lib/engagements/service");
  let tasks: typeof import("@/lib/tasks/service");
  let portal: typeof import("@/lib/portal/service");
  let gate: typeof import("@/lib/engagements/exclusivity-gate");
  let auth: typeof import("@/lib/auth");
  let mock: typeof import("@/lib/ai/mock");

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
    tasks = await import("@/lib/tasks/service");
    portal = await import("@/lib/portal/service");
    gate = await import("@/lib/engagements/exclusivity-gate");
    auth = await import("@/lib/auth");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
    await sql`update users set role = 'operator' where id = ${operator.id}`;
    await sql`update users set role = 'client_viewer' where id = ${clientViewer.id}`;
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, billing_events, task_client_decisions, engagement_context_items,
       engagement_measurements, client_engagements, user_project_access,
       prospect_activities, prospect_stage_history, outreach_drafts, prospect_benchmarks,
       prospects, market_launches, exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       tasks, evidence, claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Ryan-shaped fixture: the prospect's evidence is a benchmark run on a
   * SHARED market project (benchmark_project_id null), with the prospect
   * recommended in some answers via a lead-agent alias. */
  async function ryanShapedFixture() {
    const f = await seedProspect(m, operator, admin, { projectKind: "prospect" });
    // The prospect company is the subject of the market run's scoring only if
    // parsed; the mock answers name "Lumina"/"Acme". Make the prospect company
    // the one the mock recommends ("Lumina") so counts are non-zero: relink.
    await sql`update prospects set company_id = ${f.subjectCompanyId}, business_name = 'Lumina' where id = ${f.prospectId}`;
    await sql`update prospects set benchmark_project_id = null where id = ${f.prospectId}`;
    await sql`insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by) values (${f.prospectId}, ${f.runId}, ${f.subjectCompanyId}, ${operator.id})`;
    const [acme] = await sql`select id from companies where name = 'Acme'`;
    return { ...f, rivalId: acme!.id as string };
  }

  it("walks SIGNED → ONBOARDING → ACTIVE → work → remeasurement → renewal → close, failing closed at every gate", async () => {
    const f = await ryanShapedFixture();
    const today = new Date().toISOString().slice(0, 10);

    // ---------------------------------------------------------- DAY 0: SIGNED
    const signed = unwrap(
      await eng.signClient(operator, {
        prospectId: f.prospectId,
        startsOn: today,
        monthlyFeeUsd: 7500,
        totalValueUsd: 22500,
        paymentTerms: "Invoice monthly in advance; first payment before onboarding.",
        scopeSummary: SCOPE,
        scopeExclusions: "No SEO, redesign, ads, social, CRM.",
        primaryContactName: "Ana Rivera",
      })
    );
    expect(signed.promoted).toBe(true);
    expect(signed.measurementsPlanned).toBe(2);
    const [prospectRow] = await sql`select stage, promoted_project_id from prospects where id = ${f.prospectId}`;
    expect(prospectRow!.stage).toBe("contracted");
    expect(prospectRow!.promotedProjectId).toBe(signed.projectId);
    // Pre-sale provenance intact: the prospect row and its benchmark remain.
    expect((await sql`select count(*)::int as n from prospect_benchmarks where prospect_id = ${f.prospectId}`)[0]!.n).toBe(1);
    // Territory reserved, not active.
    const e0 = (await eng.engagementForProject(signed.projectId))!;
    expect(e0.stage).toBe("signed");
    expect(e0.exclusivityStatus).toBe("reserved");
    expect(e0.totalValueUsd).toBe(22500);

    // A second live client in the same market is refused (one retained client per market).
    const rivalProspect = unwrap(
      await m.svc.createProspect(operator, { launchId: f.launchId, businessName: "Acme", prospectType: "team", companyId: f.rivalId })
    );
    const second = await eng.signClient(operator, { prospectId: rivalProspect.prospectId, startsOn: today, monthlyFeeUsd: 5000, totalValueUsd: 15000, scopeSummary: SCOPE });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.message).toMatch(/One retained client per market/);

    // ------------------------------------------------ commercial gate (fail closed)
    const tooEarly = await eng.startOnboarding(operator, { engagementId: e0.id });
    expect(tooEarly.ok).toBe(false);
    unwrap(await eng.recordContractStatus(operator, { engagementId: e0.id, status: "signed", contractRef: "drive://contracts/blu-house-2026-09.pdf" }));
    const stillNoPayment = await eng.startOnboarding(operator, { engagementId: e0.id });
    expect(stillNoPayment.ok).toBe(false);
    if (!stillNoPayment.ok) expect(stillNoPayment.error.message).toMatch(/No payment received/);
    // Failure mode 1: first payment fails → nothing progresses; ledger records the truth.
    unwrap(await eng.recordBillingEvent(operator, { engagementId: e0.id, kind: "invoice_created", amountUsd: 7500, dueDate: today, externalInvoiceId: "INV-001" }));
    unwrap(await eng.recordBillingEvent(operator, { engagementId: e0.id, kind: "payment_received", amountUsd: 7500, externalInvoiceId: "INV-001" }));
    unwrap(await eng.startOnboarding(operator, { engagementId: e0.id }));
    expect((await eng.engagementForProject(signed.projectId))!.stage).toBe("onboarding");

    // ---------------------------------------------- exclusivity needs a definition
    const noDef = await eng.activateExclusivity(operator, { engagementId: e0.id });
    expect(noDef.ok).toBe(false);
    unwrap(await eng.confirmMarketDefinition(operator, { engagementId: e0.id, definition: "The borough of Manhattan, residential brokerage, luxury segment; excludes Brooklyn and the wider metro." }));
    unwrap(await eng.activateExclusivity(operator, { engagementId: e0.id }));
    expect((await eng.engagementForProject(signed.projectId))!.exclusivityStatus).toBe("active");

    // Failure mode 14/15: a competing prospect in the protected market — the
    // dispatch gate refuses; the client's own prospect is exempt.
    const rivalGate = await gate.exclusivityGateForProspect(rivalProspect.prospectId);
    expect(rivalGate.blocked).toBe(true);
    expect(rivalGate.detail).toMatch(/Market exclusivity/);
    const ownGate = await gate.exclusivityGateForProspect(f.prospectId);
    expect(ownGate.blocked).toBe(false);
    const conflicts = await eng.marketOutreachConflicts(e0.id);
    expect(conflicts.map((c) => c.businessName)).toEqual(["Acme"]);

    // ------------------------------------------------------ onboarding is derived
    const notYet = await eng.markActive(operator, { engagementId: e0.id });
    expect(notYet.ok).toBe(false);
    if (!notYet.ok) expect(notYet.error.message).toMatch(/Onboarding is not complete/);

    // Client context: public evidence ≠ client priority.
    unwrap(await eng.addContextItem(operator, { engagementId: e0.id, kind: "priority_area", label: "Tribeca", provenance: "publicly_observed", sourceRef: "benchmark question: tribeca loft" }));
    unwrap(await eng.addContextItem(operator, { engagementId: e0.id, kind: "priority_area", label: "Tribeca", provenance: "client_priority" }));
    unwrap(await eng.addContextItem(operator, { engagementId: e0.id, kind: "asset", label: "https://lumina.io", provenance: "client_confirmed", sourceRef: "https://lumina.io" }));
    const access = unwrap(await eng.addContextItem(operator, { engagementId: e0.id, kind: "access", label: "Website CMS (delegated editor)", provenance: "client_confirmed", accessStatus: "requested" }));
    const secret = await eng.addContextItem(operator, { engagementId: e0.id, kind: "access", label: "Zillow login", provenance: "client_confirmed", accessStatus: "granted", value: { password: "hunter2" } });
    expect(secret.ok).toBe(false);

    // -------------------------------------------------------- baseline frozen
    const frozen = unwrap(await eng.freezeBaseline(operator, { engagementId: e0.id, provider: "mock" }));
    expect(frozen.snapshot.answerCount).toBe(6);
    expect(frozen.snapshot.subject.recommendedCount).toBeGreaterThan(0);
    expect(frozen.snapshot.questions.every((q) => q.responseIds.length === 3)).toBe(true);
    const twice = await eng.freezeBaseline(operator, { engagementId: e0.id, provider: "mock" });
    expect(twice.ok).toBe(false);
    // Immutable: no UPDATE of the snapshot, no DELETE.
    await expect(sql`update engagement_measurements set snapshot = '{}'::jsonb where id = ${frozen.measurementId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from engagement_measurements where id = ${frozen.measurementId}`).rejects.toThrow(/never deleted/);
    // Alias drift after the freeze does not move the baseline.
    await sql`update companies set aliases = array['Lumina Team'] where id = ${f.subjectCompanyId}`;
    const [after] = await sql`select snapshot from engagement_measurements where id = ${frozen.measurementId}`;
    expect((after!.snapshot as { subject: { aliases: string[] } }).subject.aliases).toEqual([]);

    // -------------------------------------------------------- work with provenance
    const evidenceResponse = frozen.snapshot.questions[0]!.responseIds[0]!;
    const w1 = unwrap(await tasks.suggestTask(operator, { projectId: signed.projectId, title: "Align person/team identity on owned pages", evidence: [{ kind: "response", refId: evidenceResponse, note: "Baseline answers surface the person and the team separately." }] }));
    unwrap(await tasks.updateTaskProvenance(operator, { taskId: w1.taskId, observation: "Person and team surfaced separately.", hypothesis: "Consistent public identity may improve representation.", confidence: "high_confidence", control: "we_control", clientApprovalRequired: true, targetUrl: "https://lumina.io/about", beforeState: "About page names the team only." }));
    unwrap(await tasks.updateTaskDetails(operator, { taskId: w1.taskId, clientVisible: true }));
    const w2 = unwrap(await tasks.suggestTask(operator, { projectId: signed.projectId, title: "Audit verified profile consistency (Zillow, Realtor.com)", evidence: [{ kind: "response", refId: evidenceResponse, note: "Portals repeatedly appear in answers." }] }));
    unwrap(await tasks.updateTaskProvenance(operator, { taskId: w2.taskId, observation: "Zillow / Realtor.com repeatedly appeared.", confidence: "medium_confidence", control: "third_party" }));
    const w3 = unwrap(await tasks.suggestTask(operator, { projectId: signed.projectId, title: "Neighborhood questions where the rival leads", evidence: [{ kind: "response", refId: evidenceResponse, note: "Rival recommended on neighborhood questions." }] }));
    unwrap(await tasks.blockTask(operator, { taskId: w3.taskId, reason: "client_input", note: "Confirm whether these neighborhoods matter." }));
    unwrap(await tasks.approveTask(operator, { taskId: w3.taskId }));
    expect((await tasks.startTask(operator, { taskId: w3.taskId })).ok).toBe(false);
    // Failure mode 4: the client says the neighborhood is irrelevant → the
    // approved-but-blocked item is declined, not worked; its blocker clears.
    unwrap(await tasks.rejectTask(operator, { taskId: w3.taskId }));
    const [w3Row] = await sql`select status, blocked_reason from tasks where id = ${w3.taskId}`;
    expect(w3Row).toMatchObject({ status: "rejected", blockedReason: null });

    // Approval gate: a public change never starts before the client's decision.
    unwrap(await tasks.approveTask(operator, { taskId: w1.taskId }));
    const startBlocked = await tasks.startTask(operator, { taskId: w1.taskId });
    expect(startBlocked.ok).toBe(false);
    if (!startBlocked.ok) expect(startBlocked.error.message).toMatch(/Client approval/);
    // Failure mode 5: client rejects → still cannot start; then approves.
    unwrap(await tasks.recordClientDecision(operator, { taskId: w1.taskId, decision: "rejected", channel: "email", note: "Not that wording." }));
    expect((await tasks.startTask(operator, { taskId: w1.taskId })).ok).toBe(false);
    unwrap(await tasks.recordClientDecision(operator, { taskId: w1.taskId, decision: "approved", channel: "email", note: "Approved the revised copy." }));
    expect((await sql`select count(*)::int as n from task_client_decisions where task_id = ${w1.taskId}`)[0]!.n).toBe(2);
    await expect(sql`delete from task_client_decisions where task_id = ${w1.taskId}`).rejects.toThrow();
    unwrap(await tasks.startTask(operator, { taskId: w1.taskId }));
    unwrap(await tasks.updateTaskProvenance(operator, { taskId: w1.taskId, afterState: "About page names Ana Rivera as lead of Rivera Team." }));
    unwrap(await tasks.completeTask(operator, { taskId: w1.taskId }));

    // Access resolved → checklist complete → ACTIVE.
    unwrap(await eng.setAccessStatus(operator, { itemId: access.itemId, accessStatus: "granted" }));
    const activated = unwrap(await eng.markActive(operator, { engagementId: e0.id }));
    expect(activated.checklist.every((c) => c.done)).toBe(true);

    // ------------------------------------------------------------ overview + portal
    const view = (await eng.engagementOverview(signed.projectId))!;
    expect(view.derivedStage).toBe("active");
    expect(view.changes.map((c) => c.title)).toContain("Align person/team identity on owned pages");
    expect(view.changes[0]!.before).toMatch(/team only/);
    expect(view.changes[0]!.after).toMatch(/Ana Rivera/);
    expect(view.weeklyUpdate).toMatch(/DONE — what changed this week\n- Align person\/team identity/);
    expect(view.nextMeasurement?.role).toBe("midpoint");
    expect(view.billing.receivedCents).toBe(750_000);

    await sql`insert into user_project_access (user_id, project_id) values (${clientViewer.id}, ${signed.projectId})`;
    const clientView = (await portal.portalEngagement(clientViewer, signed.projectId))!;
    expect(clientView.baseline?.recommendedCount).toBe(frozen.snapshot.subject.recommendedCount);
    expect(clientView.changed.map((c) => c.title)).toEqual(["Align person/team identity on owned pages"]);
    expect(JSON.stringify(clientView)).not.toMatch(/7500|22500|INV-001|override/);
    // Failure mode 16: another project is a 404 for the client account.
    const other = unwrap(await m.projectSvc.createProject(admin, { name: "Other client" }));
    await expect(portal.portalEngagement(clientViewer, other.id)).rejects.toBeInstanceOf(auth.ProjectAccessError);

    // -------------------------------------------------------------- remeasurement
    // The alias drift above was a mutation test; restore the instrument so the
    // remeasurement is the same instrument (drift itself grades medium — unit-tested).
    await sql`update companies set aliases = '{}' where id = ${f.subjectCompanyId}`;
    const [version] = await sql`select prompt_set_version_id from runs where id = ${f.runId}`;
    const rerun = unwrap(await m.runSvc.startRun(operator, { projectId: f.projectId, promptSetVersionId: version!.promptSetVersionId as string, providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }], budgetUsd: 5, label: "midpoint" }));
    await sql`update runs set reuse_captures = false where id = ${rerun.id}`;
    const { drainJobs } = await import("../helpers/prospect-fixtures");
    await drainJobs(m);
    const midpointSlot = view.measurements.find((x) => x.role === "midpoint" && x.status === "planned")!;
    const measured = unwrap(await eng.recordMeasurement(operator, { engagementId: e0.id, runId: rerun.id, measurementId: midpointSlot.id }));
    expect(measured.comparability.grade).toBe("high");
    expect(measured.comparison?.statement).toMatch(/observed movement, not an attribution/);
    expect(measured.comparison?.baselineAnswerCount).toBe(6);

    // Failure mode 17: a changed instrument (different question set) is NON_COMPARABLE.
    const set2 = unwrap(await m.setSvc.createPromptSet(operator, { projectId: f.projectId, name: "Set v2" }));
    unwrap(await m.promptSvc.addPrompt(operator, { setId: set2.id, text: "who is the best broker in soho?", category: "recommendation" }));
    unwrap(await m.setSvc.freezePromptSet(operator, { id: set2.id }));
    const [v2] = await sql`select id from prompt_set_versions where prompt_set_id = ${set2.id}`;
    const run3 = unwrap(await m.runSvc.startRun(operator, { projectId: f.projectId, promptSetVersionId: v2!.id as string, providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }], budgetUsd: 5, label: "changed instrument" }));
    await drainJobs(m);
    const nonComparable = unwrap(await eng.recordMeasurement(operator, { engagementId: e0.id, runId: run3.id }));
    expect(nonComparable.comparability.grade).toBe("not_comparable");
    expect(nonComparable.comparison).toBeNull();
    const [ncRow] = await sql`select status from engagement_measurements where id = ${nonComparable.measurementId}`;
    expect(ncRow!.status).toBe("non_comparable");
    // Failure mode 8: a run that has not finished is never recorded.
    const pending = unwrap(await m.runSvc.startRun(operator, { projectId: f.projectId, promptSetVersionId: version!.promptSetVersionId as string, providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }], budgetUsd: 5, label: "pending" }));
    const early = await eng.recordMeasurement(operator, { engagementId: e0.id, runId: pending.id });
    expect(early.ok).toBe(false);

    // ------------------------------------------------ DAY 70+: renewal by calendar
    const at70 = new Date(Date.now() + 70 * 86_400_000);
    const late = (await eng.engagementOverview(signed.projectId, at70))!;
    expect(late.derivedStage).toBe("renewal_review");
    expect(late.renewalStatus).toBe("due");
    expect(late.nextAction).toMatch(/renewal review/);

    // ------------------------------------------------------------- DAY 90: close
    const closed = unwrap(await eng.closeEngagement(admin, { engagementId: e0.id, outcome: "completed", reason: "Term ended; client did not renew." }));
    expect(closed.portalGrantsRevoked).toBe(1);
    expect(closed.measurementsCancelled).toBe(1); // the final slot
    expect(closed.agreementTerminatedOn).toBe(e0.endsOn);
    const [agreement] = await sql`select status, terminated_at from exclusivity_agreements where id = ${e0.exclusivityAgreementId}`;
    expect(agreement!.status).toBe("terminated");
    const [former] = await sql`select do_not_contact, do_not_contact_reason from prospects where id = ${f.prospectId}`;
    expect(former!.doNotContact).toBe(true);
    expect(former!.doNotContactReason).toMatch(/Former client/);
    expect((await eng.engagementForProject(signed.projectId))!.stage).toBe("completed");
    // Historical record intact; portal door closed.
    await expect(portal.portalEngagement(clientViewer, signed.projectId)).rejects.toBeInstanceOf(auth.ProjectAccessError);
    expect((await sql`select count(*)::int as n from engagement_measurements where engagement_id = ${e0.id}`)[0]!.n).toBe(4); // baseline, midpoint, final (cancelled), ad-hoc non-comparable
    // Exclusivity is protected THROUGH the end date and released the day after.
    const { addDays } = await import("@/lib/engagements/rules");
    expect((await gate.exclusivityGateForProspect(rivalProspect.prospectId, e0.endsOn)).blocked).toBe(true);
    expect((await gate.exclusivityGateForProspect(rivalProspect.prospectId, addDays(e0.endsOn, 1))).blocked).toBe(false);
  });

  it("renewal opens a new signed term with baseline lineage and keeps the market protected", async () => {
    const f = await ryanShapedFixture();
    const today = new Date().toISOString().slice(0, 10);
    const signed = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, startsOn: today, monthlyFeeUsd: 7500, totalValueUsd: 22500, scopeSummary: SCOPE }));
    const e0 = (await eng.engagementForProject(signed.projectId))!;
    const renewed = unwrap(await eng.renewEngagement(admin, { engagementId: e0.id, monthlyFeeUsd: 7500, totalValueUsd: 22500 }));
    const next = (await eng.getEngagement(renewed.engagementId))!;
    expect(next.stage).toBe("signed");
    expect(next.previousEngagementId).toBe(e0.id);
    expect(next.startsOn).toBe(e0.endsOn);
    expect((await eng.getEngagement(e0.id))!.stage).toBe("renewed");
    // Still exactly one live engagement for the project.
    expect((await eng.listLiveEngagements()).filter((x) => x.projectId === signed.projectId)).toHaveLength(1);
  });

  it("the send gate refuses a competing prospect's draft once exclusivity is active", async () => {
    const f = await ryanShapedFixture();
    const today = new Date().toISOString().slice(0, 10);
    const signed = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, startsOn: today, monthlyFeeUsd: 7500, totalValueUsd: 22500, scopeSummary: SCOPE }));
    const e0 = (await eng.engagementForProject(signed.projectId))!;
    unwrap(await eng.recordContractStatus(operator, { engagementId: e0.id, status: "signed", contractRef: "ref" }));
    unwrap(await eng.startOnboarding(admin, { engagementId: e0.id, overrideReason: "Founder: invoice net-7, kickoff Monday." }));
    unwrap(await eng.confirmMarketDefinition(operator, { engagementId: e0.id, definition: "The borough of Manhattan, residential brokerage, luxury segment only." }));
    unwrap(await eng.activateExclusivity(operator, { engagementId: e0.id }));

    const rival = unwrap(await m.svc.createProspect(operator, { launchId: f.launchId, businessName: "Acme", prospectType: "team", companyId: f.rivalId, email: "acme@example.com" }));
    const [bench] = await sql`insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by) values (${rival.prospectId}, ${f.runId}, ${f.rivalId}, ${operator.id}) returning id`;
    const [finding] = await sql`
      insert into prospect_findings (prospect_id, benchmark_id, kind, title, explanation, generator_version)
      values (${rival.prospectId}, ${bench!.id}, 'absence', 'Absent from answers', 'Not recommended in the market benchmark.', 'test-v1')
      returning id
    `;
    const [draft] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, subject, body, generated_by, status, approved_by, approved_at, created_by, scheduled_send_at, scheduled_by, scheduled_business_purpose)
      values (${rival.prospectId}, ${finding!.id}, 'email', 'Hi', 'Cold outreach body text that is long enough.', 'operator', 'approved', ${operator.id}, now(), ${operator.id}, now(), ${operator.id}, 'Cold outreach to a Manhattan prospect')
      returning id
    `;
    const send = await m.svc.sendProspectDraft(operator, { draftId: draft!.id as string, channel: "mock", businessPurpose: "Cold outreach to a Manhattan prospect", unattended: true });
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.error.message).toMatch(/Territory conflict/);

    const paused = unwrap(await eng.pauseMarketOutreach(operator, { engagementId: e0.id }));
    expect(paused.prospects).toBe(1);
    expect(paused.draftsUnscheduled).toBe(1);
    const [rivalRow] = await sql`select conflict_status from prospects where id = ${rival.prospectId}`;
    expect(rivalRow!.conflictStatus).toBe("blocked");
  });
});
