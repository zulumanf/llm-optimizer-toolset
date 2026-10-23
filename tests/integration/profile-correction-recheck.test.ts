/**
 * Spec 147 slice 5 — the 14-day recheck.
 *
 * Real database, queue, dispatcher, event bus, engine, approval action and
 * the frozen comparison path. The network is a stub (profile pages + the local
 * Ollama endpoint, counted); the connector layer is a recorder that only
 * accepts `email.create_draft`, used to reach a sent correction.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import {
  OPERATOR,
  RIGHT_BROKER_TEXT,
  RIGHT_SALES_TEXT,
  WRONG_BROKER,
  WRONG_SALES,
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

// Spec 158: profile corrections are opt-in (unset = off). These suites test
// the feature itself, so they run with it explicitly enabled; the disabled
// behaviour and the draft-retry cap are covered at the end of
// profile-correction-drafts.test.ts.
beforeAll(() => {
  vi.stubEnv("PROFILE_CORRECTIONS_ENABLED", "true");
});
afterAll(() => {
  vi.unstubAllEnvs();
});
const URL_A = "https://directory.example.com/agents/perez-realty";
const DAY0 = new Date("2026-10-04T12:00:00Z");
const DAY1 = new Date("2026-10-05T12:00:00Z");

describe.skipIf(!TEST_URL)("profile correction recheck (spec 147 slice 5)", () => {
  let d: Drivers;
  let destinations: typeof import("@/lib/profile-corrections/destinations");
  let drafting: typeof import("@/lib/profile-corrections/drafting");
  let automation: typeof import("@/lib/automation/workflows");
  let nodes: typeof import("@/lib/automation/nodes/profile-correction");
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
    automation = await import("@/lib/automation/workflows");
    nodes = await import("@/lib/automation/nodes/profile-correction");
  }, 180_000);

  afterAll(async () => {
    await d.sql.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS;
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
    await d.sql`
      insert into connector_connections (project_id, provider, connection_name, external_account_id, status,
        granted_scopes, config, created_by)
      values (null, 'gmail', 'corrections', 'c@x.example', 'active', '{}', ${d.sql.json({ sendAsAddress: "c@x.example" })}, ${OPERATOR.id})
    `;
  });

  // ------------------------------------------------------------ helpers

  /** Check → approve → route → draft → human confirms → sent (recheck queued). */
  async function sentCorrection(fixture: ClientFixture, lines: string[], now = DAY1): Promise<string> {
    net.pages.set(URL_A, profilePage(lines, `${fixture.projectId}-before`));
    const set = await destinations.setCorrectionDestination(OPERATOR, {
      projectId: fixture.projectId,
      profileUrl: URL_A,
      kind: "client_editor",
      recipientName: "Maria Perez",
      email: "maria@perezrealty.example",
      basis: "Client confirmed Maria edits this profile.",
    });
    if (!set.ok) throw new Error(set.error.message);
    const { runId } = await checkProfile(d, fixture.projectId, now);
    expect(await approveCorrection(d, runId)).toBe("completed");
    const report = await drafting.dispatchCorrectionDrafts();
    const attempt = report.started.find((s) => s.correctionRequestId);
    const [row] = await d.sql`select event_id, run_idempotency_key from profile_correction_drafts where id = ${attempt!.draftAttemptId}`;
    await d.autoDispatch.deliverOneEvent(row!.eventId as string);
    const [draftRun] = await d.sql`select id from workflow_runs where idempotency_key = ${row!.runIdempotencyKey}`;
    expect(await drive(d, draftRun!.id as string)).toBe("waiting_for_approval");
    const [gate] = await d.sql`select id from workflow_approvals where workflow_run_id = ${draftRun!.id} and decision is null`;
    const confirmed = await d.approvals.decideApprovalAction({ approvalId: gate!.id, decision: "approved", rationale: "Sent from Gmail." });
    expect(confirmed.ok).toBe(true);
    expect(await drive(d, draftRun!.id as string)).toBe("completed");
    const [correction] = await d.sql`
      select id, status from profile_correction_requests where project_id = ${fixture.projectId} and status = 'sent'
    `;
    return correction!.id as string;
  }

  async function makeDue(correctionId: string) {
    await d.sql`
      update profile_check_requests set not_before = now() - interval '1 minute'
      where kind = 'recheck' and correction_request_id = ${correctionId}
    `;
  }

  /** Release due work, deliver the recheck event, drive the run. */
  async function runRecheck(correctionId: string): Promise<{ runId: string; state: string }> {
    await makeDue(correctionId);
    const report = await d.dispatch.dispatchProfileChecks();
    expect(report.released).toHaveLength(1);
    const [q] = await d.sql`select * from profile_check_requests where id = ${report.released[0]!}`;
    expect(q).toMatchObject({ kind: "recheck", correctionRequestId: correctionId });
    await d.autoDispatch.deliverOneEvent(q!.eventId as string);
    const [run] = await d.sql`select id from workflow_runs where idempotency_key = ${q!.runIdempotencyKey}`;
    return { runId: run!.id as string, state: await drive(d, run!.id as string) };
  }

  async function result(correctionId: string) {
    const [row] = await d.sql`select * from profile_correction_rechecks where correction_request_id = ${correctionId}`;
    return row;
  }

  async function correctionRow(id: string) {
    const [row] = await d.sql`select * from profile_correction_requests where id = ${id}`;
    return row!;
  }

  // ----------------------------------------------------------- dispatch

  describe("dispatch", () => {
    it("releases a recheck only once due, through the shared bounded dispatcher, once", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      // Not due: nothing is released.
      expect((await d.dispatch.dispatchProfileChecks()).released).toHaveLength(0);

      await makeDue(id);
      const reports = await Promise.all([
        d.dispatch.dispatchProfileChecks(),
        d.dispatch.dispatchProfileChecks(),
        d.dispatch.dispatchProfileChecks(),
      ]);
      expect(reports.reduce((n, r) => n + r.released.length, 0)).toBe(1);
      const events = await d.sql`select project_id, payload from domain_events where type = 'profile.recheck_due'`;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ projectId: a.projectId, payload: { correctionRequestId: id, profileUrl: URL_A } });
    });

    it("shares capacity with normal checks and releases the oldest due work first", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      // A normal check queued for client B, due now but newer than the recheck.
      await makeDue(id);
      await d.sql`update profile_check_requests set not_before = now() - interval '2 minutes' where kind = 'recheck'`;
      const queuedB = await d.start.startProfileChecks(OPERATOR, { projectId: b.projectId, origin: "operator" }, DAY1);
      expect(queuedB.ok && queuedB.data.queued).toHaveLength(1);

      // An inference-active run holds the single slot: nothing is released.
      const [version] = await d.sql`
        select v.id from workflow_versions v join workflow_definitions w on w.id = v.definition_id
        where w.key = 'reputation_profile_recheck_v1' order by v.version desc limit 1
      `;
      await d.sql`insert into workflow_runs (version_id, project_id, idempotency_key, state) values (${version!.id}, ${b.projectId}, 'busy', 'running')`;
      expect((await d.dispatch.dispatchProfileChecks()).released).toHaveLength(0);

      await d.sql`update workflow_runs set state = 'completed' where idempotency_key = 'busy'`;
      const report = await d.dispatch.dispatchProfileChecks();
      expect(report.released).toHaveLength(1);
      const [first] = await d.sql`select kind from profile_check_requests where id = ${report.released[0]!}`;
      expect(first!.kind).toBe("recheck");
      // The check stays queued until the recheck's run settles.
      expect(await d.sql`select id from profile_check_requests where kind = 'check' and status = 'queued'`).toHaveLength(1);
    });

    it("another project cannot load or record this recheck", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      net.pages.set(URL_A, profilePage([WRONG_BROKER], `${a.projectId}-before`));
      const { runId } = await runRecheck(id);
      const load = nodes.profileCorrectionNodes["dom.load_profile_correction_recheck"]!;
      const out = await load({
        runId,
        projectId: b.projectId,
        nodeKey: "load_request",
        fanKey: "",
        attempt: 2,
        inputs: {},
        workflowInput: { payload: { correctionRequestId: id, profileUrl: URL_A } },
        config: { requestVersion: "profile-correction-request-v1" },
        node: {} as never,
        remainingCostMicroUsd: null,
      });
      expect(out).toMatchObject({ outcome: "failed_terminal", error: expect.stringMatching(/not in this client's scope/) });
      const r = await result(id);
      await expect(d.sql`
        insert into profile_correction_rechecks (project_id, correction_request_id, workflow_run_id, profile_url,
          request_sha256, before_source_artifact_id, page_state, result, result_version, result_detail, result_sha256)
        values (${b.projectId}, ${id}, ${runId}, ${URL_A}, ${r!.requestSha256}, ${r!.beforeSourceArtifactId},
          'unreachable', 'unreachable', 'v', '{}'::jsonb, ${"c".repeat(64)})
      `).rejects.toThrow(/does not match a correction request/);
    });
  });

  // ---------------------------------------------------------- fast paths

  describe("fast paths", () => {
    it("an identical page is still_incorrect with zero model calls", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      const before = net.modelCalls;
      const { state } = await runRecheck(id);
      expect(state).toBe("completed");
      expect(net.modelCalls).toBe(before);
      expect(await result(id)).toMatchObject({ pageState: "unchanged", result: "still_incorrect" });
      expect((await correctionRow(id)).status).toBe("still_incorrect");
    });

    it("a page matching an older processed version is needs_review, with no model call", async () => {
      // An earlier, clean check stored and extracted page P0.
      const p0 = profilePage([RIGHT_BROKER_TEXT], "p0");
      net.pages.set(URL_A, p0);
      const clean = await checkProfile(d, a.projectId, DAY0);
      expect(clean.state).toBe("completed");
      const id = await sentCorrection(a, [WRONG_BROKER]);
      net.pages.set(URL_A, p0);
      const before = net.modelCalls;
      expect((await runRecheck(id)).state).toBe("completed");
      expect(net.modelCalls).toBe(before);
      expect(await result(id)).toMatchObject({ pageState: "previously_seen", result: "needs_review" });
    });

    it("an unreachable page is unreachable, never corrected", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      net.pages.delete(URL_A);
      expect((await runRecheck(id)).state).toBe("completed");
      expect(await result(id)).toMatchObject({ pageState: "unreachable", result: "unreachable", httpStatus: 404, afterSourceArtifactId: null });
      expect((await correctionRow(id)).status).toBe("unreachable");
    });
  });

  // -------------------------------------------------------- changed page

  describe("changed page", () => {
    it("corrected: the error is gone and the page restates the approved fact", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      net.pages.set(URL_A, profilePage([RIGHT_BROKER_TEXT], "after"));
      const before = net.modelCalls;
      expect((await runRecheck(id)).state).toBe("completed");
      // Extraction + the frozen comparison: the only model calls.
      expect(net.modelCalls - before).toBe(2);
      const r = await result(id);
      expect(r).toMatchObject({ pageState: "changed", result: "corrected" });
      expect((r!.resultDetail as { items: { status: string }[] }).items.map((i) => i.status)).toEqual(["corrected"]);
      expect(r!.afterSourceArtifactId).not.toBe(r!.beforeSourceArtifactId);
      expect(r!.evidencePacketId).toEqual(expect.any(String));
      expect((await correctionRow(id)).status).toBe("corrected");
    });

    it("still_incorrect: the same contradiction remains on a changed page", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      net.pages.set(URL_A, profilePage([WRONG_BROKER], "after"));
      expect((await runRecheck(id)).state).toBe("completed");
      expect(await result(id)).toMatchObject({ pageState: "changed", result: "still_incorrect" });
    });

    it("needs_review: the error is gone but nothing restates the approved fact", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      net.pages.set(URL_A, profilePage(["Perez Realty Group serves Jersey City and Hoboken."], "after"));
      expect((await runRecheck(id)).state).toBe("completed");
      expect(await result(id)).toMatchObject({ pageState: "changed", result: "needs_review" });
    });

    it("a comparison failure never becomes corrected: no result is recorded", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      net.pages.set(URL_A, profilePage([RIGHT_BROKER_TEXT], "after"));
      net.compareMode = "invalid";
      const { state } = await runRecheck(id);
      expect(state).toBe("safely_stopped");
      expect(await result(id)).toBeUndefined();
      expect((await correctionRow(id)).status).toBe("sent");
    });
  });

  // ------------------------------------------------------ multiple items

  describe("multiple items", () => {
    it("all corrected → corrected; one still wrong → still_incorrect; corrected + review → needs_review", async () => {
      const cases: [string[], string][] = [
        [[RIGHT_BROKER_TEXT, RIGHT_SALES_TEXT], "corrected"],
        [[RIGHT_BROKER_TEXT, WRONG_SALES], "still_incorrect"],
        [[RIGHT_BROKER_TEXT], "needs_review"],
      ];
      for (const [lines, expected] of cases) {
        await truncateAll(d.sql);
        await seedTestActors(d.sql);
        expect((await automation.bootstrapAutomation()).errors).toEqual([]);
        a = await seedClient(d.sql, "Perez Realty", [URL_A]);
        await d.sql`
          insert into connector_connections (project_id, provider, connection_name, external_account_id, status,
            granted_scopes, config, created_by)
          values (null, 'gmail', 'corrections', 'c@x.example', 'active', '{}', ${d.sql.json({ sendAsAddress: "c@x.example" })}, ${OPERATOR.id})
        `;
        const id = await sentCorrection(a, [WRONG_BROKER, WRONG_SALES]);
        const [corr] = await d.sql`select request from profile_correction_requests where id = ${id}`;
        expect((corr!.request as { items: unknown[] }).items).toHaveLength(2);
        net.pages.set(URL_A, profilePage(lines, `after-${expected}`));
        expect((await runRecheck(id)).state).toBe("completed");
        const r = await result(id);
        expect(r!.result, lines.join(" | ")).toBe(expected);
        const detail = r!.resultDetail as { items: { approvedClaimKey: string }[] };
        expect(detail.items.map((i) => i.approvedClaimKey)).toEqual(["brokerage", "sales.2025.count"]);
      }
    });
  });

  // -------------------------------------------------------- persistence

  describe("persistence", () => {
    it("records one immutable result, idempotently, and leaves the request content unchanged", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      const before = await correctionRow(id);
      const { runId } = await runRecheck(id);
      const r = await result(id);
      expect(r).toMatchObject({
        projectId: a.projectId,
        correctionRequestId: id,
        workflowRunId: runId,
        profileUrl: URL_A,
        requestSha256: before.requestSha256,
        beforeSourceArtifactId: before.beforeSourceArtifactId,
        resultVersion: "profile-recheck-result-v1",
      });
      expect(r!.resultSha256).toMatch(/^[0-9a-f]{64}$/);

      // The request's content is untouched; only its lifecycle moved.
      const after = await correctionRow(id);
      expect(after.request).toEqual(before.request);
      expect(after.requestSha256).toBe(before.requestSha256);
      expect(after).toMatchObject({ status: "still_incorrect", recheckRunId: runId, recheckResultId: r!.id });

      // Immutable.
      await expect(d.sql`update profile_correction_rechecks set result = 'corrected' where id = ${r!.id}`).rejects.toThrow(/forbidden/);
      await expect(d.sql`delete from profile_correction_rechecks where id = ${r!.id}`).rejects.toThrow(/forbidden/);

      // Re-running the classification step, or re-delivering the event, records nothing new.
      const classify = nodes.profileCorrectionNodes["dom.classify_profile_recheck"]!;
      const outputs = await d.sql`select node_key, output from node_runs where workflow_run_id = ${runId}`;
      const byKey = Object.fromEntries(outputs.map((o) => [o.nodeKey as string, o.output]));
      const again = await classify({
        runId,
        projectId: a.projectId,
        nodeKey: "classify",
        fanKey: "",
        attempt: 2,
        inputs: { precheck: byKey.precheck, load_request: byKey.load_request },
        workflowInput: {},
        config: { requestVersion: "profile-correction-request-v1", requestPath: "load_request", precheckPath: "precheck" },
        node: {} as never,
        remainingCostMicroUsd: null,
      });
      expect(again.outcome).toBe("succeeded");
      const [q] = await d.sql`select event_id from profile_check_requests where kind = 'recheck'`;
      await d.autoDispatch.deliverOneEvent(q!.eventId as string);
      expect(await d.sql`select id from profile_correction_rechecks`).toHaveLength(1);
      expect(await d.sql`
        select r.id from workflow_runs r join workflow_versions v on v.id = r.version_id
        join workflow_definitions w on w.id = v.definition_id where w.key = 'reputation_profile_recheck_v1'
      `).toHaveLength(1);

      // Nothing else happened: no new draft, no new correction, no new recheck, no send.
      expect(connector.calls).toEqual(["email.create_draft"]);
      expect(await d.sql`select id from profile_correction_requests`).toHaveLength(1);
      expect(await d.sql`select id from profile_check_requests where kind = 'recheck'`).toHaveLength(1);
      const paid = await d.sql`select id from llm_calls where backend is distinct from 'ollama' or cost_micro_usd <> 0`;
      expect(paid).toHaveLength(0);
    });

    it("frees the profile for a later check once the result is recorded", async () => {
      const id = await sentCorrection(a, [WRONG_BROKER]);
      await runRecheck(id);
      const next = await d.start.startProfileChecks(OPERATOR, { projectId: a.projectId, origin: "operator" }, new Date("2026-10-20T12:00:00Z"));
      expect(next.ok && next.data.queued).toHaveLength(1);
    });
  });
});
