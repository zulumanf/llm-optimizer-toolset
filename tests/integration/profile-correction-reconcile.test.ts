/**
 * Spec 147 slice 6 — reconciliation of stuck profile corrections, the
 * operator-confirmed retry of an uncertain Gmail draft, and withdrawal.
 *
 * Real database, engine (including its approval time-outs), event bus,
 * approval action and workflows. The network is a stub; the connector layer
 * is a recorder that only accepts `email.create_draft`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import {
  OPERATOR,
  RIGHT_BROKER_TEXT,
  WRONG_BROKER,
  approveCorrection,
  checkProfile,
  drive,
  profilePage,
  seedClient,
  stubNetwork,
  type ClientFixture,
  type Drivers,
  type Network,
} from "../helpers/profile-correction-fixtures";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const connector = vi.hoisted(() => ({ calls: [] as string[], drafts: 0 }));
vi.mock("@/lib/connectors/execute", () => ({
  executeCapability: vi.fn(async (args: { capability: string }) => {
    connector.calls.push(args.capability);
    if (args.capability !== "email.create_draft") throw new Error(`unexpected connector call: ${args.capability}`);
    connector.drafts += 1;
    return {
      ok: true,
      provider: "gmail",
      connectionId: null,
      data: { draftId: `r-${connector.drafts}`, messageId: `m-${connector.drafts}`, threadId: `t-${connector.drafts}` },
      rowsRead: 0,
      rowsWritten: 1,
    };
  }),
}));

const TEST_URL = process.env.TEST_DATABASE_URL;
const URL_A = "https://directory.example.com/agents/perez-realty";
const DAY1 = new Date("2026-10-05T12:00:00Z");
const DAY2 = new Date("2026-10-06T12:00:00Z");
const clientViewer: CurrentUser = { id: "00000000-0000-4000-8000-000000000801", email: "c@t.local", name: "C", role: "client_viewer" };

describe.skipIf(!TEST_URL)("profile correction reconciliation and recovery (spec 147 slice 6)", () => {
  let d: Drivers;
  let destinations: typeof import("@/lib/profile-corrections/destinations");
  let drafting: typeof import("@/lib/profile-corrections/drafting");
  let reconcile: typeof import("@/lib/profile-corrections/reconcile");
  let retry: typeof import("@/lib/profile-corrections/retry");
  let corrections: typeof import("@/lib/profile-corrections/approval");
  let automation: typeof import("@/lib/automation/workflows");
  let net: Network;
  let a: ClientFixture;
  let b: ClientFixture;

  beforeAll(async () => {
    const { sql } = await import("@/db/client");
    d = {
      sql,
      start: await import("@/lib/profile-corrections/start"),
      dispatch: await import("@/lib/profile-corrections/dispatch"),
      autoDispatch: await import("@/lib/automation/dispatch"),
      engine: await import("@/lib/workflow/engine"),
      approvals: await import("@/app/workflows/actions"),
    };
    destinations = await import("@/lib/profile-corrections/destinations");
    drafting = await import("@/lib/profile-corrections/drafting");
    reconcile = await import("@/lib/profile-corrections/reconcile");
    retry = await import("@/lib/profile-corrections/retry");
    corrections = await import("@/lib/profile-corrections/approval");
    automation = await import("@/lib/automation/workflows");
  }, 180_000);

  afterAll(async () => {
    await d.sql.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    connector.calls = [];
    connector.drafts = 0;
    await truncateAll(d.sql);
    await seedTestActors(d.sql);
    expect((await automation.bootstrapAutomation()).errors).toEqual([]);
    a = await seedClient(d.sql, "Perez Realty", [URL_A]);
    b = await seedClient(d.sql, "Rival Realty", [URL_A]);
    net = stubNetwork();
    net.pages.set(URL_A, profilePage([WRONG_BROKER]));
    await d.sql`
      insert into connector_connections (project_id, provider, connection_name, external_account_id, status,
        granted_scopes, config, created_by)
      values (null, 'gmail', 'corrections', 'c@x.example', 'active', '{}', ${d.sql.json({ sendAsAddress: "c@x.example" })}, ${OPERATOR.id})
    `;
  });

  // ------------------------------------------------------------ helpers

  async function setDestination(projectId: string, kind: "client_editor" | "publisher", email = "maria@perezrealty.example") {
    const r = await destinations.setCorrectionDestination(OPERATOR, {
      projectId,
      profileUrl: URL_A,
      kind,
      recipientName: kind === "publisher" ? "Corrections desk" : "Maria Perez",
      email,
      basis: "Recorded by the operator for this test.",
      ...(kind === "publisher" ? { sourceUrl: "https://directory.example.com/corrections" } : {}),
    });
    if (!r.ok) throw new Error(r.error.message);
    return r.data.destination!;
  }

  async function correction(projectId = a.projectId) {
    const [row] = await d.sql`select * from profile_correction_requests where project_id = ${projectId} order by created_at desc limit 1`;
    return row!;
  }

  /** The engine's own approval time-out: due date passed, then a tick. */
  async function expireApproval(runId: string): Promise<string> {
    await d.sql`update workflow_approvals set due_at = now() - interval '1 minute' where workflow_run_id = ${runId} and decision is null`;
    return drive(d, runId);
  }

  async function awaitingApproval(projectId = a.projectId, now = DAY1) {
    const { runId, state } = await checkProfile(d, projectId, now);
    expect(state).toBe("waiting_for_approval");
    return runId;
  }

  async function draftRun(): Promise<string> {
    const report = await drafting.dispatchCorrectionDrafts();
    expect(report.started).toHaveLength(1);
    const [row] = await d.sql`select event_id, run_idempotency_key from profile_correction_drafts where id = ${report.started[0]!.draftAttemptId}`;
    await d.autoDispatch.deliverOneEvent(row!.eventId as string);
    const [run] = await d.sql`select id from workflow_runs where idempotency_key = ${row!.runIdempotencyKey}`;
    expect(await drive(d, run!.id as string)).toBe("waiting_for_approval");
    return run!.id as string;
  }

  async function awaitingSendConfirmation(): Promise<string> {
    await setDestination(a.projectId, "client_editor");
    const runId = await awaitingApproval();
    expect(await approveCorrection(d, runId)).toBe("completed");
    const run = await draftRun();
    expect((await correction()).status).toBe("awaiting_send_confirmation");
    return run;
  }

  async function profileIsFree(projectId = a.projectId, now = DAY2): Promise<boolean> {
    const r = await d.start.startProfileChecks(OPERATOR, { projectId, origin: "operator" }, now);
    return r.ok && r.data.queued.length === 1;
  }

  async function auditFor(id: string) {
    return d.sql`
      select action, user_id, detail, at from audit_log
      where entity = 'profile_correction_request' and entity_id = ${id} order by at, id
    `;
  }

  // ------------------------------------------------------ reconciliation

  describe("reconciliation", () => {
    it("closes a timed-out content approval as expired, frees the profile, and keeps the history", async () => {
      const runId = await awaitingApproval();
      expect(await expireApproval(runId)).toBe("safely_stopped");
      const report = await reconcile.reconcileProfileCorrections();
      expect(report.moved).toEqual([
        expect.objectContaining({ from: "awaiting_approval", to: "expired", reason: "content_approval_run_stopped" }),
      ]);
      const row = await correction();
      expect(row).toMatchObject({ status: "expired", closedReason: "content_approval_run_stopped" });
      expect(row.request).toEqual(expect.objectContaining({ version: "profile-correction-request-v1" }));
      const audit = await auditFor(row.id as string);
      expect(audit.at(-1)).toMatchObject({ action: "profile_correction.expired", userId: null });
      expect(audit.at(-1)!.detail).toMatchObject({
        actor: "system:reconcile",
        from: "awaiting_approval",
        to: "expired",
        reason: "content_approval_run_stopped",
        contentRunId: runId,
      });
      expect(await d.sql`select id from workflow_approvals where workflow_run_id = ${runId}`).toHaveLength(1);
      expect(await profileIsFree()).toBe(true);
    });

    it("keeps a rejection terminal, and completes one the decision hook missed", async () => {
      const runId = await awaitingApproval();
      const [gate] = await d.sql`select id from workflow_approvals where workflow_run_id = ${runId}`;
      // The decision row recorded outside the hook (e.g. an older code path).
      await d.sql`update workflow_approvals set decision = 'rejected', decided_by = ${OPERATOR.id}, decided_at = now(), rationale = 'Not accurate.' where id = ${gate!.id}`;
      await d.sql`update workflow_runs set state = 'safely_stopped' where id = ${runId}`;
      await reconcile.reconcileProfileCorrections();
      expect(await correction()).toMatchObject({ status: "rejected", approvalId: gate!.id, decisionRationale: "Not accurate." });
      expect((await reconcile.reconcileProfileCorrections()).moved).toEqual([]);
      expect((await correction()).status).toBe("rejected");
    });

    it("returns a timed-out publisher approval to destination_required — never ready, never drafted", async () => {
      await setDestination(a.projectId, "publisher", "desk@directory.example.com");
      const runId = await awaitingApproval();
      expect(await approveCorrection(d, runId)).toBe("completed");
      expect((await correction()).status).toBe("awaiting_external_approval");
      const [event] = await d.sql`select id from domain_events where type = 'profile.external_approval_required'`;
      await d.autoDispatch.deliverOneEvent(event!.id as string);
      const [authRun] = await d.sql`select id from workflow_runs where idempotency_key like 'live:profile-external-approval:%'`;
      expect(await drive(d, authRun!.id as string)).toBe("waiting_for_approval");
      expect(await expireApproval(authRun!.id as string)).toBe("safely_stopped");

      await reconcile.reconcileProfileCorrections();
      expect(await correction()).toMatchObject({ status: "destination_required", destinationId: null });
      expect((await drafting.dispatchCorrectionDrafts()).started).toHaveLength(0);
      expect(connector.calls).toEqual([]);
    });

    it("never marks a send whose confirmation timed out: the draft's outcome becomes unknown", async () => {
      const run = await awaitingSendConfirmation();
      expect(await expireApproval(run)).toBe("safely_stopped");
      await reconcile.reconcileProfileCorrections();
      const row = await correction();
      expect(row).toMatchObject({ status: "ready_to_draft", activeDraftId: null, sentAt: null });
      const [attempt] = await d.sql`select * from profile_correction_drafts`;
      expect(attempt).toMatchObject({ status: "outcome_unknown", gmailDraftId: "r-1" });
      expect(await d.sql`select id from profile_check_requests where kind = 'recheck'`).toHaveLength(0);
      // No automatic retry of an uncertain Gmail action.
      expect((await drafting.dispatchCorrectionDrafts()).started).toHaveLength(0);
      expect(connector.calls).toEqual(["email.create_draft"]);
    });

    it("frees a profile whose check run failed outright", async () => {
      const runId = await awaitingApproval();
      await d.sql`update workflow_runs set state = 'failed' where id = ${runId}`;
      expect(await profileIsFree()).toBe(true); // startProfileChecks reconciles its project first
      expect((await correction()).status).toBe("expired");
    });

    it("closes a sent correction whose recheck run failed as needs_review — never corrected", async () => {
      await setDestination(a.projectId, "client_editor");
      const runId = await awaitingApproval();
      expect(await approveCorrection(d, runId)).toBe("completed");
      const run = await draftRun();
      const [gate] = await d.sql`select id from workflow_approvals where workflow_run_id = ${run} and decision is null`;
      expect((await d.approvals.decideApprovalAction({ approvalId: gate!.id, decision: "approved", rationale: "Sent it." })).ok).toBe(true);
      expect(await drive(d, run)).toBe("completed");
      const sent = await correction();
      expect(sent.status).toBe("sent");

      await d.sql`update profile_check_requests set not_before = now() - interval '1 minute' where kind = 'recheck'`;
      const report = await d.dispatch.dispatchProfileChecks();
      const [q] = await d.sql`select * from profile_check_requests where id = ${report.released[0]!}`;
      await d.autoDispatch.deliverOneEvent(q!.eventId as string);
      const [recheckRun] = await d.sql`select id from workflow_runs where idempotency_key = ${q!.runIdempotencyKey}`;
      net.pages.set(URL_A, profilePage([RIGHT_BROKER_TEXT], "after"));
      net.compareMode = "invalid";
      expect(await drive(d, recheckRun!.id as string)).toBe("safely_stopped");
      expect((await correction()).status).toBe("sent");

      await reconcile.reconcileProfileCorrections();
      const row = await correction();
      expect(row).toMatchObject({ status: "needs_review", closedReason: "recheck_run_stopped_without_result", recheckResultId: null });
      expect(await d.sql`select id from profile_correction_rechecks`).toHaveLength(0);
      const [failed] = await d.sql`select status, reason from profile_check_requests where kind = 'recheck'`;
      expect(failed).toMatchObject({ status: "failed", reason: "recheck_run_stopped_without_result" });
      expect(await profileIsFree(a.projectId, new Date("2026-10-30T12:00:00Z"))).toBe(true);
    });

    it("leaves healthy open requests untouched, is idempotent, and is safe under concurrent reconcilers", async () => {
      // Healthy: one waiting for approval (A), one waiting for a destination (B).
      await awaitingApproval(a.projectId);
      const runB = await awaitingApproval(b.projectId);
      expect(await approveCorrection(d, runB)).toBe("completed");
      expect((await correction(b.projectId)).status).toBe("destination_required");
      expect((await reconcile.reconcileProfileCorrections()).moved).toEqual([]);

      // Stuck: A's approval times out. Three reconcilers race.
      const [runA] = await d.sql`select workflow_run_id from profile_correction_requests where project_id = ${a.projectId}`;
      await expireApproval(runA!.workflowRunId as string);
      const reports = await Promise.all([
        reconcile.reconcileProfileCorrections(),
        reconcile.reconcileProfileCorrections(),
        reconcile.reconcileProfileCorrections(),
      ]);
      expect(reports.reduce((n, r) => n + r.moved.length, 0)).toBe(1);
      expect((await reconcile.reconcileProfileCorrections()).moved).toEqual([]);
      const audit = await auditFor((await correction()).id as string);
      expect(audit.filter((x) => x.action === "profile_correction.expired")).toHaveLength(1);
      expect((await correction(b.projectId)).status).toBe("destination_required");
    });

    it("reconciles only the named project", async () => {
      const runA = await awaitingApproval();
      await expireApproval(runA);
      expect((await reconcile.reconcileProfileCorrections({ projectId: b.projectId })).moved).toEqual([]);
      expect((await correction()).status).toBe("awaiting_approval");
      expect((await reconcile.reconcileProfileCorrections({ projectId: a.projectId })).moved).toHaveLength(1);
    });
  });

  // ------------------------------------------------------ manual retry

  describe("operator-confirmed draft retry", () => {
    async function uncertainAttempt() {
      const run = await awaitingSendConfirmation();
      await expireApproval(run);
      await reconcile.reconcileProfileCorrections();
      const row = await correction();
      const [attempt] = await d.sql`select * from profile_correction_drafts where status = 'outcome_unknown'`;
      return { row, attempt: attempt! };
    }

    const input = (row: Record<string, unknown>, attempt: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      projectId: a.projectId,
      correctionRequestId: row.id,
      draftAttemptId: attempt.id,
      expectedRequestSha256: row.requestSha256,
      expectedDestinationId: row.destinationId,
      confirmNoUsableDraft: true,
      reason: "Checked Gmail: the draft was deleted and nothing was sent.",
      ...extra,
    });

    it("requires the explicit Gmail confirmation, supersedes the old attempt, and queues exactly one new one", async () => {
      const { row, attempt } = await uncertainAttempt();
      const unconfirmed = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt, { confirmNoUsableDraft: false }));
      expect(unconfirmed.ok).toBe(false);
      if (!unconfirmed.ok) expect(unconfirmed.error.message).toMatch(/checked Gmail/);

      const first = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt));
      const again = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt));
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;
      expect(first.data.created).toBe(true);
      expect(again.data).toEqual({ ...first.data, created: false });

      const attempts = await d.sql`select * from profile_correction_drafts order by attempt`;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ id: attempt.id, status: "superseded", gmailDraftId: "r-1" });
      expect(attempts[1]).toMatchObject({ status: "pending", retryOf: attempt.id, retryRequestedBy: OPERATOR.id });
      expect(await d.sql`select id from domain_events where type = 'profile.correction_ready'`).toHaveLength(2);

      // The retry drafts normally, through the same workflow.
      const [ev] = await d.sql`select event_id, run_idempotency_key from profile_correction_drafts where id = ${first.data.draftAttemptId}`;
      await d.autoDispatch.deliverOneEvent(ev!.eventId as string);
      const [run] = await d.sql`select id from workflow_runs where idempotency_key = ${ev!.runIdempotencyKey}`;
      expect(await drive(d, run!.id as string)).toBe("waiting_for_approval");
      expect(connector.calls).toEqual(["email.create_draft", "email.create_draft"]);
      expect((await correction()).status).toBe("awaiting_send_confirmation");
      const audit = await auditFor(row.id as string);
      expect(audit.find((x) => x.action === "profile_correction.draft_retried")!.detail).toMatchObject({
        from: "outcome_unknown",
        supersededAttemptId: attempt.id,
        supersededGmailDraftId: "r-1",
      });
    });

    it("retries an orphaned attempt the same way", async () => {
      const { row, attempt } = await uncertainAttempt();
      await d.sql`update profile_correction_drafts set status = 'orphaned' where id = ${attempt.id}`;
      const r = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt));
      expect(r.ok && r.data.created).toBe(true);
    });

    it("refuses a stale hash, a replaced destination, another project and a client role", async () => {
      const { row, attempt } = await uncertainAttempt();
      const stale = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt, { expectedRequestSha256: "f".repeat(64) }));
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.message).toMatch(/hash changed/);

      const replaced = await setDestination(a.projectId, "client_editor", "luis@perezrealty.example");
      const oldDest = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt));
      expect(oldDest.ok).toBe(false);
      if (!oldDest.ok) expect(oldDest.error.message).toMatch(/destination changed/);

      const foreign = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt, { projectId: b.projectId, expectedDestinationId: replaced.id }));
      expect(foreign.ok).toBe(false);
      const client = await retry.retryProfileCorrectionDraft(clientViewer, input(row, attempt, { expectedDestinationId: replaced.id }));
      expect(client.ok).toBe(false);

      const ok = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt, { expectedDestinationId: replaced.id }));
      expect(ok.ok).toBe(true);
      expect(connector.calls).toEqual(["email.create_draft"]);
    });

    it("refuses an attempt that is not uncertain", async () => {
      await awaitingSendConfirmation();
      const row = await correction();
      const [attempt] = await d.sql`select * from profile_correction_drafts`;
      const r = await retry.retryProfileCorrectionDraft(OPERATOR, input(row, attempt!));
      expect(r.ok).toBe(false);
    });
  });

  // ---------------------------------------------------------- withdrawal

  describe("withdrawal", () => {
    it("frees the profile, keeps history, neutralizes pending work, and does nothing external", async () => {
      const run = await awaitingSendConfirmation();
      const row = await correction();
      const w = await corrections.withdrawCorrectionRequest(OPERATOR, {
        projectId: a.projectId,
        correctionRequestId: row.id,
        reason: "Client fixed the page themselves.",
      });
      expect(w.ok).toBe(true);
      expect(await correction()).toMatchObject({ status: "withdrawn", closedBy: OPERATOR.id });
      const [attempt] = await d.sql`select status, gmail_draft_id from profile_correction_drafts`;
      expect(attempt).toMatchObject({ status: "discarded", gmailDraftId: "r-1" });
      expect((await d.sql`select state from workflow_runs where id = ${run}`)[0]!.state).toBe("cancelled");
      expect(await d.sql`select id from profile_correction_requests`).toHaveLength(1);
      expect(connector.calls).toEqual(["email.create_draft"]);
      expect(await profileIsFree()).toBe(true);
      // A late confirmation of the withdrawn request records nothing.
      expect((await reconcile.reconcileProfileCorrections()).moved).toEqual([]);
      expect((await correction()).status).toBe("withdrawn");
    });

    it("cancels a pending content approval run when withdrawn", async () => {
      const runId = await awaitingApproval();
      const row = await correction();
      const w = await corrections.withdrawCorrectionRequest(OPERATOR, { projectId: a.projectId, correctionRequestId: row.id, reason: "Not needed." });
      expect(w.ok).toBe(true);
      expect((await d.sql`select state from workflow_runs where id = ${runId}`)[0]!.state).toBe("cancelled");
      expect(await profileIsFree()).toBe(true);
    });
  });

  it("defines OPEN identically in code and in the database's one-open index", async () => {
    const { OPEN_CORRECTION_STATUSES } = await import("@/lib/profile-corrections/constants");
    const [index] = await d.sql`
      select indexdef from pg_indexes where indexname = 'profile_correction_requests_one_open'
    `;
    const inIndex = [...String(index!.indexdef).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(inIndex).toEqual([...OPEN_CORRECTION_STATUSES].sort());
  });

  it("makes no model call and no connector call while reconciling or retrying", async () => {
    const run = await awaitingSendConfirmation();
    const models = net.modelCalls;
    await expireApproval(run);
    await reconcile.reconcileProfileCorrections();
    await reconcile.reconcileProfileCorrections();
    expect(net.modelCalls).toBe(models);
    expect(connector.calls).toEqual(["email.create_draft"]);
    const paid = await d.sql`select id from llm_calls where backend is distinct from 'ollama' or cost_micro_usd <> 0`;
    expect(paid).toHaveLength(0);
  });
});
