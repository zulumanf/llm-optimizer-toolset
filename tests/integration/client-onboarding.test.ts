/**
 * Spec 155 — client self-service onboarding and question review, on a
 * SYNTHETIC Medina-like client (mock provider; no real client data). Covers:
 * first sign-in with prefilled data, missing contact details, editing
 * priorities, leaving and returning, completion, the no-baseline dashboard,
 * question review with save/resume and batch approval, the freeze gate,
 * staff refusal, unauthorized and cross-client access, and immutability.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { seedProspect, type PipelineModules } from "../helpers/prospect-fixtures";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "client-delivery", "synthetic-64-seller-questions.csv"), "utf8");

const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };
const client: CurrentUser = { id: "00000000-0000-4000-8000-000000000002", email: "lucia@lumina.example.test", name: "Lucia Synthetic", role: "client_viewer" };
const otherClient: CurrentUser = { id: "00000000-0000-4000-8000-0000000000aa", email: "other@elsewhere.example.test", name: "Other Client", role: "client_validator" };

const SCOPE = "AI recommendation diagnosis, evidence improvements, implementation of high-confidence changes, monitoring, remeasurement on the same instrument.";
const PRIORITIES = { primaryFocus: "sellers", minPropertyValueUsd: 300_000, additionalOpportunity: "Luxury listings", market: "Albuquerque area" } as const;

describe.skipIf(!TEST_URL)("client self-service onboarding (integration, spec 155)", () => {
  let m: PipelineModules;
  let sql: PipelineModules["sql"];
  let eng: typeof import("@/lib/engagements/service");
  let onb: typeof import("@/lib/engagements/client-onboarding");
  let review: typeof import("@/lib/engagements/client-question-review");
  let delivery: typeof import("@/lib/engagements/delivery");
  let portal: typeof import("@/lib/portal/delivery");

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
    onb = await import("@/lib/engagements/client-onboarding");
    review = await import("@/lib/engagements/client-question-review");
    delivery = await import("@/lib/engagements/delivery");
    portal = await import("@/lib/portal/delivery");
    await seedTestActors(sql);
  });

  async function roles() {
    await sql`update users set role = 'operator' where id = ${operator.id}`;
    await sql`update users set role = 'client_viewer', name = ${client.name}, email = ${client.email} where id = ${client.id}`;
    await sql`update users set role = 'client_validator' where id = ${otherClient.id}`;
  }

  beforeEach(async () => {
    const { truncateAll } = await import("../helpers/db");
    await truncateAll(sql);
    await roles();
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Signed and recorded, but the payment gate decides when onboarding opens. */
  async function signedClient(opts: { pay: boolean }) {
    const f = await seedProspect(m, operator, admin, { projectKind: "prospect" });
    await sql`update prospects set company_id = ${f.subjectCompanyId}, business_name = 'Lumina' where id = ${f.prospectId}`;
    const today = new Date().toISOString().slice(0, 10);
    const signed = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, startsOn: today, monthlyFeeUsd: 1000, totalValueUsd: 1000, priceOverrideReason: "synthetic test terms (spec 155)", scopeSummary: SCOPE, primaryContactName: "Lucia Synthetic" }));
    const e = (await eng.engagementForProject(signed.projectId))!;
    unwrap(await eng.recordContractStatus(operator, { engagementId: e.id, status: "signed", contractRef: "drive://synthetic/contract.pdf" }));
    if (opts.pay) {
      unwrap(await eng.recordBillingEvent(operator, { engagementId: e.id, kind: "payment_received", amountUsd: 1000, externalInvoiceId: "SYN-155" }));
      unwrap(await eng.startOnboarding(operator, { engagementId: e.id }));
    }
    await sql`insert into user_project_access (user_id, project_id) values (${client.id}, ${signed.projectId})`;
    return { projectId: signed.projectId, engagementId: e.id };
  }

  async function otherTenant(): Promise<string> {
    const p = unwrap(await m.projectSvc.createProject(operator, { name: "Elsewhere Realty (synthetic)" }));
    await sql`insert into user_project_access (user_id, project_id) values (${otherClient.id}, ${p.id})`;
    return p.id;
  }

  async function prepare(engagementId: string, contacts: Partial<import("@/lib/engagements/client-onboarding-rules").OnboardingContacts> = {}) {
    const defaults = (await onb.onboardingDefaults(engagementId))!;
    unwrap(await onb.prepareClientOnboarding(operator, { engagementId, priorities: { ...PRIORITIES }, contacts: { ...defaults.contacts, ...contacts } }));
  }

  it("is gated: invisible until shared, unshareable before the commercial gate", async () => {
    const { projectId, engagementId } = await signedClient({ pay: false });
    await prepare(engagementId);
    expect(await onb.portalOnboarding(client, projectId)).toBeNull();
    const early = await onb.markOnboardingReady(operator, { engagementId });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.message).toMatch(/commercial gate/);
    // The client cannot act on a draft.
    expect((await onb.confirmOnboardingPriorities(client, { projectId })).ok).toBe(false);
    expect(await onb.onboardingPending(client, projectId)).toBe(false);
    // Clients can never prepare or share.
    expect((await onb.prepareClientOnboarding(client, { engagementId, priorities: PRIORITIES, contacts: (await onb.onboardingDefaults(engagementId))!.contacts })).ok).toBe(false);
  });

  it("first sign-in → edit → leave → return → complete, recorded in the existing ledgers", async () => {
    const { projectId, engagementId } = await signedClient({ pay: true });
    // Missing details: no email on file, no approver recorded.
    await prepare(engagementId, { primaryEmail: "", approverName: "", approverIsPrimary: false });
    unwrap(await onb.markOnboardingReady(operator, { engagementId }));

    // First sign-in: prefilled, routed to onboarding, nothing recorded by viewing.
    expect(await onb.onboardingPending(client, projectId)).toBe(true);
    let v = (await onb.portalOnboarding(client, projectId))!;
    expect(v.step).toBe("priorities");
    expect(v.businessName).toBe("Lumina");
    expect(v.priorities).toEqual(PRIORITIES);
    expect(v.canRespond).toBe(true);
    expect(v.missing.sort()).toEqual(["approver", "primaryEmail"]);
    const [before] = await sql`select count(*)::int as n from engagement_client_decisions`;
    expect(before!.n).toBe(0);

    // Edit inline (bad input → short message; good input → saved, not confirmed).
    const bad = await onb.saveOnboardingPriorities(client, { projectId, priorities: { ...PRIORITIES, minPropertyValueUsd: -5 } });
    expect(bad.ok).toBe(false);
    unwrap(await onb.saveOnboardingPriorities(client, { projectId, priorities: { ...PRIORITIES, minPropertyValueUsd: 350_000 } }));
    v = (await onb.portalOnboarding(client, projectId))!;
    expect(v.step).toBe("priorities");
    expect(v.priorities.minPropertyValueUsd).toBe(350_000);

    // Operator can no longer overwrite what the client changed.
    expect((await onb.prepareClientOnboarding(operator, { engagementId, priorities: PRIORITIES, contacts: v.contacts })).ok).toBe(false);

    // "Looks good", then leave and return: resumes on contacts with edits intact.
    unwrap(await onb.confirmOnboardingPriorities(client, { projectId }));
    v = (await onb.portalOnboarding(client, projectId))!;
    expect(v.step).toBe("contacts");
    expect(v.priorities.minPropertyValueUsd).toBe(350_000);

    // Missing contact → short, plain refusal; nothing written.
    const noEmail = await onb.completeClientOnboarding(client, { projectId, contacts: { ...v.contacts, primaryEmail: "", approverIsPrimary: true } });
    expect(noEmail.ok).toBe(false);
    if (!noEmail.ok) expect(noEmail.error.message).toBe("Add an email address for your main contact.");
    const badEmail = await onb.completeClientOnboarding(client, { projectId, contacts: { ...v.contacts, primaryEmail: "lucia@", approverIsPrimary: true } });
    expect(badEmail.ok).toBe(false);

    // Staff may not answer for the client.
    expect((await onb.completeClientOnboarding(operator, { projectId, contacts: { ...v.contacts, primaryEmail: "x@y.test", approverIsPrimary: true } })).ok).toBe(false);

    unwrap(await onb.completeClientOnboarding(client, { projectId, contacts: { ...v.contacts, primaryEmail: "lucia@lumina.example.test", approverIsPrimary: true } }));
    v = (await onb.portalOnboarding(client, projectId))!;
    expect(v.step).toBe("done");
    expect(await onb.onboardingPending(client, projectId)).toBe(false);

    // Outcome: one intake decision via the portal + client-provenance context.
    const decisions = await delivery.listSubjectDecisions(engagementId, "intake");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "approved", channel: "portal", recordedBy: client.id });
    expect(decisions[0]!.clientActor).toContain(client.email);
    expect((decisions[0]!.snapshot.changedFromPrepared as { priorities: string[] }).priorities).toEqual(["minPropertyValueUsd"]);
    const context = await eng.listContextItems(engagementId);
    const labels = context.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(["Primary focus: Home sellers", "Minimum property value: $350,000", "Additional opportunity: Luxury listings", "Market: Albuquerque area", "Primary contact: Lucia Synthetic", "Approver: Lucia Synthetic"]));
    expect(context.find((c) => c.label === "Primary contact: Lucia Synthetic")!.provenance).toBe("client_confirmed");
    const { minPropertyValueFrom } = await import("@/lib/engagements/onboarding-intake");
    expect(minPropertyValueFrom(context)).toBe(350_000);

    // Spec 154's journey sees the confirmation with no second rule.
    const state = (await delivery.deliveryState(projectId))!;
    expect(state.journeyInput.intakeConfirmed).toBe(true);

    // The market is never rewritten from the portal; completed is immutable.
    const e = (await eng.getEngagement(engagementId))!;
    expect(e.marketDefinition).toBeNull();
    await expect(sql`update client_onboardings set client_priorities = '{}'::jsonb where engagement_id = ${engagementId}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from client_onboardings where engagement_id = ${engagementId}`).rejects.toThrow(/never deleted/);
    expect((await onb.confirmOnboardingPriorities(client, { projectId })).ok).toBe(false);
  });

  it("dashboard before the baseline: words, no numbers, nothing invented", async () => {
    const { projectId } = await signedClient({ pay: true });
    const o = (await portal.portalDeliveryOverview(client, projectId))!;
    expect(o.latest).toBeNull();
    expect(o.baselineLocked).toBe(false);
    expect(o.results.status).toBe("pending");
    expect(o.progress.published).toBe(false);
    expect(o.focus.work).toEqual([]);
    expect(o.focus.sentence.length).toBeGreaterThan(10);
    expect(JSON.stringify({ focus: o.focus, latest: o.latest, progress: o.progress })).not.toMatch(/%/);
  });

  it("question review: save/resume, batch approve, send, freeze gate, lock", async () => {
    const { projectId, engagementId } = await signedClient({ pay: true });
    const imported = unwrap(await delivery.importClientQuestions(operator, { engagementId, setName: "Seller questions", content: FIXTURE, defaultAudience: "seller" }));
    const versionId = imported.versionId!;

    let r = (await review.portalQuestionReview(client, projectId))!;
    expect(r.total).toBe(64);
    expect(r.reviewed).toBe(0);
    expect(r.groups.length).toBeGreaterThan(1);
    const o = (await portal.portalDeliveryOverview(client, projectId))!;
    expect(o.todos.find((t) => t.key === "questions")?.href).toBe(`/portal/${projectId}/approvals/questions`);

    const [g1, g2] = r.groups;
    const q1 = g1!.questions[0]!;
    const q2 = g1!.questions[1]!;
    unwrap(await review.reviewQuestions(client, { projectId, versionId, items: [{ promptId: q1.promptId, decision: "approved" }] }));
    unwrap(await review.reviewQuestions(client, { projectId, versionId, items: [{ promptId: q2.promptId, decision: "edit_requested", comment: "Say 'list' instead of 'sell'." }] }));
    // Foreign question ids and staff are refused.
    expect((await review.reviewQuestions(client, { projectId, versionId, items: [{ promptId: "00000000-0000-4000-8000-00000000dead", decision: "approved" }] })).ok).toBe(false);
    expect((await review.reviewQuestions(operator, { projectId, versionId, items: [{ promptId: q1.promptId, decision: "approved" }] })).ok).toBe(false);

    // Resume: the state is derived from the append-only trail.
    r = (await review.portalQuestionReview(client, projectId))!;
    expect(r.reviewed).toBe(2);
    expect(r.counts.edit_requested).toBe(1);
    expect(r.groups[0]!.questions[1]!.comment).toBe("Say 'list' instead of 'sell'.");

    // Batch approval for one group never overwrites a decision already made.
    const groupAdded = unwrap(await review.approveRemainingQuestions(client, { projectId, versionId, segment: g1!.segment }));
    expect(groupAdded.recorded).toBe(g1!.questions.length - 2);
    r = (await review.portalQuestionReview(client, projectId))!;
    expect(r.groups[0]!.questions[1]!.decision).toBe("edit_requested");
    expect(r.groups.find((g) => g.segment === g2!.segment)!.questions.every((q) => q.decision === null)).toBe(true);

    // Cannot send until everything is reviewed.
    expect((await review.submitQuestionReview(client, { projectId, versionId })).ok).toBe(false);
    unwrap(await review.approveRemainingQuestions(client, { projectId, versionId, segment: null }));
    r = (await review.portalQuestionReview(client, projectId))!;
    expect(r.remaining).toBe(0);

    // Freeze gate: an open portal request blocks staff approval of this version.
    const staffApprove = await delivery.recordSubjectDecision(operator, { engagementId, subjectKind: "question_set", subjectRef: versionId, decision: "approved", channel: "email", clientActor: "Lucia" });
    expect(staffApprove.ok).toBe(false);
    if (!staffApprove.ok) expect(staffApprove.error.message).toMatch(/asked for changes to 1 question/);

    // Send with an edit request → changes_requested, nothing to measure yet.
    expect(unwrap(await review.submitQuestionReview(client, { projectId, versionId })).decision).toBe("changes_requested");
    const draft = unwrap(await delivery.saveProtocolDraft(operator, { engagementId, promptSetVersionId: versionId, provider: "mock", model: "mock-model", geographicContext: "Albuquerque (synthetic)", repetitions: 3, baselineWindow: "Week 1", finalWindow: "Week 13", successCriteria: "Synthetic criteria" }));
    expect((await delivery.acceptProtocol(operator, { protocolId: draft.protocolId, clientActor: "Lucia", channel: "email" })).ok).toBe(false);
    // Nothing more is asked of the client once their review is sent.
    expect((await portal.portalDeliveryOverview(client, projectId))!.todos.some((t) => t.key === "questions")).toBe(false);

    // The client changes their mind: approve it after all, then send again.
    unwrap(await review.reviewQuestions(client, { projectId, versionId, items: [{ promptId: q2.promptId, decision: "approved" }] }));
    expect(unwrap(await review.submitQuestionReview(client, { projectId, versionId })).decision).toBe("approved");
    const set = (await delivery.listSubjectDecisions(engagementId, "question_set"))[0]!;
    expect(set).toMatchObject({ decision: "approved", channel: "portal", subjectRef: versionId });
    expect(set.snapshot).toMatchObject({ versionId, questionCount: 64, approved: 64 });
    expect(typeof set.snapshot.contentSha256).toBe("string");

    // Locked once approved; the trail is append-only.
    r = (await review.portalQuestionReview(client, projectId))!;
    expect(r.locked).toBe(true);
    expect(r.canRespond).toBe(false);
    expect((await review.reviewQuestions(client, { projectId, versionId, items: [{ promptId: q1.promptId, decision: "removed" }] })).ok).toBe(false);
    await expect(sql`update client_question_reviews set decision = 'removed'`).rejects.toThrow();
    await expect(sql`delete from client_question_reviews`).rejects.toThrow();
    const [count] = await sql`select count(*)::int as n from client_question_reviews where prompt_set_version_id = ${versionId}`;
    expect(count!.n).toBe(65);
  });

  it("isolates tenants: other clients and unknown projects look like nothing", async () => {
    const { projectId, engagementId } = await signedClient({ pay: true });
    await prepare(engagementId);
    unwrap(await onb.markOnboardingReady(operator, { engagementId }));
    const imported = unwrap(await delivery.importClientQuestions(operator, { engagementId, setName: "Seller questions", content: FIXTURE }));
    const elsewhere = await otherTenant();

    for (const attempt of [
      () => onb.portalOnboarding(otherClient, projectId),
      () => review.portalQuestionReview(otherClient, projectId),
      () => portal.portalDeliveryOverview(otherClient, projectId),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ kind: "not_found" });
    }
    for (const write of [
      onb.saveOnboardingPriorities(otherClient, { projectId, priorities: PRIORITIES }),
      onb.confirmOnboardingPriorities(otherClient, { projectId }),
      onb.completeClientOnboarding(otherClient, { projectId, contacts: { primaryName: "X", primaryEmail: "x@x.test", approverIsPrimary: true, approverName: "", approverEmail: "" } }),
      review.approveRemainingQuestions(otherClient, { projectId, versionId: imported.versionId!, segment: null }),
      review.submitQuestionReview(otherClient, { projectId, versionId: imported.versionId! }),
    ]) {
      const res = await write;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe("not_found");
    }
    // The granted client of the other tenant sees nothing to onboard there.
    expect(await onb.portalOnboarding(otherClient, elsewhere)).toBeNull();
    // Nothing was written by any refused attempt.
    const [count] = await sql`select count(*)::int as n from client_question_reviews`;
    expect(count!.n).toBe(0);
    const row = (await onb.onboardingForEngagement(engagementId))!;
    expect(row.clientPriorities).toBeNull();
    expect(row.prioritiesConfirmedAt).toBeNull();
  });
});
