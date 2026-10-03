/**
 * Spec 147 slice 4 — Gmail drafts, human send confirmation and the recheck
 * schedule.
 *
 * Real database, engine, event bus, approval action and workflows. The
 * network is a stub (profile pages + local Ollama), and the connector layer
 * is replaced by a recorder: `email.create_draft` returns draft ids, and any
 * other capability — above all a send — fails the test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import {
  OPERATOR,
  WRONG_BROKER,
  approveCorrection,
  checkProfile,
  drive,
  profilePage,
  seedClient,
  stubNetwork,
  type ClientFixture,
  type Drivers,
} from "../helpers/profile-correction-fixtures";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const connector = vi.hoisted(() => ({
  calls: [] as { capability: string; input: Record<string, unknown>; projectId: string | null; provider?: string }[],
  draftCounter: 0,
}));

vi.mock("@/lib/connectors/execute", () => ({
  executeCapability: vi.fn(async (args: { capability: string; input: Record<string, unknown>; projectId: string | null; provider?: string }) => {
    connector.calls.push({ capability: args.capability, input: args.input, projectId: args.projectId, provider: args.provider });
    if (args.capability !== "email.create_draft") {
      throw new Error(`unexpected connector call: ${args.capability}`);
    }
    connector.draftCounter += 1;
    return {
      ok: true,
      provider: "gmail",
      connectionId: null,
      data: { draftId: `r-${connector.draftCounter}`, messageId: `m-${connector.draftCounter}`, threadId: `t-${connector.draftCounter}` },
      rowsRead: 0,
      rowsWritten: 1,
    };
  }),
}));

const TEST_URL = process.env.TEST_DATABASE_URL;
const URL_A = "https://directory.example.com/agents/perez-realty";
const SENDER = "corrections@recommendedfirst.example";
const DAY1 = new Date("2026-10-05T12:00:00Z");
const DAY_MS = 86_400_000;

describe.skipIf(!TEST_URL)("profile correction drafts and send confirmation (spec 147 slice 4)", () => {
  let d: Drivers;
  let destinations: typeof import("@/lib/profile-corrections/destinations");
  let drafting: typeof import("@/lib/profile-corrections/drafting");
  let automation: typeof import("@/lib/automation/workflows");
  let nodes: typeof import("@/lib/automation/nodes/profile-correction");
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
    automation = await import("@/lib/automation/workflows");
    nodes = await import("@/lib/automation/nodes/profile-correction");
  }, 180_000);

  afterAll(async () => {
    await d.sql.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    connector.calls = [];
    connector.draftCounter = 0;
    await truncateAll(d.sql);
    await seedTestActors(d.sql);
    expect((await automation.bootstrapAutomation()).errors).toEqual([]);
    a = await seedClient(d.sql, "Perez Realty", [URL_A], { contactEmail: "maria@perezrealty.example", contactName: "Maria Perez" });
    b = await seedClient(d.sql, "Rival Realty", [URL_A]);
    const net = stubNetwork();
    net.pages.set(URL_A, profilePage([WRONG_BROKER]));
  });

  // ------------------------------------------------------------ helpers

  async function gmailConnected(config: Record<string, unknown> = { sendAsAddress: SENDER }, projectId: string | null = null) {
    await d.sql`
      insert into connector_connections (project_id, provider, connection_name, external_account_id, status,
        granted_scopes, config, created_by)
      values (${projectId}, 'gmail', 'corrections', ${SENDER}, 'active', '{}', ${d.sql.json(config as never)}, ${OPERATOR.id})
    `;
  }

  async function setEditor(projectId = a.projectId) {
    const r = await destinations.setCorrectionDestination(OPERATOR, {
      projectId,
      profileUrl: URL_A,
      kind: "client_editor",
      recipientName: "Maria Perez",
      email: "maria@perezrealty.example",
      basis: "Client confirmed Maria edits this profile.",
    });
    if (!r.ok) throw new Error(r.error.message);
    return r.data.destination!;
  }

  async function correction(projectId = a.projectId) {
    const [row] = await d.sql`select * from profile_correction_requests where project_id = ${projectId}`;
    return row!;
  }

  async function drafts(projectId = a.projectId) {
    return d.sql`select * from profile_correction_drafts where project_id = ${projectId} order by attempt`;
  }

  async function readyToDraft(projectId = a.projectId) {
    const { runId } = await checkProfile(d, projectId, DAY1);
    expect(await approveCorrection(d, runId)).toBe("completed");
    expect((await correction(projectId)).status).toBe("ready_to_draft");
  }

  /** Sweep → deliver every new attempt's event → drive its run to its gate or end. */
  async function sweepAndDraft(): Promise<string[]> {
    const report = await drafting.dispatchCorrectionDrafts();
    const runIds: string[] = [];
    for (const s of report.started) {
      const [attempt] = await d.sql`select event_id, run_idempotency_key from profile_correction_drafts where id = ${s.draftAttemptId}`;
      await d.autoDispatch.deliverOneEvent(attempt!.eventId as string);
      const [run] = await d.sql`select id from workflow_runs where idempotency_key = ${attempt!.runIdempotencyKey}`;
      await drive(d, run!.id as string);
      runIds.push(run!.id as string);
    }
    return runIds;
  }

  async function confirmGate(runId: string) {
    const [gate] = await d.sql`
      select a.id, a.detail from workflow_approvals a join node_runs n on n.id = a.node_run_id
      where a.workflow_run_id = ${runId} and n.node_key = 'confirm_sent'
    `;
    return gate!;
  }

  async function confirm(runId: string, decision: "approved" | "rejected" = "approved") {
    const gate = await confirmGate(runId);
    return d.approvals.decideApprovalAction({
      approvalId: gate.id,
      decision,
      rationale: decision === "approved" ? "Sent it from Gmail just now." : "Not sending this one.",
    });
  }

  function sends() {
    return connector.calls.filter((c) => c.capability !== "email.create_draft");
  }

  async function recheckRows() {
    return d.sql`select * from profile_check_requests where kind = 'recheck'`;
  }

  // ---------------------------------------------------------- drafting

  it("drafts a ready request exactly once, never sends, and waits for a human", async () => {
    await gmailConnected();
    const dest = await setEditor();
    await readyToDraft();

    const [runId] = await sweepAndDraft();
    expect(connector.calls).toHaveLength(1);
    const call = connector.calls[0]!;
    expect(call).toMatchObject({ capability: "email.create_draft", provider: "gmail", projectId: a.projectId });
    expect(Object.keys(call.input).sort()).toEqual(["body", "subject", "to"]);
    expect(call.input.to).toBe("maria@perezrealty.example");
    expect(call.input.subject).toBe("Correction needed on directory.example.com");
    expect(String(call.input.body)).toContain(`The page says: "${WRONG_BROKER}"`);

    const row = await correction();
    expect(row).toMatchObject({ status: "awaiting_send_confirmation", destinationId: dest.id });
    const [draft] = await drafts();
    expect(draft).toMatchObject({
      status: "created",
      gmailDraftId: "r-1",
      gmailMessageId: "m-1",
      gmailThreadId: "t-1",
      fromAddress: SENDER,
      destinationId: dest.id,
      requestSha256: row.requestSha256,
      emailVersion: "profile-correction-email-v1",
    });
    expect(row.activeDraftId).toBe(draft!.id);
    expect(draft!.email).toMatchObject({ to: call.input.to, subject: call.input.subject, body: call.input.body });

    // What the operator sees at the confirmation gate: how to find the draft.
    const gate = await confirmGate(runId!);
    const artifact = (gate.detail as { output: { artifact: Record<string, unknown> } }).output.artifact;
    expect(artifact).toMatchObject({
      correctionRequestId: row.id,
      requestSha256: row.requestSha256,
      destinationId: dest.id,
      draftAttemptId: draft!.id,
      gmailDraftId: "r-1",
      to: "maria@perezrealty.example",
      gmailSearch: 'in:drafts to:maria@perezrealty.example subject:"Correction needed on directory.example.com"',
      sent: false,
    });

    // A draft alone is not a send: no sent status, no recheck.
    expect(row.sentAt).toBeNull();
    expect(await recheckRows()).toHaveLength(0);

    // Duplicate triggers create nothing new.
    await sweepAndDraft();
    const [attempt] = await d.sql`select event_id from profile_correction_drafts where id = ${draft!.id}`;
    await d.autoDispatch.deliverOneEvent(attempt!.eventId as string);
    expect(connector.calls).toHaveLength(1);
    expect(await drafts()).toHaveLength(1);
    expect(sends()).toEqual([]);

    const paid = await d.sql`select id from llm_calls where backend is distinct from 'ollama' or cost_micro_usd <> 0`;
    expect(paid).toHaveLength(0);
  });

  it("picks up a ready_to_draft backlog from before drafting existed, once", async () => {
    await gmailConnected();
    await setEditor();
    await readyToDraft();
    // Simulate the pre-slice-4 backlog: no job, no attempt, only the ready row.
    await d.sql`delete from jobs where type = 'profile_correction_draft_dispatch'`;
    expect(await drafts()).toHaveLength(0);

    const [first, second] = await Promise.all([drafting.dispatchCorrectionDrafts(), drafting.dispatchCorrectionDrafts()]);
    expect(first.started.length + second.started.length).toBe(1);
    expect(await drafts()).toHaveLength(1);
    expect(await d.sql`select id from domain_events where type = 'profile.correction_ready'`).toHaveLength(1);
  });

  it("safe-stops with no Gmail connection, and without a sendAsAddress, and never marks drafted", async () => {
    await setEditor();
    await readyToDraft();
    const [run1] = await sweepAndDraft();
    expect((await d.sql`select state from workflow_runs where id = ${run1!}`)[0]!.state).toBe("safely_stopped");
    expect(connector.calls).toHaveLength(0);
    expect((await correction()).status).toBe("ready_to_draft");
    expect((await drafts())[0]).toMatchObject({ status: "failed", failureReason: expect.stringMatching(/no Gmail connection/) });

    // A failed attempt is not retried inside the back-off window.
    expect((await drafting.dispatchCorrectionDrafts()).started).toHaveLength(0);

    await gmailConnected({});
    await d.sql`update profile_correction_drafts set updated_at = now() - interval '7 hours'`;
    await sweepAndDraft();
    expect(connector.calls).toHaveLength(0);
    const attempts = await drafts();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ status: "failed", failureReason: expect.stringMatching(/sendAsAddress/) });
    expect((await correction()).status).toBe("ready_to_draft");
  });

  it("refuses a stale attempt after the destination was replaced, and drafts for the new one", async () => {
    await gmailConnected();
    const first = await setEditor();
    await readyToDraft();
    const report = await drafting.dispatchCorrectionDrafts();
    expect(report.started).toHaveLength(1);

    // Replaced before the attempt ran: the pending attempt is superseded.
    const replaced = await destinations.setCorrectionDestination(OPERATOR, {
      projectId: a.projectId,
      profileUrl: URL_A,
      kind: "client_editor",
      recipientName: "Luis Perez",
      email: "luis@perezrealty.example",
      basis: "Client confirmed Luis now edits this profile.",
    });
    if (!replaced.ok) throw new Error(replaced.error.message);
    expect((await drafts())[0]).toMatchObject({ status: "superseded", destinationId: first.id });

    // The stale attempt's run refuses before calling Gmail.
    const [stale] = await d.sql`select event_id, run_idempotency_key from profile_correction_drafts where attempt = 1`;
    await d.autoDispatch.deliverOneEvent(stale!.eventId as string);
    const [staleRun] = await d.sql`select id from workflow_runs where idempotency_key = ${stale!.runIdempotencyKey}`;
    expect(await drive(d, staleRun!.id as string)).not.toBe("waiting_for_approval");
    expect(connector.calls).toHaveLength(0);

    await sweepAndDraft();
    expect(connector.calls).toHaveLength(1);
    expect(connector.calls[0]!.input.to).toBe("luis@perezrealty.example");
    expect((await correction()).status).toBe("awaiting_send_confirmation");
  });

  it("rejects cross-project data: another client's attempt or destination", async () => {
    await gmailConnected();
    await setEditor();
    await readyToDraft();
    const report = await drafting.dispatchCorrectionDrafts();
    const attemptId = report.started[0]!.draftAttemptId;
    const row = await correction();

    const prepare = nodes.profileCorrectionNodes["dom.prepare_profile_correction_draft"]!;
    const [run] = await d.sql`select id from workflow_runs order by started_at desc limit 1`;
    const result = await prepare({
      runId: run!.id as string,
      projectId: b.projectId,
      nodeKey: "prepare_draft",
      fanKey: "",
      attempt: 1,
      inputs: {},
      workflowInput: { payload: { correctionRequestId: row.id, destinationId: row.destinationId, draftAttemptId: attemptId } },
      config: { requestVersion: "profile-correction-request-v1" },
      node: {} as never,
      remainingCostMicroUsd: null,
    });
    expect(result).toMatchObject({ outcome: "failed_terminal", error: expect.stringMatching(/not in this client's scope/) });

    const bDest = await setEditor(b.projectId);
    await expect(d.sql`
      insert into profile_correction_drafts (project_id, correction_request_id, destination_id, request_sha256, attempt, run_idempotency_key)
      values (${a.projectId}, ${row.id}, ${bDest.id}, ${row.requestSha256}, 9, 'x-cross')
    `).rejects.toThrow(/destination is not in project/);
    expect(connector.calls).toHaveLength(0);
  });

  // ------------------------------------------------- send confirmation

  it("records the send only on a bound human confirmation, and queues exactly one recheck", async () => {
    await gmailConnected();
    const dest = await setEditor();
    await readyToDraft();
    const [runId] = await sweepAndDraft();

    const before = Date.now();
    const decided = await confirm(runId!);
    expect(decided.ok).toBe(true);
    expect(await drive(d, runId!)).toBe("completed");

    const row = await correction();
    expect(row).toMatchObject({ status: "sent", destinationId: dest.id, sentConfirmedBy: "00000000-0000-4000-8000-000000000001" });
    const [draft] = await drafts();
    expect(draft).toMatchObject({ status: "sent", gmailDraftId: "r-1" });
    expect(row.sentDraftId).toBe(draft!.id);
    const sentAt = (row.sentAt as Date).getTime();
    expect(sentAt).toBeGreaterThanOrEqual(before - 1000);
    expect((row.recheckDueAt as Date).getTime() - sentAt).toBe(14 * DAY_MS);

    const rechecks = await recheckRows();
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0]).toMatchObject({
      projectId: a.projectId,
      correctionRequestId: row.id,
      profileUrl: URL_A,
      status: "queued",
      origin: "recheck",
      runIdempotencyKey: `live:profile-recheck:${row.id}`,
    });
    expect((rechecks[0]!.notBefore as Date).getTime()).toBe((row.recheckDueAt as Date).getTime());
    // The before-page evidence stays linked through the request.
    expect(row.beforeSourceArtifactId).toEqual(expect.any(String));

    // The recheck is not released before it is due.
    const released = await d.dispatch.dispatchProfileChecks();
    expect(released.released).toHaveLength(0);

    // Repeating the record step is a no-op: no second recheck, same sent time.
    const recordSent = nodes.profileCorrectionNodes["dom.record_profile_correction_sent"]!;
    const again = await recordSent({
      runId: runId!,
      projectId: a.projectId,
      nodeKey: "record_sent",
      fanKey: "",
      attempt: 2,
      inputs: {},
      workflowInput: { payload: { correctionRequestId: row.id, destinationId: dest.id, draftAttemptId: draft!.id } },
      config: { requestVersion: "profile-correction-request-v1", approvalNode: "confirm_sent" },
      node: {} as never,
      remainingCostMicroUsd: null,
    });
    expect(again).toMatchObject({ outcome: "succeeded", output: { alreadySent: true, recheckQueued: false } });
    expect(await recheckRows()).toHaveLength(1);
    // Deciding the same approval again is refused by the existing action.
    expect((await confirm(runId!)).ok).toBe(false);
    expect(sends()).toEqual([]);
  });

  it("refuses a confirmation bound to the wrong hash or the wrong Gmail draft", async () => {
    await gmailConnected();
    await setEditor();
    await readyToDraft();
    const [runId] = await sweepAndDraft();
    const gate = await confirmGate(runId!);

    await d.sql`
      update workflow_approvals set detail = jsonb_set(detail, '{output,artifact,gmailDraftId}', '"r-999"')
      where id = ${gate.id}
    `;
    const wrongDraft = await confirm(runId!);
    expect(wrongDraft.ok).toBe(false);
    if (!wrongDraft.ok) expect(wrongDraft.error.message).toMatch(/Gmail draft/);

    await d.sql`
      update workflow_approvals
      set detail = jsonb_set(jsonb_set(detail, '{output,artifact,gmailDraftId}', '"r-1"'), '{output,artifact,requestSha256}', ${d.sql.json("0".repeat(64) as never)})
      where id = ${gate.id}
    `;
    const wrongHash = await confirm(runId!);
    expect(wrongHash.ok).toBe(false);
    if (!wrongHash.ok) expect(wrongHash.error.message).toMatch(/request hash/);

    expect((await correction()).status).toBe("awaiting_send_confirmation");
    expect(await recheckRows()).toHaveLength(0);
  });

  it("refuses a confirmation after the destination was archived", async () => {
    await gmailConnected();
    const dest = await setEditor();
    await readyToDraft();
    const [runId] = await sweepAndDraft();
    const archived = await destinations.archiveCorrectionDestination(OPERATOR, {
      projectId: a.projectId,
      destinationId: dest.id,
      reason: "Maria left the team.",
    });
    expect(archived.ok).toBe(true);
    const decided = await confirm(runId!);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error.message).toMatch(/no longer the active one/);
    expect((await correction()).status).toBe("awaiting_send_confirmation");
    expect(await recheckRows()).toHaveLength(0);
  });

  it("declining the send withdraws the request and discards the draft", async () => {
    await gmailConnected();
    await setEditor();
    await readyToDraft();
    const [runId] = await sweepAndDraft();
    const decided = await confirm(runId!, "rejected");
    expect(decided.ok).toBe(true);
    expect(await correction()).toMatchObject({ status: "withdrawn", closedReason: "send not confirmed: Not sending this one." });
    expect((await drafts())[0]).toMatchObject({ status: "discarded" });
    expect(await drive(d, runId!)).toBe("safely_stopped");
    expect(await recheckRows()).toHaveLength(0);
  });

  it("keeps a drafted email write-once at the database", async () => {
    await gmailConnected();
    await setEditor();
    await readyToDraft();
    await sweepAndDraft();
    const [draft] = await drafts();
    await expect(
      d.sql`update profile_correction_drafts set email = '{}'::jsonb where id = ${draft!.id}`
    ).rejects.toThrow(/write-once/);
    await expect(
      d.sql`update profile_correction_drafts set gmail_draft_id = 'r-x' where id = ${draft!.id}`
    ).rejects.toThrow(/write-once/);
    await expect(d.sql`delete from profile_correction_drafts`).rejects.toThrow(/forbidden/);
  });
});
