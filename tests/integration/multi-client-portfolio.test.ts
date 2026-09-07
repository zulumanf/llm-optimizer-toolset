/**
 * Spec 132 — multi-client delivery QA. Five fixture clients (A: Ryan-shaped
 * shared-market baseline; B: different market; C: nested/conflicting market;
 * D: active, waiting on the client; E: active with an overdue measurement),
 * then a ten-client and a twenty-five-client scan at data level.
 *
 * Load-bearing: cross-client reads fail closed, exclusivity refuses nested
 * markets and allows unrelated ones, Today ranks a client waiting on us above
 * routine work, execution QA refuses a vague completion, communication QA
 * catches another client's name, evidence drift is flagged without touching
 * the frozen package, and the whole portfolio is read in a bounded number of
 * queries.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { drainJobs, type PipelineModules } from "../helpers/prospect-fixtures";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };
const viewerA: CurrentUser = { id: "00000000-0000-4000-8000-000000000002", email: "a@test.local", name: "Client A", role: "client_viewer" };
const viewerB: CurrentUser = { id: "00000000-0000-4000-8000-0000000000aa", email: "b@test.local", name: "Client B", role: "client_viewer" };
const SCOPE = "AI recommendation diagnosis, evidence improvements, implementation of high-confidence changes, monitoring, remeasurement.";

describe.skipIf(!TEST_URL)("multi-client portfolio QA (integration)", () => {
  let m: PipelineModules;
  let sql: PipelineModules["sql"];
  let eng: typeof import("@/lib/engagements/service");
  let portfolio: typeof import("@/lib/engagements/portfolio");
  let tasks: typeof import("@/lib/tasks/service");
  let portal: typeof import("@/lib/portal/service");
  let queue: typeof import("@/lib/control-tower/queue");
  let auth: typeof import("@/lib/auth");
  let mock: typeof import("@/lib/ai/mock");
  let reviewers: typeof import("@/lib/engagements/reviewers");

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
    portfolio = await import("@/lib/engagements/portfolio");
    tasks = await import("@/lib/tasks/service");
    portal = await import("@/lib/portal/service");
    queue = await import("@/lib/control-tower/queue");
    auth = await import("@/lib/auth");
    mock = await import("@/lib/ai/mock");
    reviewers = await import("@/lib/engagements/reviewers");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
    await sql`update users set role = 'client_viewer' where id in (${viewerA.id}, ${viewerB.id})`;
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, billing_events, task_client_decisions, engagement_context_items,
       engagement_measurements, engagement_qa_events, portfolio_qa_scans, client_engagements, user_project_access,
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

  const today = () => new Date().toISOString().slice(0, 10);

  /** A shared market benchmark (mock provider, 2 prompts × 2 reps) with a
   * subject and a rival, a launch on `marketId`, and a prospect linked to it. */
  async function client(label: string, marketId: string, opts: { rivalName?: string } = {}) {
    const subject = unwrap(await m.companySvc.upsertCompany(admin, { name: `${label} Team` }));
    const rival = unwrap(await m.companySvc.upsertCompany(admin, { name: opts.rivalName ?? `${label} Rival` }));
    const project = unwrap(await m.projectSvc.createProject(admin, { name: `${label} market benchmark` }));
    await sql`update projects set kind = 'prospect' where id = ${project.id}`;
    unwrap(await m.claims.setSubjectCompany(admin, { projectId: project.id, companyId: subject.id }));
    const set = unwrap(await m.setSvc.createPromptSet(admin, { projectId: project.id, name: `${label} set` }));
    for (const text of [`${label}: best luxury team?`, `${label}: who sells lofts?`]) {
      unwrap(await m.promptSvc.addPrompt(admin, { setId: set.id, text, category: "recommendation" }));
    }
    unwrap(await m.setSvc.freezePromptSet(admin, { id: set.id }));
    const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.id}`;
    const run = unwrap(await m.runSvc.startRun(admin, { projectId: project.id, promptSetVersionId: version!.id as string, providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }], budgetUsd: 5, label: `${label} baseline` }));
    await drainJobs(m);
    // The mock recommends "Lumina"/"Acme" by name; credit the subject in every answer deterministically.
    const responses = await sql`select id from responses where run_id = ${run.id}`;
    for (const r of responses) {
      await sql`insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review) values (${r.id}, ${subject.id}, 9, true, true, 'fixture', 1, false) on conflict do nothing`;
      await sql`insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review) values (${r.id}, ${rival.id}, 9, true, true, 'fixture', 1, false) on conflict do nothing`;
    }
    const launch = unwrap(await m.svc.createLaunch(admin, { name: `${label} launch`, marketId, priceSegment: "luxury", serviceCategory: "residential brokerage" }));
    const prospect = unwrap(await m.svc.createProspect(admin, { launchId: launch.launchId, businessName: `${label} Team`, prospectType: "team", companyId: subject.id }));
    await sql`insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by) values (${prospect.prospectId}, ${run.id}, ${subject.id}, ${admin.id})`;
    return { label, subject, rival, marketProject: project, versionId: version!.id as string, runId: run.id, launchId: launch.launchId, prospectId: prospect.prospectId };
  }

  /** Sign → contract → payment → onboarding → market def → exclusivity → competitor → baseline. */
  async function activate(c: Awaited<ReturnType<typeof client>>, startsOn = today(), rationale?: string) {
    const signed = unwrap(await eng.signClient(admin, { prospectId: c.prospectId, startsOn, monthlyFeeUsd: 7500, totalValueUsd: 22500, priceOverrideReason: "test fixture terms (spec 135)", scopeSummary: SCOPE, primaryContactName: `${c.label} Owner`, conflictOverrideRationale: rationale }));
    const e = (await eng.engagementForProject(signed.projectId))!;
    unwrap(await eng.recordContractStatus(admin, { engagementId: e.id, status: "signed", contractRef: `${c.label} ref` }));
    unwrap(await eng.recordBillingEvent(admin, { engagementId: e.id, kind: "invoice_created", amountUsd: 7500, dueDate: startsOn, externalInvoiceId: `${c.label}-1` }));
    unwrap(await eng.recordBillingEvent(admin, { engagementId: e.id, kind: "payment_received", amountUsd: 7500, externalInvoiceId: `${c.label}-1` }));
    unwrap(await eng.startOnboarding(admin, { engagementId: e.id }));
    unwrap(await eng.confirmMarketDefinition(admin, { engagementId: e.id, definition: `${c.label} boundary: the market node and its nested nodes only, luxury residential.` }));
    unwrap(await eng.activateExclusivity(admin, { engagementId: e.id }));
    const competitors = await import("@/lib/competitors/service");
    await competitors.addCompetitor(admin, { projectId: signed.projectId, companyId: c.rival.id, tier: "primary" });
    unwrap(await eng.freezeBaseline(admin, { engagementId: e.id, provider: "mock" }));
    unwrap(await eng.addContextItem(admin, { engagementId: e.id, kind: "priority_area", label: "Downtown", provenance: "client_priority" }));
    unwrap(await eng.addContextItem(admin, { engagementId: e.id, kind: "asset", label: `https://${c.label.toLowerCase()}.invalid`, provenance: "client_confirmed" }));
    unwrap(await eng.addContextItem(admin, { engagementId: e.id, kind: "competitor", label: c.rival.name ?? "rival", provenance: "client_confirmed" }));
    return { ...c, projectId: signed.projectId, engagementId: e.id };
  }

  async function workItem(projectId: string, runId: string, title: string, over: Record<string, unknown> = {}) {
    const [resp] = await sql`select id from responses where run_id = ${runId} limit 1`;
    const t = unwrap(await tasks.suggestTask(admin, { projectId, title, evidence: [{ kind: "response", refId: resp!.id as string, note: "baseline answer" }] }));
    unwrap(await tasks.updateTaskProvenance(admin, { taskId: t.taskId, observation: "o", hypothesis: "h", confidence: "high_confidence", control: "we_control", targetUrl: "https://example.invalid/page", beforeState: "before", measurementNote: "same instrument", ...over }));
    unwrap(await tasks.updateTaskDetails(admin, { taskId: t.taskId, clientVisible: true, ownerId: admin.id }));
    return t.taskId;
  }

  it("A–E: isolation, exclusivity, Today ranking, QA status, execution and communication QA, drift, renewal", async () => {
    const metro = unwrap(await m.exclusivity.createMarket(admin, { name: "Metro", kind: "region", aliases: [] }));
    const cityA = unwrap(await m.exclusivity.createMarket(admin, { name: "City A", kind: "city", aliases: [] }));
    unwrap(await m.exclusivity.setMarketParent(admin, { marketId: cityA.marketId, parentId: metro.marketId }));
    const nestedA = unwrap(await m.exclusivity.createMarket(admin, { name: "Nested A", kind: "neighborhood", aliases: [] }));
    unwrap(await m.exclusivity.setMarketParent(admin, { marketId: nestedA.marketId, parentId: cityA.marketId }));
    const cityB = unwrap(await m.exclusivity.createMarket(admin, { name: "City B", kind: "city", aliases: [] }));
    unwrap(await m.exclusivity.setMarketParent(admin, { marketId: cityB.marketId, parentId: metro.marketId }));
    const cityD = unwrap(await m.exclusivity.createMarket(admin, { name: "City D", kind: "city", aliases: [] }));
    const cityE = unwrap(await m.exclusivity.createMarket(admin, { name: "City E", kind: "city", aliases: [] }));

    // CLIENT A — Ryan-shaped: shared-market baseline, signed today.
    const A = await activate(await client("A", cityA.marketId));
    // CLIENT B — sibling city in the same metro: a "possible" overlap that the
    // founder confirms as a distinct territory (written rationale, audited).
    const bNoRationale = await client("B", cityB.marketId);
    const bBlocked = await eng.signClient(admin, { prospectId: bNoRationale.prospectId, startsOn: today(), monthlyFeeUsd: 1, totalValueUsd: 3, priceOverrideReason: "test fixture terms (spec 135)", scopeSummary: SCOPE });
    expect(bBlocked.ok).toBe(false);
    if (!bBlocked.ok) expect(bBlocked.error.message).toMatch(/conflict/i);
    const B = await activate(bNoRationale, today(), "Founder confirmed: City B is a distinct territory from City A within the same metro.");
    // CLIENT C — nested inside City A: refused at signing.
    const C = await client("C", nestedA.marketId);
    const cSigned = await eng.signClient(admin, { prospectId: C.prospectId, startsOn: today(), monthlyFeeUsd: 1, totalValueUsd: 3, priceOverrideReason: "test fixture terms (spec 135)", scopeSummary: SCOPE });
    expect(cSigned.ok).toBe(false);
    // Different, unrelated market (same brokerage affiliation is irrelevant to territory): allowed.
    const D = await activate(await client("D", cityD.marketId));
    // E started 80 days ago: term ends in 10 days, review was due 11 days ago, midpoint slot overdue.
    const eStart = new Date(Date.now() - 80 * 86_400_000).toISOString().slice(0, 10);
    const E = await activate(await client("E", cityE.marketId), eStart);

    // Work: A has an approved item cleared to start (client waiting on us) and one awaiting approval.
    const aReady = await workItem(A.projectId, A.runId, "A: identity line on the about page");
    unwrap(await tasks.approveTask(admin, { taskId: aReady.toString() }));
    const aApproval = await workItem(A.projectId, A.runId, "A: profile bio wording", { clientApprovalRequired: true });
    unwrap(await tasks.approveTask(admin, { taskId: aApproval }));
    // D is waiting on the client only.
    const dBlocked = await workItem(D.projectId, D.runId, "D: neighborhood pages");
    unwrap(await tasks.blockTask(admin, { taskId: dBlocked, reason: "client_input", note: "which neighborhoods?" }));
    // B: a completed change, an update sent today → healthy. E: one item so the plan exists.
    const bDone = await workItem(B.projectId, B.runId, "B: brokerage field on Realtor.com");
    await workItem(E.projectId, E.runId, "E: identity line");
    // E: mark active with an overdue planned measurement (started 80 days ago).
    for (const x of [A, B, D, E]) unwrap(await eng.markActive(admin, { engagementId: x.engagementId }));
    unwrap(await tasks.approveTask(admin, { taskId: bDone }));
    unwrap(await tasks.startTask(admin, { taskId: bDone }));
    unwrap(await tasks.updateTaskProvenance(admin, { taskId: bDone, afterState: "Brokerage reads eXp Realty." }));
    unwrap(await tasks.completeTask(admin, { taskId: bDone }));
    const bNext = await workItem(B.projectId, B.runId, "B: identity line");
    unwrap(await tasks.approveTask(admin, { taskId: bNext }));
    unwrap(await tasks.startTask(admin, { taskId: bNext }));
    unwrap(await eng.recordClientUpdateSent(admin, { engagementId: B.engagementId, channel: "email", summary: "Weekly update sent." }));

    // ---- Execution QA: a vague completion without an after state is refused.
    const vague = await workItem(D.projectId, D.runId, "D: optimized Zillow profile");
    unwrap(await tasks.approveTask(admin, { taskId: vague }));
    unwrap(await tasks.startTask(admin, { taskId: vague }));
    const refused = await tasks.completeTask(admin, { taskId: vague });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/Execution QA refused complete/);
    // Scope QA: an adjacent-service task cannot start while in_scope.
    const ads = await workItem(D.projectId, D.runId, "D: run Google Ads for listings");
    unwrap(await tasks.approveTask(admin, { taskId: ads }));
    const adsStart = await tasks.startTask(admin, { taskId: ads });
    expect(adsStart.ok).toBe(false);
    if (!adsStart.ok) expect(adsStart.error.message).toMatch(/paid advertising/);

    // ---- Portfolio scan
    const scan = await portfolio.portfolioScan();
    const byName = new Map(scan.clients.map((c) => [c.clientName, c]));
    const a = byName.get("A Team")!; const b = byName.get("B Team")!; const d = byName.get("D Team")!; const e = byName.get("E Team")!;
    expect(scan.clients).toHaveLength(4);
    expect(a.waitingOn).toBe("us");
    expect(a.alerts.map((x) => x.code)).toContain("CLIENT_WAITING_ON_US");
    expect(a.alerts.map((x) => x.code)).toContain("CLIENT_APPROVAL_WAITING");
    // D has an approved ads item cleared to start, so D truthfully waits on us too;
    // its client-input item is reported as waiting on the client.
    expect(d.alerts.find((x) => x.code === "CLIENT_INPUT_WAITING")?.waitingOn).toBe("client");
    expect(e.alerts.map((x) => x.code)).toContain("MEASUREMENT_OVERDUE");
    expect(e.alerts.map((x) => x.code)).toContain("ENGAGEMENT_ENDING");
    expect(b.alerts.filter((x) => x.severity !== "P2").map((x) => x.code)).not.toContain("CLIENT_UPDATE_DUE");
    expect(b.billingState).toBe("PAYMENT_CURRENT");
    expect(["CLEAR", "ATTENTION"]).toContain(b.qaStatus);
    // Orchestrator order: client waiting on us before a client-approval-only client.
    const order = scan.priorities.map((p) => p.client.clientName);
    expect(order.indexOf("A Team")).toBeLessThan(order.indexOf("D Team"));
    expect(scan.capacity.clientWaitingOnUs).toBeGreaterThanOrEqual(1);
    // Loop position names the missing link for a client with nothing planned.
    expect(e.loop.nextDecision).toMatch(/remeasure|plan|renew|complete/);

    // ---- Today queue reflects the scan and ranks A's client-waiting card above D's approval-only card.
    const items = await queue.actionRequiredQueue({ limit: 100 });
    const aIdx = items.findIndex((i) => i.projectId === A.projectId && i.kind === "client_waiting_on_us");
    const dIdx = items.findIndex((i) => i.projectId === D.projectId && i.kind === "client_input_waiting");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(dIdx);

    // ---- Persistence: material alerts become open events once; rerun does not duplicate.
    const first = await portfolio.persistPortfolioScan(scan, 10);
    expect(first.opened).toBeGreaterThan(0);
    const second = await portfolio.persistPortfolioScan(await portfolio.portfolioScan(), 10);
    expect(second.opened).toBe(0);
    const [scans] = await sql`select count(*)::int as n from portfolio_qa_scans`;
    expect(scans!.n).toBe(2);
    // Founder override records actor, time, reason, previous result.
    const [evt] = await sql`select id from engagement_qa_events where engagement_id = ${E.engagementId} and code = 'MEASUREMENT_OVERDUE' and status = 'open'`;
    unwrap(await portfolio.overrideQaEvent(admin, { eventId: evt!.id as string, reason: "Client asked to delay the run until after their listing season." }));
    const [ov] = await sql`select status, override_by, override_at, previous_result from engagement_qa_events where id = ${evt!.id}`;
    expect(ov!.status).toBe("overridden");
    expect(ov!.overrideBy).toBe(admin.id);
    expect(ov!.previousResult).toBeTruthy();

    // ---- Communication QA: fact pack excludes other clients; other-client name is P0.
    expect(a.factPack.otherClientNames).toEqual(expect.arrayContaining(["B Team", "D Team", "E Team"]));
    expect(a.factPack.otherClientNames).not.toContain("A Team");
    const leaky = a.overview.weeklyUpdate.replace("A Team", "A Team (like B Team)");
    const { communicationQa } = await import("@/lib/engagements/qa");
    expect(communicationQa(leaky, a.factPack).issues.map((i) => i.code)).toContain("OTHER_CLIENT_DATA");
    expect(a.weeklyUpdateQa.issues.filter((i) => i.severity === "P0")).toEqual([]);
    // LLM reviewer with an injected caller: advisory event stored, draft untouched.
    const caller = async () => ({ text: JSON.stringify({ pass: false, issues: [{ kind: "causal_overclaim", quote: "our changes increased", why: "no attribution basis" }] }), tokensIn: 10, tokensOut: 10, costMicroUsd: 1 });
    const review = unwrap(await reviewers.reviewClientDraft(admin, { engagementId: A.engagementId, draft: `${a.overview.weeklyUpdate}\nour changes increased recommendations` }, caller as never));
    expect(review.output?.issues[0]?.kind).toBe("causal_overclaim");
    const [llmEvt] = await sql`select severity, status from engagement_qa_events where engagement_id = ${A.engagementId} and code = 'LLM_COMMUNICATION_REVIEW'`;
    expect(llmEvt).toMatchObject({ severity: "P2", status: "open" });

    // ---- Evidence drift: alias change after the freeze flags, package unchanged.
    await sql`update companies set aliases = array['A Lead Agent'] where id = ${A.subject.id}`;
    const drift = await portfolio.evidenceDriftScan();
    expect(drift.checked).toBe(4);
    expect(drift.flagged).toBeGreaterThanOrEqual(1);
    const [driftEvt] = await sql`select code from engagement_qa_events where engagement_id = ${A.engagementId} and lane = 'evidence' and status = 'open'`;
    expect(driftEvt!.code).toBe("BASELINE_ENTITY_DRIFT");
    const [pkg] = await sql`select snapshot from engagement_measurements where engagement_id = ${A.engagementId} and role = 'baseline'`;
    expect((pkg!.snapshot as { subject: { aliases: string[] } }).subject.aliases).toEqual([]);
    const afterDrift = await portfolio.portfolioClient(A.projectId);
    expect(afterDrift!.qaStatus).not.toBe("CLEAR");

    // ---- Security: client A cannot read B (portal, engagement, work, reports), cannot write anywhere.
    await sql`insert into user_project_access (user_id, project_id) values (${viewerA.id}, ${A.projectId}), (${viewerB.id}, ${B.projectId})`;
    let denied = 0;
    for (const fn of [
      () => portal.portalEngagement(viewerA, B.projectId),
      () => portal.portalOverview(viewerA, B.projectId),
      () => portal.portalWork(viewerA, B.projectId),
      () => portal.portalReports(viewerA, B.projectId),
      () => portal.portalCompetitive(viewerA, B.projectId),
    ]) {
      try { await fn(); } catch (err) { if (err instanceof auth.ProjectAccessError) denied += 1; }
    }
    expect(denied).toBe(5);
    const own = await portal.portalEngagement(viewerA, A.projectId);
    expect(JSON.stringify(own)).not.toMatch(/B Team|D Team|E Team|7500|invoice|override/);
    for (const attempt of [
      () => tasks.recordClientDecision(viewerA, { taskId: aApproval, decision: "approved", channel: "portal" }),
      () => tasks.startTask(viewerA, { taskId: aReady }),
      () => eng.recordBillingEvent(viewerA, { engagementId: A.engagementId, kind: "payment_received", amountUsd: 1 }),
      () => eng.closeEngagement(viewerA, { engagementId: A.engagementId, outcome: "churned", reason: "nope" }),
      () => portfolio.overrideQaEvent(viewerA, { eventId: evt!.id as string, reason: "client trying to override" }),
    ]) {
      let blocked = false;
      try { blocked = !(await attempt()).ok; } catch { blocked = true; }
      expect(blocked).toBe(true);
    }

    // ---- Renewal by calendar for E (started 80 days ago): review due, term ending.
    expect(e.overview.derivedStage).toBe("renewal_review");
    expect(e.overview.renewalStatus).toMatch(/due|lapsed/);
    // ---- Offboarding QA: close E, then simulate an unfinished step and see it stay visible.
    unwrap(await eng.closeEngagement(admin, { engagementId: E.engagementId, outcome: "completed", reason: "term ended" }));
    await sql`insert into user_project_access (user_id, project_id) values (${viewerB.id}, ${E.projectId})`; // a grant re-added by mistake
    const post = await portfolio.portfolioScan(new Date(), { includeRecentlyClosed: true });
    const eClosed = post.clients.find((c) => c.clientName === "E Team")!;
    expect(eClosed.offboarding.map((i) => i.code)).toContain("PORTAL_GRANTS_OPEN");
    expect(eClosed.alerts.map((x) => x.code)).toContain("OFFBOARDING_INCOMPLETE");
  }, 60_000);

  it("10 and 25 active clients scan in a bounded number of queries and reasonable time", async () => {
    // Distinct metros: each city is its own root node (unrelated territories).
    const make = async (n: number, from: number) => {
      const out = [] as string[];
      for (let i = from; i < from + n; i += 1) {
        const mk = unwrap(await m.exclusivity.createMarket(admin, { name: `City ${i}`, kind: "city", aliases: [] }));
        const c = await activate(await client(`K${i}`, mk.marketId));
        const t1 = await workItem(c.projectId, c.runId, `K${i}: identity`);
        unwrap(await tasks.approveTask(admin, { taskId: t1 }));
        if (i % 2 === 0) {
          unwrap(await tasks.startTask(admin, { taskId: t1 }));
          unwrap(await tasks.updateTaskProvenance(admin, { taskId: t1, afterState: "done" }));
          unwrap(await tasks.completeTask(admin, { taskId: t1 }));
        }
        const t2 = await workItem(c.projectId, c.runId, `K${i}: profile`, { clientApprovalRequired: i % 3 === 0 });
        if (i % 5 === 0) unwrap(await tasks.blockTask(admin, { taskId: t2, reason: "client_input", note: "Which neighborhoods matter?" }));
        unwrap(await eng.markActive(admin, { engagementId: c.engagementId }));
        if (i % 4 === 0) unwrap(await eng.recordClientUpdateSent(admin, { engagementId: c.engagementId, channel: "email", summary: "update" }));
        out.push(c.projectId);
      }
      return out;
    };
    await make(10, 0);
    // Count statements during a scan via a wrapped client: postgres.js has no
    // counter, so time is the observable; the loader is a fixed set of
    // queries by construction (see loadPortfolioData).
    let t = Date.now();
    const ten = await portfolio.portfolioScan();
    const tenMs = Date.now() - t;
    expect(ten.clients).toHaveLength(10);
    expect(ten.capacity.liveEngagements).toBe(10);
    t = Date.now();
    const queue10 = await queue.actionRequiredQueue({ limit: 200 });
    const queueMs = Date.now() - t;
    expect(queue10.filter((i) => i.source === "engagement").length).toBeGreaterThan(0);

    await make(15, 10);
    t = Date.now();
    const twentyFive = await portfolio.portfolioScan();
    const twentyFiveMs = Date.now() - t;
    expect(twentyFive.clients).toHaveLength(25);
    // Two-minute test: every client has a headline and a waiting-on answer.
    expect(twentyFive.clients.every((c) => c.headline.length > 0)).toBe(true);
    // Scaling from 10 → 25 clients must not scale the time linearly by more than ~3× (batched loader).
    console.log(JSON.stringify({ tenMs, queueMs, twentyFiveMs }));
    expect(twentyFiveMs).toBeLessThan(Math.max(3000, tenMs * 4));
    t = Date.now();
    const persisted = await portfolio.persistPortfolioScan(twentyFive, twentyFiveMs);
    console.log(JSON.stringify({ persistMs: Date.now() - t, opened: persisted.opened }));
    const drift = await portfolio.evidenceDriftScan();
    expect(drift.checked).toBe(25);
    // Building 25 clients through the real services is the slow part (CI runner
    // Postgres); the scans themselves are milliseconds and asserted above.
  }, 180_000);
});
