/**
 * Spec 131 — production-safe smoke test of the first-client delivery system.
 *
 * Runs the whole lifecycle against the deployed database using an ISOLATED
 * fixture: its own root market ("QA131 …" — unrelated to every real market, so
 * no real territory can be reserved), its own launch, companies, project,
 * prompt set and synthetic run (provider "qa-fixture" — never matches a real
 * provider, so capture reuse cannot touch it), and fixture users that have no
 * auth identity (cannot log in). No email, no real invoice, no real client.
 *
 * Safety: Ryan's prospect row and every Grand Rapids counter are snapshotted
 * before and compared after; any difference fails the run. Fixtures are
 * archived at the end (raw rows are insert-only by design and stay, clearly
 * named).
 *
 *   npx tsx scripts/spec131-prod-smoke.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { ProjectAccessError } from "@/lib/auth";

const RYAN = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0";
const GRAND_RAPIDS = "d8577c6b-8ae9-4c76-b68a-96abe5a858e2";
const TAG = "QA131";
const SCOPE = "QA fixture: AI recommendation diagnosis, evidence improvements, implementation, monitoring, remeasurement on the same instrument.";

const results: { phase: string; status: "PASS" | "FAIL"; detail: string }[] = [];
function pass(phase: string, detail = "") { results.push({ phase, status: "PASS", detail }); console.log(`PASS ${phase} ${detail}`); }
function failed(phase: string, detail: string) { results.push({ phase, status: "FAIL", detail }); console.log(`FAIL ${phase} ${detail}`); }
function expect(phase: string, cond: boolean, detail: string) { if (cond) pass(phase, detail); else failed(phase, detail); }
const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.data; };
const refused = (r: { ok: boolean; error?: { message: string } }) => !r.ok;
const today = () => new Date().toISOString().slice(0, 10);

async function ryanSnapshot() {
  const [p] = await sql`select stage, do_not_contact, conflict_status, promoted_project_id, benchmark_project_id, updated_at from prospects where id = ${RYAN}`;
  const [gr] = await sql`
    select (select count(*) from exclusivity_scopes s where s.market_id = ${GRAND_RAPIDS} or s.market_id in (select id from markets where parent_id = ${GRAND_RAPIDS}))::int as gr_scopes,
      (select count(*) from client_engagements where market_id = ${GRAND_RAPIDS} or prospect_id = ${RYAN})::int as gr_engagements,
      (select count(*) from outreach_drafts d join prospects p on p.id = d.prospect_id join market_launches l on l.id = p.launch_id where l.market_id = ${GRAND_RAPIDS} and d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is not null)::int as gr_scheduled,
      (select count(*) from outreach_followup_sequences s join prospects p on p.id = s.prospect_id join market_launches l on l.id = p.launch_id where l.market_id = ${GRAND_RAPIDS} and s.status = 'active')::int as gr_sequences,
      (select count(*) from prospects p join market_launches l on l.id = p.launch_id where l.market_id = ${GRAND_RAPIDS} and p.conflict_status = 'blocked')::int as gr_blocked,
      (select count(*) from prospect_outreach_sends where prospect_id = ${RYAN})::int as ryan_sends,
      (select count(*) from billing_events b join projects pr on pr.id = b.project_id where pr.name not like ${TAG + "%"})::int as real_billing,
      (select count(*) from user_project_access)::int as grants
  `;
  return JSON.stringify({ ...p, ...gr });
}

async function actor(): Promise<CurrentUser> {
  const [row] = await sql`select id, email, name, role from users where role = 'admin' and active order by created_at asc limit 1`;
  if (!row) throw new Error("no active admin user");
  return { id: row.id as string, email: row.email as string, name: row.name as string, role: "admin" };
}

async function syntheticRun(projectId: string, versionId: string, subjectId: string, rivalId: string, label: string, subjectHits: number[]) {
  const [run] = await sql`
    insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd, cost_usd, completed_at, reuse_captures)
    values (${projectId}, ${versionId}, ${label}, ${sql.json([{ provider: "qa-fixture", model: "qa-fixture", repetitions: 2 }])}, 'completed', 'manual', 0, 0, now(), false)
    returning id
  `;
  const prompts = await sql`select p."promptId" as prompt_id, p.text from prompt_set_versions v, jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, text text) where v.id = ${versionId} order by p.text`;
  let i = 0;
  for (const pr of prompts) {
    for (const rep of [1, 2]) {
      const hit = subjectHits[i % subjectHits.length] === 1;
      const [resp] = await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text, raw_payload, cost_usd)
        values (${run!.id}, ${pr.promptId}, ${pr.text}, 'qa-fixture', 'qa-fixture', ${rep}, ${`${TAG} synthetic answer: ${hit ? "QA131 Fixture Team and " : ""}QA131 Rival Team.`}, ${sql.json({ qa: TAG })}, 0)
        returning id
      `;
      await sql`insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review) values (${resp!.id}, ${rivalId}, 1, true, true, ${TAG + "-fixture"}, 1, false)`;
      if (hit) await sql`insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review) values (${resp!.id}, ${subjectId}, 1, true, true, ${TAG + "-fixture"}, 1, false)`;
      i += 1;
    }
  }
  return run!.id as string;
}

async function main() {
  const before = await ryanSnapshot();
  const admin = await actor();
  console.log(`actor: ${admin.email} (admin)`);
  const eng = await import("@/lib/engagements/service");
  const tasks = await import("@/lib/tasks/service");
  const portal = await import("@/lib/portal/service");
  const gate = await import("@/lib/engagements/exclusivity-gate");
  const rules = await import("@/lib/engagements/rules");
  const excl = await import("@/lib/exclusivity/service");
  const prospects = await import("@/lib/prospects/service");
  const companies = await import("@/lib/companies/service");
  const projects = await import("@/lib/projects/service");
  const claims = await import("@/lib/claims/service");
  const sets = await import("@/lib/prompts/set-service");
  const promptSvc = await import("@/lib/prompts/prompt-service");
  const queue = await import("@/lib/control-tower/queue");

  const [mig] = await sql`select 1 from schema_migrations where name = '105_client_engagements.sql'`;
  expect("migration 105 applied", Boolean(mig), "schema_migrations has 105");

  // ------------------------------------------------------------ fixtures
  const stamp = Date.now().toString(36);
  const marketName = `${TAG} Sandbox Market ${stamp}`;
  const market = unwrap(await excl.createMarket(admin, { name: marketName, kind: "custom", aliases: [] }));
  const nested = unwrap(await excl.createMarket(admin, { name: `${TAG} Sandbox Nested ${stamp}`, kind: "neighborhood", aliases: [] }));
  unwrap(await excl.setMarketParent(admin, { marketId: nested.marketId, parentId: market.marketId }));
  const unrelated = unwrap(await excl.createMarket(admin, { name: `${TAG} Unrelated Market ${stamp}`, kind: "custom", aliases: [] }));
  const launch = unwrap(await prospects.createLaunch(admin, { name: `${TAG} launch ${stamp}`, marketId: market.marketId, priceSegment: "luxury", serviceCategory: "residential brokerage" }));
  const nestedLaunch = unwrap(await prospects.createLaunch(admin, { name: `${TAG} nested launch ${stamp}`, marketId: nested.marketId, priceSegment: "luxury", serviceCategory: "residential brokerage" }));
  const unrelatedLaunch = unwrap(await prospects.createLaunch(admin, { name: `${TAG} unrelated launch ${stamp}`, marketId: unrelated.marketId, priceSegment: "luxury", serviceCategory: "residential brokerage" }));
  const subject = unwrap(await companies.upsertCompany(admin, { name: `${TAG} Fixture Team ${stamp}` }));
  const rival = unwrap(await companies.upsertCompany(admin, { name: `${TAG} Rival Team ${stamp}` }));
  const other = unwrap(await companies.upsertCompany(admin, { name: `${TAG} Unrelated Team ${stamp}` }));
  const nestedCo = unwrap(await companies.upsertCompany(admin, { name: `${TAG} Nested Team ${stamp}` }));
  const marketProject = unwrap(await projects.createProject(admin, { name: `${TAG} Market benchmark ${stamp}`, description: "Spec 131 production smoke fixture — archive after run." }));
  await sql`update projects set kind = 'prospect' where id = ${marketProject.id}`;
  unwrap(await claims.setSubjectCompany(admin, { projectId: marketProject.id, companyId: subject.id }));
  const set = unwrap(await sets.createPromptSet(admin, { projectId: marketProject.id, name: `${TAG} questions` }));
  for (const text of [`${TAG} who is the best luxury team in the sandbox market?`, `${TAG} which team should sell my sandbox loft?`]) {
    unwrap(await promptSvc.addPrompt(admin, { setId: set.id, text, category: "recommendation" }));
  }
  unwrap(await sets.freezePromptSet(admin, { id: set.id }));
  const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.id}`;
  const baselineRun = await syntheticRun(marketProject.id, version!.id as string, subject.id, rival.id, `${TAG} baseline`, [1, 0, 0, 1]);
  const prospect = unwrap(await prospects.createProspect(admin, { launchId: launch.launchId, businessName: subject.name ?? `${TAG} Fixture Team ${stamp}`, prospectType: "team", companyId: subject.id }));
  await sql`insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by) values (${prospect.prospectId}, ${baselineRun}, ${subject.id}, ${admin.id})`;
  const rivalProspect = unwrap(await prospects.createProspect(admin, { launchId: launch.launchId, businessName: `${TAG} Rival Team ${stamp}`, prospectType: "team", companyId: rival.id }));
  const nestedProspect = unwrap(await prospects.createProspect(admin, { launchId: nestedLaunch.launchId, businessName: `${TAG} Nested Team ${stamp}`, prospectType: "team", companyId: nestedCo.id }));
  const unrelatedProspect = unwrap(await prospects.createProspect(admin, { launchId: unrelatedLaunch.launchId, businessName: `${TAG} Unrelated Team ${stamp}`, prospectType: "team", companyId: other.id }));
  pass("fixtures created", `market ${marketName}`);

  const cleanup: (() => Promise<void>)[] = [];
  try {
    // ---------------------------------------------------- commercial gates
    const signed = unwrap(await eng.signClient(admin, { prospectId: prospect.prospectId, startsOn: today(), monthlyFeeUsd: 1, totalValueUsd: 3, scopeSummary: SCOPE, primaryContactName: `${TAG} Contact` }));
    const e0 = (await eng.engagementForProject(signed.projectId))!;
    expect("signed: promotion reused (no duplicate universe)", signed.promoted && (await sql`select promoted_project_id from prospects where id = ${prospect.prospectId}`)[0]!.promotedProjectId === signed.projectId, "prospect.promoted_project_id = client project");
    expect("signed: territory reserved, not active", e0.exclusivityStatus === "reserved" && e0.stage === "signed", `status ${e0.exclusivityStatus}`);
    expect("gate: onboarding refused without contract", refused(await eng.startOnboarding(admin, { engagementId: e0.id })), "no contract, no payment");
    unwrap(await eng.recordBillingEvent(admin, { engagementId: e0.id, kind: "payment_received", amountUsd: 1, externalInvoiceId: `${TAG}-INV-${stamp}`, note: "QA fixture ledger row" }));
    expect("gate: payment without signed contract does not activate", refused(await eng.startOnboarding(admin, { engagementId: e0.id })), "payment alone refused");
    const badSigned = await eng.recordContractStatus(admin, { engagementId: e0.id, status: "signed" });
    expect("gate: signed contract needs a reference", refused(badSigned), "no reference refused");
    // Reset ledger view by recording contract now; the earlier payment counts.
    unwrap(await eng.recordContractStatus(admin, { engagementId: e0.id, status: "signed", contractRef: `${TAG} fixture contract ref` }));
    const [ledgerOnly] = await sql`select count(*)::int as n from billing_events where contract_ref = ${`engagement:${e0.id}`}`;
    expect("ledger: contract and payment are separate records", Number(ledgerOnly!.n) === 1 && (await eng.getEngagement(e0.id))!.contractStatus === "signed", "contract on engagement, payment in billing_events");
    // Second engagement to prove the override path separately.
    unwrap(await eng.startOnboarding(admin, { engagementId: e0.id }));
    expect("gate: signed + payment → onboarding", (await eng.getEngagement(e0.id))!.stage === "onboarding", "");
    const [auditStage] = await sql`select user_id, at, detail from audit_log where entity_id = ${e0.id} and action = 'engagement.stage' order by at desc limit 1`;
    expect("gate: stage change audited with actor + time", auditStage?.userId === admin.id && Boolean(auditStage?.at), "");

    // ---------------------------------------------------------- exclusivity
    expect("exclusivity: refused without market definition", refused(await eng.activateExclusivity(admin, { engagementId: e0.id })), "");
    unwrap(await eng.confirmMarketDefinition(admin, { engagementId: e0.id, definition: `${TAG} sandbox boundary: the fixture market node and its nested node only; nothing real.` }));
    unwrap(await eng.activateExclusivity(admin, { engagementId: e0.id }));
    expect("exclusivity: first client active in test market", (await eng.getEngagement(e0.id))!.exclusivityStatus === "active", "");
    expect("exclusivity: second live engagement in same market refused", refused(await eng.signClient(admin, { prospectId: rivalProspect.prospectId, startsOn: today(), monthlyFeeUsd: 1, totalValueUsd: 3, scopeSummary: SCOPE })), "");
    expect("exclusivity: nested market refused", refused(await eng.signClient(admin, { prospectId: nestedProspect.prospectId, startsOn: today(), monthlyFeeUsd: 1, totalValueUsd: 3, scopeSummary: SCOPE })), "");
    const unrelatedSigned = await eng.signClient(admin, { prospectId: unrelatedProspect.prospectId, startsOn: today(), monthlyFeeUsd: 1, totalValueUsd: 3, scopeSummary: SCOPE });
    expect("exclusivity: unrelated market remains eligible", unrelatedSigned.ok, unrelatedSigned.ok ? "" : unrelatedSigned.error.message);
    const ownGate = await gate.exclusivityGateForProspect(prospect.prospectId);
    const rivalGate = await gate.exclusivityGateForProspect(rivalProspect.prospectId);
    const nestedGate = await gate.exclusivityGateForProspect(nestedProspect.prospectId);
    expect("exclusivity: client's own prospect not blocked", !ownGate.blocked, ownGate.detail);
    expect("exclusivity: competing prospect blocked at send-time detection", rivalGate.blocked && nestedGate.blocked, rivalGate.detail);
    const conflicts = await eng.marketOutreachConflicts(e0.id);
    expect("exclusivity: sweep lists competing prospects", conflicts.length === 2, conflicts.map((c) => c.businessName).join(", "));
    const paused = unwrap(await eng.pauseMarketOutreach(admin, { engagementId: e0.id }));
    expect("exclusivity: conflicting cold outreach paused (fixture only)", paused.prospects === 2, JSON.stringify(paused));

    // ------------------------------------------------------------ baseline
    expect("onboarding: active refused before checklist", refused(await eng.markActive(admin, { engagementId: e0.id })), "");
    const frozen = unwrap(await eng.freezeBaseline(admin, { engagementId: e0.id, provider: "qa-fixture" }));
    const s = frozen.snapshot;
    expect("baseline: frozen over shared run (not client-owned)", s.sourceProjectId === marketProject.id && s.runId === baselineRun, `run ${baselineRun.slice(0, 8)}`);
    expect("baseline: package fields present", Boolean(s.provider && s.capturedAt && s.promptSetVersionId && s.questions.length === 2 && s.answerCount === 4 && s.subject.recommendedCount === 2 && s.competitors[0]?.recommendedCount === 4 && s.versions.resolverPolicy && s.versions.scoringVersion), `subject ${s.subject.recommendedCount}/${s.answerCount}, rival ${s.competitors[0]?.recommendedCount}/${s.answerCount}`);
    let rejectedUpdate = false; try { await sql`update engagement_measurements set snapshot = '{}'::jsonb where id = ${frozen.measurementId}`; } catch { rejectedUpdate = true; }
    let rejectedDelete = false; try { await sql`delete from engagement_measurements where id = ${frozen.measurementId}`; } catch { rejectedDelete = true; }
    expect("baseline: update rejected", rejectedUpdate, "");
    expect("baseline: delete rejected", rejectedDelete, "");
    expect("baseline: second freeze rejected", refused(await eng.freezeBaseline(admin, { engagementId: e0.id, provider: "qa-fixture" })), "");
    await sql`update companies set aliases = array[${TAG + " Alias"}] where id = ${subject.id}`;
    const [afterAlias] = await sql`select snapshot from engagement_measurements where id = ${frozen.measurementId}`;
    expect("baseline: later alias change does not alter frozen package", JSON.stringify((afterAlias!.snapshot as { subject: { aliases: string[] } }).subject.aliases) === "[]", "");
    await sql`update companies set aliases = '{}' where id = ${subject.id}`;

    // ---------------------------------------------------------------- work
    unwrap(await eng.addContextItem(admin, { engagementId: e0.id, kind: "priority_area", label: `${TAG} Nested`, provenance: "client_priority" }));
    unwrap(await eng.addContextItem(admin, { engagementId: e0.id, kind: "asset", label: "https://example.invalid/qa131", provenance: "client_confirmed" }));
    const access = unwrap(await eng.addContextItem(admin, { engagementId: e0.id, kind: "access", label: "CMS (delegated)", provenance: "client_confirmed", accessStatus: "requested" }));
    expect("security: credentials refused in context items", refused(await eng.addContextItem(admin, { engagementId: e0.id, kind: "access", label: "login", provenance: "client_confirmed", accessStatus: "granted", value: { password: "x" } })), "");
    const evidenceResponse = s.questions[0]!.responseIds[0]!;
    const ev = (note: string) => [{ kind: "response" as const, refId: evidenceResponse, note }];
    const A = unwrap(await tasks.suggestTask(admin, { projectId: signed.projectId, title: `${TAG} A: public identity consistency`, evidence: ev("Person and team surfaced separately in baseline answers.") }));
    unwrap(await tasks.updateTaskProvenance(admin, { taskId: A.taskId, observation: "Person and team surfaced separately.", hypothesis: "Consistent identity may improve representation.", confidence: "high_confidence", control: "we_control", clientApprovalRequired: true, targetUrl: "https://example.invalid/about", beforeState: "About page names team only.", measurementNote: "Same question set, same provider." }));
    unwrap(await tasks.updateTaskDetails(admin, { taskId: A.taskId, clientVisible: true }));
    const B = unwrap(await tasks.suggestTask(admin, { projectId: signed.projectId, title: `${TAG} B: third-party profile consistency`, evidence: ev("Portals appear repeatedly.") }));
    unwrap(await tasks.updateTaskProvenance(admin, { taskId: B.taskId, observation: "Portals repeatedly appear.", confidence: "medium_confidence", control: "third_party", targetUrl: "https://example.invalid/profile", beforeState: "Profile lists old brokerage." }));
    unwrap(await tasks.updateTaskDetails(admin, { taskId: B.taskId, clientVisible: true }));
    const C = unwrap(await tasks.suggestTask(admin, { projectId: signed.projectId, title: `${TAG} C: neighborhood evidence`, evidence: ev("Rival leads on neighborhood questions.") }));
    unwrap(await tasks.updateTaskDetails(admin, { taskId: C.taskId, dueDate: "2020-01-01", clientVisible: true }));
    unwrap(await tasks.blockTask(admin, { taskId: C.taskId, reason: "client_input", note: "Confirm whether the neighborhood matters." }));
    const q1 = await queue.actionRequiredQueue({ projectId: signed.projectId });
    expect("work C: blocked item is not overdue", !q1.some((i) => i.source === "task_overdue" && i.id === C.taskId), `${q1.length} queue items`);
    expect("work C: cannot proceed while blocked", refused(await tasks.approveTask(admin, { taskId: C.taskId })) || refused(await tasks.startTask(admin, { taskId: C.taskId })), "");
    unwrap(await tasks.rejectTask(admin, { taskId: C.taskId }));
    const viewC = (await eng.engagementOverview(signed.projectId))!;
    expect("work C: declined without unhealthy signal", !viewC.signals.some((sig) => sig.key === "client_waiting" && sig.state !== "ok"), viewC.signals.map((x) => `${x.key}:${x.state}`).join(" "));

    // ------------------------------------------------------------ approvals
    unwrap(await tasks.approveTask(admin, { taskId: A.taskId }));
    expect("approvals: cannot start before client approval", refused(await tasks.startTask(admin, { taskId: A.taskId })), "");
    unwrap(await tasks.recordClientDecision(admin, { taskId: A.taskId, decision: "rejected", channel: "email", note: "Not that wording." }));
    expect("approvals: rejected change cannot execute", refused(await tasks.startTask(admin, { taskId: A.taskId })), "");
    unwrap(await tasks.recordClientDecision(admin, { taskId: A.taskId, decision: "edit_requested", channel: "call", note: "Shorter." }));
    unwrap(await tasks.updateTaskProvenance(admin, { taskId: A.taskId, afterState: "About page names the lead agent and the team.", clientApprovalRequired: true }));
    expect("approvals: revised change requires new approval", (await sql`select client_approval from tasks where id = ${A.taskId}`)[0]!.clientApproval === "required", "");
    unwrap(await tasks.recordClientDecision(admin, { taskId: A.taskId, decision: "approved", channel: "email", note: "Approved the revised copy." }));
    const trail = await sql`select decision, recorded_by, decided_at, channel from task_client_decisions where task_id = ${A.taskId} order by decided_at`;
    expect("approvals: append-only trail with actor + time", trail.length === 3 && trail.every((t) => t.recordedBy === admin.id && t.decidedAt), trail.map((t) => t.decision).join(" → "));
    let trailImmutable = false; try { await sql`delete from task_client_decisions where task_id = ${A.taskId}`; } catch { trailImmutable = true; }
    expect("approvals: trail immutable", trailImmutable, "");
    const [approvedTask] = await sql`select after_state from tasks where id = ${A.taskId}`;
    expect("approvals: exact proposed change preserved", approvedTask!.afterState === "About page names the lead agent and the team.", "");
    unwrap(await tasks.startTask(admin, { taskId: A.taskId }));
    unwrap(await tasks.completeTask(admin, { taskId: A.taskId }));
    // Work item B: planned → in progress → implemented → complete.
    unwrap(await tasks.approveTask(admin, { taskId: B.taskId }));
    unwrap(await tasks.startTask(admin, { taskId: B.taskId }));
    unwrap(await tasks.updateTaskProvenance(admin, { taskId: B.taskId, afterState: "Profile lists current brokerage and lead agent." }));
    unwrap(await tasks.completeTask(admin, { taskId: B.taskId }));
    // Approval on another client's task must not touch this one.
    const eU = (await eng.engagementForProject(unrelatedSigned.ok ? unrelatedSigned.data.projectId : signed.projectId))!;
    const other1 = unwrap(await tasks.suggestTask(admin, { projectId: eU.projectId, title: `${TAG} other client task`, evidence: ev("cross-client isolation fixture") }));
    unwrap(await tasks.updateTaskProvenance(admin, { taskId: other1.taskId, clientApprovalRequired: true }));
    unwrap(await tasks.recordClientDecision(admin, { taskId: other1.taskId, decision: "rejected", channel: "email" }));
    expect("approvals: client B decision does not affect client A", (await sql`select client_approval from tasks where id = ${A.taskId}`)[0]!.clientApproval === "approved", "");

    // ------------------------------------------------------- change log
    const log = await eng.changeLog(signed.projectId);
    const a = log.find((c) => c.id === A.taskId);
    const b = log.find((c) => c.id === B.taskId);
    expect("change log: WHAT/WHERE/WHEN/WHY/before/after/approval reconstructable", Boolean(a?.targetUrl && a.before && a.after && a.reason && a.at && a.approval === "approved" && b?.targetUrl && b.before && b.after), `${log.length} entries`);
    const [who] = await sql`select user_id from audit_log where entity = 'task' and entity_id = ${A.taskId} and action = 'task.complete'`;
    expect("change log: WHO recorded", who?.userId === admin.id, "");

    // ----------------------------------------------------------- active
    unwrap(await eng.setAccessStatus(admin, { itemId: access.itemId, accessStatus: "granted" }));
    const active = unwrap(await eng.markActive(admin, { engagementId: e0.id }));
    expect("onboarding: active only when derived checklist complete", active.checklist.every((c) => c.done) && (await eng.getEngagement(e0.id))!.stage === "active", "");

    // ---------------------------------------------------- portal isolation
    const userA = randomUUID(); const userB = randomUUID();
    await sql`insert into users (id, email, name, role, active) values (${userA}, ${`${TAG.toLowerCase()}-a-${stamp}@fixture.invalid`}, 'QA131 Client A', 'client_viewer', true), (${userB}, ${`${TAG.toLowerCase()}-b-${stamp}@fixture.invalid`}, 'QA131 Client B', 'client_viewer', true)`;
    cleanup.push(async () => { await sql`delete from user_project_access where user_id in (${userA}, ${userB})`; await sql`delete from users where id in (${userA}, ${userB})`; });
    await sql`insert into user_project_access (user_id, project_id) values (${userA}, ${signed.projectId}), (${userB}, ${eU.projectId})`;
    const clientA: CurrentUser = { id: userA, email: "a", name: "A", role: "client_viewer" };
    const viewA = await portal.portalEngagement(clientA, signed.projectId);
    let denied = 0;
    for (const fn of [() => portal.portalEngagement(clientA, eU.projectId), () => portal.portalOverview(clientA, eU.projectId), () => portal.portalWork(clientA, eU.projectId), () => portal.portalReports(clientA, eU.projectId)]) {
      try { await fn(); } catch (err) { if (err instanceof ProjectAccessError) denied += 1; }
    }
    expect("portal isolation: client A denied client B project/tasks/baseline/measurements/reports", denied === 4, `${denied}/4 reads denied as not-found`);
    expect("portal isolation: client A cannot write", refused(await tasks.recordClientDecision(clientA, { taskId: A.taskId, decision: "approved", channel: "portal" })) && refused(await eng.recordBillingEvent(clientA, { engagementId: e0.id, kind: "payment_received", amountUsd: 1 })), "client roles are read-only");
    const portalJson = JSON.stringify(viewA);
    expect("portal: answers where/what/working/need/changed/measure", Boolean(viewA?.baseline && viewA.changed.length === 2 && viewA.nextMeasurementOn && viewA.workingOn !== undefined && viewA.needsYourInput !== undefined), `baseline ${viewA?.baseline?.recommendedCount}/${viewA?.baseline?.answerCount}, changed ${viewA?.changed.length}, next ${viewA?.nextMeasurementOn}`);
    expect("portal: no fee/invoice/override/conflict/prospect internals", !/monthlyFee|invoice|override|Rival Team|conflict|cold|score/i.test(portalJson), "");

    // -------------------------------------------------------- remeasurement
    const rerun = await syntheticRun(marketProject.id, version!.id as string, subject.id, rival.id, `${TAG} midpoint`, [1, 1, 0, 1]);
    const v1 = (await eng.engagementOverview(signed.projectId))!;
    const slot = v1.measurements.find((m) => m.role === "midpoint" && m.status === "planned")!;
    const measured = unwrap(await eng.recordMeasurement(admin, { engagementId: e0.id, runId: rerun, measurementId: slot.id }));
    expect("remeasurement: comparable run graded", measured.comparability.grade === "high" && measured.comparison !== null, `grade ${measured.comparability.grade}`);
    const cmp = measured.comparison!;
    expect("remeasurement: baseline/new/delta/competitor/question-level/distinct", cmp.subject.baseline === 2 && cmp.subject.next === 3 && cmp.subject.delta === 1 && cmp.competitors[0]!.baseline === 4 && cmp.competitors[0]!.next === 4 && cmp.subject.distinctNext >= cmp.subject.distinctBaseline, cmp.statement);
    expect("remeasurement: non-causal language", /observed movement, not an attribution/.test(cmp.statement) && !/caused/i.test(cmp.statement), "");
    const set2 = unwrap(await sets.createPromptSet(admin, { projectId: marketProject.id, name: `${TAG} altered questions` }));
    unwrap(await promptSvc.addPrompt(admin, { setId: set2.id, text: `${TAG} who is the best broker downtown sandbox?`, category: "recommendation" }));
    unwrap(await sets.freezePromptSet(admin, { id: set2.id }));
    const [v2] = await sql`select id from prompt_set_versions where prompt_set_id = ${set2.id}`;
    const altered = await syntheticRun(marketProject.id, v2!.id as string, subject.id, rival.id, `${TAG} altered`, [1, 1]);
    const nc = unwrap(await eng.recordMeasurement(admin, { engagementId: e0.id, runId: altered }));
    expect("remeasurement: altered question set → NON_COMPARABLE, no comparison", nc.comparability.grade === "not_comparable" && nc.comparison === null, nc.comparability.reasons.join("; "));

    // -------------------------------------------------------- weekly + today
    const v2iew = (await eng.engagementOverview(signed.projectId))!;
    expect("weekly update: DONE/IN PROGRESS/NEED FROM YOU/MEASUREMENT/NEXT from canonical rows", /DONE — what changed this week\n- QA131 A/.test(v2iew.weeklyUpdate) && /MEASUREMENT\n- After the changes/.test(v2iew.weeklyUpdate) && /NEED FROM YOU\n- Nothing is waiting on you/.test(v2iew.weeklyUpdate), "");
    const todayItems = await queue.actionRequiredQueue({ projectId: signed.projectId });
    const kinds = todayItems.filter((i) => i.source === "engagement").map((i) => i.kind);
    expect("today: engagement cards without duplicates", kinds.length === new Set(kinds).size, kinds.join(", ") || "none pending (all gates cleared)");
    const eUview = (await eng.engagementOverview(eU.projectId))!;
    expect("today: payment-missing / onboarding surfaced for the unpaid engagement", eUview.nextAction.includes("commercial gate"), eUview.nextAction);

    // ------------------------------------------------------------- renewal
    const at70 = new Date(Date.now() + 70 * 86_400_000);
    const late = (await eng.engagementOverview(signed.projectId, at70))!;
    expect("renewal: review state derives at day 69+", late.derivedStage === "renewal_review" && late.renewalStatus === "due" && /renewal review/.test(late.nextAction), late.nextAction);
    const baselineRow = late.measurements.find((m) => m.role === "baseline")!;
    expect("renewal: baseline + latest comparable + work + changes available", Boolean(baselineRow.snapshot) && late.measurements.some((m) => m.comparison) && late.changes.length === 2, "");
    unwrap(await eng.setRenewalStatus(admin, { engagementId: e0.id, status: "offered" }));
    expect("renewal: founder decision recorded, nothing automatic", (await eng.getEngagement(e0.id))!.renewalStatus === "offered" && (await eng.getEngagement(e0.id))!.stage === "active", "");

    // ---------------------------------------------------------- offboarding
    const closed = unwrap(await eng.closeEngagement(admin, { engagementId: e0.id, outcome: "completed", reason: "QA fixture: non-renewal simulated." }));
    const eClosed = (await eng.getEngagement(e0.id))!;
    const [agreement] = await sql`select status, terminated_at from exclusivity_agreements where id = ${e0.exclusivityAgreementId}`;
    const [former] = await sql`select do_not_contact, do_not_contact_reason from prospects where id = ${prospect.prospectId}`;
    const [accessRow] = await sql`select access_status from engagement_context_items where id = ${access.itemId}`;
    expect("offboarding: final status + exclusivity terminated on end date", eClosed.stage === "completed" && agreement!.status === "terminated" && closed.agreementTerminatedOn === e0.endsOn, `released ${closed.agreementTerminatedOn}`);
    expect("offboarding: portal grants revoked", closed.portalGrantsRevoked === 1 && (await sql`select count(*)::int as n from user_project_access where project_id = ${signed.projectId}`)[0]!.n === 0, "");
    expect("offboarding: planned measurements stopped", closed.measurementsCancelled === 1, "final slot cancelled");
    expect("offboarding: former client does not re-enter cold outreach (180-day cooldown)", former!.doNotContact === true && /Former client/.test(String(former!.doNotContactReason)) && eClosed.cooldownUntil === rules.addDays(e0.endsOn, 180), `cooldown until ${eClosed.cooldownUntil}`);
    expect("offboarding: history retained", (await sql`select count(*)::int as n from engagement_measurements where engagement_id = ${e0.id}`)[0]!.n === 4 && (await sql`select count(*)::int as n from task_client_decisions where task_id = ${A.taskId}`)[0]!.n === 3, "");
    expect("offboarding: exclusivity released only after the end date", (await gate.exclusivityGateForProspect(rivalProspect.prospectId, e0.endsOn)).blocked && !(await gate.exclusivityGateForProspect(rivalProspect.prospectId, rules.addDays(e0.endsOn, 1))).blocked, "");
    expect("offboarding: delegated access marked (granted → operator revokes at close)", accessRow!.accessStatus === "granted", "access items are a manual revoke step — see checklist");
    // Close the unrelated fixture engagement too.
    unwrap(await eng.closeEngagement(admin, { engagementId: eU.id, outcome: "churned", reason: "QA fixture teardown." }));
  } finally {
    // ------------------------------------------------------------ teardown
    for (const fn of cleanup) await fn();
    for (const pid of [prospect.prospectId, rivalProspect.prospectId, nestedProspect.prospectId, unrelatedProspect.prospectId]) {
      await sql`update prospects set archived_at = now(), notes = ${`${TAG} production smoke fixture — archived`} where id = ${pid}`;
    }
    const fixtureProjects = await sql`select id from projects where name like ${TAG + "%"} and status = 'active'`;
    for (const pr of fixtureProjects) await projects.archiveProject(admin, { id: pr.id as string });
    await sql`update companies set archived_at = now() where name like ${TAG + "%"} and archived_at is null`;
    await sql`update market_launches set archived_at = now() where name like ${TAG + "%"}`;
    pass("teardown", "fixture prospects, projects, companies, launches archived; fixture users removed");
  }

  const after = await ryanSnapshot();
  expect("SAFETY: Ryan + Grand Rapids state unchanged", before === after, before === after ? "identical before/after snapshot" : `BEFORE ${before}\nAFTER ${after}`);
  const fails = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.length - fails.length}/${results.length} PASS`);
  if (fails.length > 0) { console.log(JSON.stringify(fails, null, 1)); process.exitCode = 1; }
  await sql.end();
}
main().catch(async (e) => { console.error("SMOKE ERROR", e); try { await sql.end(); } catch {} process.exit(1); });
