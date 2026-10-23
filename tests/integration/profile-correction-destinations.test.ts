/**
 * Spec 147 slice 3 — correction destinations and routing.
 *
 * Real database, engine, event bus and approval action; the network is a
 * stub (profile pages + local Ollama). Nothing is drafted, sent or submitted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
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
  type Network,
} from "../helpers/profile-correction-fixtures";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
const URL_B = "https://ratings.example.org/teams/perez-realty";
const CLIENT_EMAIL = "maria@perezrealty.example";
const DAY1 = new Date("2026-10-05T12:00:00Z");

const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000801",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

function clientEditor(projectId: string, profileUrl: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    profileUrl,
    kind: "client_editor",
    recipientName: "Maria Perez",
    email: CLIENT_EMAIL,
    basis: "Client confirmed on 2026-10-01 that Maria edits this profile.",
    ...overrides,
  };
}

function publisher(projectId: string, profileUrl: string, overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    profileUrl,
    kind: "publisher",
    recipientName: "Ratings corrections desk",
    email: "corrections@ratings.example.org",
    basis: "Publisher's corrections page names this address.",
    sourceUrl: "https://ratings.example.org/corrections",
    ...overrides,
  };
}

describe.skipIf(!TEST_URL)("profile correction destinations and routing (spec 147 slice 3)", () => {
  let d: Drivers;
  let destinations: typeof import("@/lib/profile-corrections/destinations");
  let routing: typeof import("@/lib/profile-corrections/routing");
  let store: typeof import("@/db/profile-corrections");
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
    routing = await import("@/lib/profile-corrections/routing");
    store = await import("@/db/profile-corrections");
    automation = await import("@/lib/automation/workflows");
  }, 180_000);

  afterAll(async () => {
    await d.sql.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await truncateAll(d.sql);
    await seedTestActors(d.sql);
    expect((await automation.bootstrapAutomation()).errors).toEqual([]);
    a = await seedClient(d.sql, "Perez Realty", [URL_A], { contactEmail: CLIENT_EMAIL, contactName: "Maria Perez" });
    b = await seedClient(d.sql, "Rival Realty", [URL_A]);
    net = stubNetwork();
    net.pages.set(URL_A, profilePage([WRONG_BROKER]));
    net.pages.set(URL_B, profilePage([WRONG_BROKER], "ratings"));
  });

  async function set(input: Record<string, unknown>, user: CurrentUser = OPERATOR) {
    return destinations.setCorrectionDestination(user, input);
  }

  async function correction(runId: string) {
    const [row] = await d.sql`select * from profile_correction_requests where workflow_run_id = ${runId}`;
    return row!;
  }

  /** One client's correction for URL_A, approved, routed with whatever destination exists. */
  async function approvedCorrection(projectId = a.projectId, now = DAY1) {
    const { runId, state } = await checkProfile(d, projectId, now);
    expect(state).toBe("waiting_for_approval");
    expect(await approveCorrection(d, runId)).toBe("completed");
    return runId;
  }

  async function events(type: string) {
    return d.sql`select id, project_id, payload from domain_events where type = ${type} order by occurred_at, id`;
  }

  function noExternalActions() {
    expect(net.calls.filter((u) => !u.endsWith("/api/chat") && u !== URL_A && u !== URL_B)).toEqual([]);
  }

  // ---------------------------------------------------- destination storage

  describe("destination storage", () => {
    it("records a client_editor and a publisher destination", async () => {
      await d.sql`
        insert into engagement_context_items (engagement_id, project_id, kind, label, provenance, source_ref)
        values (${a.engagementId}, ${a.projectId}, 'asset', ${URL_B}, 'client_confirmed', ${URL_B})
      `;
      const editor = await set(clientEditor(a.projectId, URL_A));
      expect(editor.ok && editor.data.destination).toMatchObject({
        kind: "client_editor",
        email: CLIENT_EMAIL,
        archivedAt: null,
        createdBy: OPERATOR.id,
      });
      const pub = await set(publisher(a.projectId, URL_B));
      expect(pub.ok && pub.data.destination).toMatchObject({
        kind: "publisher",
        sourceUrl: "https://ratings.example.org/corrections",
      });
      const audit = await d.sql`select action from audit_log where action = 'profile_correction_destination.set'`;
      expect(audit).toHaveLength(2);
    });

    it("rejects a publisher without a source URL and a malformed email, in code and in the database", async () => {
      const noSource = await set(publisher(a.projectId, URL_B, { sourceUrl: undefined }));
      expect(noSource.ok).toBe(false);
      const badEmail = await set(clientEditor(a.projectId, URL_A, { email: "maria at perezrealty" }));
      expect(badEmail.ok).toBe(false);
      const badSource = await set(publisher(a.projectId, URL_B, { sourceUrl: "ftp://ratings.example.org/x" }));
      expect(badSource.ok).toBe(false);

      await expect(d.sql`
        insert into profile_correction_destinations (project_id, profile_url, kind, recipient_name, email, basis, created_by)
        values (${a.projectId}, ${URL_B}, 'publisher', 'Desk', 'desk@ratings.example.org', 'basis', ${OPERATOR.id})
      `).rejects.toThrow(/publisher_source/);
      await expect(d.sql`
        insert into profile_correction_destinations (project_id, profile_url, kind, recipient_name, email, basis, created_by)
        values (${a.projectId}, ${URL_A}, 'client_editor', 'Maria', 'not-an-email', 'basis', ${OPERATOR.id})
      `).rejects.toThrow(/email_check/);
      expect(await d.sql`select id from profile_correction_destinations`).toHaveLength(0);
    });

    it("keeps one active destination; replacing archives the old row without changing it", async () => {
      const first = await set(clientEditor(a.projectId, URL_A));
      const second = await set(clientEditor(a.projectId, URL_A, { recipientName: "Luis Perez", email: "luis@perezrealty.example" }));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.data.archived).toBe(first.data.destination!.id);

      const rows = await d.sql`select * from profile_correction_destinations order by created_at, id`;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        id: first.data.destination!.id,
        recipientName: "Maria Perez",
        email: CLIENT_EMAIL,
        archivedBy: OPERATOR.id,
        archiveReason: "replaced by a new destination",
      });
      expect(rows[0]!.archivedAt).not.toBeNull();
      expect(rows[1]).toMatchObject({ recipientName: "Luis Perez", archivedAt: null });

      // The database refuses a second active row, any edit, and any delete.
      await expect(d.sql`
        insert into profile_correction_destinations (project_id, profile_url, kind, recipient_name, email, basis, created_by)
        values (${a.projectId}, ${URL_A}, 'client_editor', 'X', 'x@x.example', 'basis', ${OPERATOR.id})
      `).rejects.toThrow(/one_active/);
      await expect(
        d.sql`update profile_correction_destinations set email = 'other@x.example' where id = ${rows[1]!.id}`
      ).rejects.toThrow(/only archiving/);
      await expect(
        d.sql`update profile_correction_destinations set archive_reason = 'rewritten' where id = ${rows[0]!.id}`
      ).rejects.toThrow(/archived rows are immutable/);
      await expect(d.sql`delete from profile_correction_destinations`).rejects.toThrow(/forbidden/);
    });

    it("is tenant-isolated: no foreign URLs, no foreign archives, no client roles", async () => {
      const foreignUrl = await set(clientEditor(a.projectId, "https://elsewhere.example/someone"));
      expect(foreignUrl.ok).toBe(false);
      if (!foreignUrl.ok) expect(foreignUrl.error.kind).toBe("not_found");

      const own = await set(clientEditor(b.projectId, URL_A, { email: "rival@rival.example" }));
      expect(own.ok).toBe(true);
      if (!own.ok) return;
      const foreignArchive = await destinations.archiveCorrectionDestination(OPERATOR, {
        projectId: a.projectId,
        destinationId: own.data.destination!.id,
        reason: "not mine",
      });
      expect(foreignArchive.ok).toBe(false);
      expect((await store.destinationById(d.sql, own.data.destination!.id))!.archivedAt).toBeNull();

      const client = await set(clientEditor(a.projectId, URL_A), clientViewer);
      expect(client.ok).toBe(false);
      // A's active destination lookup never sees B's row for the same URL.
      expect(await store.activeDestination(d.sql, a.projectId, URL_A)).toBeNull();
    });

    it("offers the client contact only as an explicit client_editor prefill, never as a destination", async () => {
      const prefill = await destinations.clientEditorPrefill(OPERATOR, a.projectId);
      expect(prefill.ok && prefill.data).toEqual({ kind: "client_editor", recipientName: "Maria Perez", email: CLIENT_EMAIL });
      // Routing ignores it: with no recorded destination the request waits.
      const runId = await approvedCorrection();
      expect(await correction(runId)).toMatchObject({ status: "destination_required", destinationId: null });
      expect(await d.sql`select id from profile_correction_destinations`).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------- routing

  describe("routing an approved request", () => {
    it("no destination → destination_required, nothing published", async () => {
      const runId = await approvedCorrection();
      const row = await correction(runId);
      expect(row).toMatchObject({ status: "destination_required", destinationId: null });
      expect(row.routedAt).not.toBeNull();
      expect(await events("profile.external_approval_required")).toHaveLength(0);
      noExternalActions();
    });

    it("client_editor → ready_to_draft, with no draft and no external approval", async () => {
      const editor = await set(clientEditor(a.projectId, URL_A));
      expect(editor.ok).toBe(true);
      const runId = await approvedCorrection();
      expect(await correction(runId)).toMatchObject({
        status: "ready_to_draft",
        destinationId: editor.ok ? editor.data.destination!.id : null,
      });
      expect(await events("profile.external_approval_required")).toHaveLength(0);
      const nodes = await d.sql`select node_key from node_runs where workflow_run_id = ${runId}`;
      expect(nodes.map((n) => n.nodeKey)).not.toContain("submit");
      noExternalActions();
    });

    it("publisher → waits for the external-submission approval, bound to hash and destination", async () => {
      const pub = await set(publisher(a.projectId, URL_A));
      if (!pub.ok) throw new Error(pub.error.message);
      const runId = await approvedCorrection();
      const row = await correction(runId);
      expect(row).toMatchObject({ status: "awaiting_external_approval", destinationId: pub.data.destination!.id });

      const published = await events("profile.external_approval_required");
      expect(published).toHaveLength(1);
      expect(published[0]!.payload).toEqual({ correctionRequestId: row.id, destinationId: pub.data.destination!.id });

      await d.autoDispatch.deliverOneEvent(published[0]!.id as string);
      await d.autoDispatch.deliverOneEvent(published[0]!.id as string);
      const authorizeRuns = await d.sql`
        select r.id from workflow_runs r join workflow_versions v on v.id = r.version_id
        join workflow_definitions w on w.id = v.definition_id
        where w.key = 'reputation_profile_correction_authorize_v1'
      `;
      expect(authorizeRuns).toHaveLength(1);
      const authRun = authorizeRuns[0]!.id as string;
      expect(await drive(d, authRun)).toBe("waiting_for_approval");

      // Still not ready: the human gate has not passed.
      expect((await correction(runId)).status).toBe("awaiting_external_approval");
      const [gate] = await d.sql`select id, detail from workflow_approvals where workflow_run_id = ${authRun}`;
      const artifact = (gate!.detail as { output: { artifact: Record<string, unknown> } }).output.artifact;
      expect(artifact).toMatchObject({
        correctionRequestId: row.id,
        requestSha256: row.requestSha256,
        destination: { id: pub.data.destination!.id, kind: "publisher", email: "corrections@ratings.example.org" },
      });

      const decided = await d.approvals.decideApprovalAction({
        approvalId: gate!.id,
        decision: "approved",
        rationale: "Client authorized contacting the publisher.",
      });
      expect(decided.ok).toBe(true);
      expect(await drive(d, authRun)).toBe("completed");
      expect(await correction(runId)).toMatchObject({ status: "ready_to_draft", destinationId: pub.data.destination!.id });
      noExternalActions();
    });

    it("a rejected external submission returns the request to destination_required", async () => {
      await set(publisher(a.projectId, URL_A));
      const runId = await approvedCorrection();
      const [event] = await events("profile.external_approval_required");
      await d.autoDispatch.deliverOneEvent(event!.id as string);
      const [authRun] = await d.sql`select id from workflow_runs where idempotency_key like 'live:profile-external-approval:%'`;
      await drive(d, authRun!.id as string);
      const [gate] = await d.sql`select id from workflow_approvals where workflow_run_id = ${authRun!.id}`;
      const decided = await d.approvals.decideApprovalAction({
        approvalId: gate!.id,
        decision: "rejected",
        rationale: "Client does not want the publisher contacted.",
      });
      expect(decided.ok).toBe(true);
      expect(await correction(runId)).toMatchObject({ status: "destination_required", destinationId: null });
      expect(await drive(d, authRun!.id as string)).toBe("safely_stopped");
      const audit = await d.sql`select action from audit_log where action = 'profile_correction.external_submission_rejected'`;
      expect(audit).toHaveLength(1);
    });

    it("refuses an external-submission approval whose shown destination differs", async () => {
      await set(publisher(a.projectId, URL_A));
      await approvedCorrection();
      const [event] = await events("profile.external_approval_required");
      await d.autoDispatch.deliverOneEvent(event!.id as string);
      const [authRun] = await d.sql`select id from workflow_runs where idempotency_key like 'live:profile-external-approval:%'`;
      await drive(d, authRun!.id as string);
      const [gate] = await d.sql`select id from workflow_approvals where workflow_run_id = ${authRun!.id}`;
      await d.sql`
        update workflow_approvals
        set detail = jsonb_set(detail, '{output,artifact,destination,id}', to_jsonb(gen_random_uuid()::text))
        where id = ${gate!.id}
      `;
      const decided = await d.approvals.decideApprovalAction({
        approvalId: gate!.id,
        decision: "approved",
        rationale: "Approving.",
      });
      expect(decided.ok).toBe(false);
    });

    it("fails closed for a wrong hash or an unapproved request", async () => {
      const runId = await approvedCorrection();
      const row = (await store.correctionForRun(d.sql, runId, a.projectId))!;

      const tampered = await d.sql.begin(async (tx) =>
        routing.routeCorrectionInTx(tx, { ...row, requestSha256: "f".repeat(64) }, null)
      );
      expect(tampered).toMatchObject({ ok: false, error: expect.stringMatching(/no longer hashes/) });

      const unapproved = await d.sql.begin(async (tx) =>
        routing.routeCorrectionInTx(tx, { ...row, approvalId: null }, null)
      );
      expect(unapproved).toMatchObject({ ok: false, error: expect.stringMatching(/no recorded approval/) });

      // The run's route step refuses a request that is not in `approved`.
      const nodes = await import("@/lib/automation/nodes/profile-correction");
      const routeNode = nodes.profileCorrectionNodes["dom.route_profile_correction"]!;
      const result = await routeNode({
        runId,
        projectId: a.projectId,
        nodeKey: "route_correction",
        fanKey: "",
        attempt: 2,
        inputs: {},
        workflowInput: {},
        config: { requestVersion: "profile-correction-request-v1" },
        node: {} as never,
        remainingCostMicroUsd: null,
      });
      expect(result).toMatchObject({ outcome: "failed_terminal", error: expect.stringMatching(/not approved/) });
      expect((await correction(runId)).status).toBe("destination_required");
    });

    it("ignores an archived destination and refuses a cross-project one at the database", async () => {
      const editor = await set(clientEditor(a.projectId, URL_A));
      if (!editor.ok) throw new Error(editor.error.message);
      const archived = await destinations.archiveCorrectionDestination(OPERATOR, {
        projectId: a.projectId,
        destinationId: editor.data.destination!.id,
        reason: "Maria left the team.",
      });
      expect(archived.ok).toBe(true);
      const runId = await approvedCorrection();
      expect(await correction(runId)).toMatchObject({ status: "destination_required", destinationId: null });

      const foreign = await set(clientEditor(b.projectId, URL_A, { email: "rival@rival.example" }));
      if (!foreign.ok) throw new Error(foreign.error.message);
      const row = await correction(runId);
      await expect(
        d.sql`update profile_correction_requests set destination_id = ${foreign.data.destination!.id} where id = ${row.id}`
      ).rejects.toThrow(/not an active destination for this project/);
    });
  });

  // ------------------------------------------------------- late resolution

  describe("late destination resolution", () => {
    it("setting a destination wakes the waiting request in the same transaction", async () => {
      const runId = await approvedCorrection();
      expect((await correction(runId)).status).toBe("destination_required");

      const editor = await set(clientEditor(a.projectId, URL_A));
      if (!editor.ok) throw new Error(editor.error.message);
      expect(editor.data.routed).toEqual([
        expect.objectContaining({ ok: true, from: "destination_required", status: "ready_to_draft", changed: true }),
      ]);
      expect(await correction(runId)).toMatchObject({ status: "ready_to_draft", destinationId: editor.data.destination!.id });
    });

    it("handles each waiting profile deterministically and leaves other profiles and clients alone", async () => {
      await d.sql`
        insert into engagement_context_items (engagement_id, project_id, kind, label, provenance, source_ref)
        values (${a.engagementId}, ${a.projectId}, 'asset', ${URL_B}, 'client_confirmed', ${URL_B})
      `;
      const runA = await approvedCorrection(a.projectId, DAY1);
      const runB = await approvedCorrection(a.projectId, new Date("2026-10-06T12:00:00Z"));
      const runOther = await approvedCorrection(b.projectId, DAY1);
      const urls = [(await correction(runA)).profileUrl, (await correction(runB)).profileUrl].sort();
      expect(urls).toEqual([URL_B, URL_A].sort());

      const pub = await set(publisher(a.projectId, URL_B));
      if (!pub.ok) throw new Error(pub.error.message);
      expect(pub.data.routed).toHaveLength(1);

      const byUrl = async (runId: string) => correction(runId);
      const rowA = await byUrl(runA);
      const rowB = await byUrl(runB);
      const onB = rowA.profileUrl === URL_B ? rowA : rowB;
      const onA = rowA.profileUrl === URL_B ? rowB : rowA;
      expect(onB.status).toBe("awaiting_external_approval");
      expect(onA.status).toBe("destination_required");
      expect((await correction(runOther)).status).toBe("destination_required");
    });

    it("suppresses duplicate continuation events and re-routes a replaced publisher", async () => {
      const runId = await approvedCorrection();
      const first = await set(publisher(a.projectId, URL_A));
      if (!first.ok) throw new Error(first.error.message);
      expect(await events("profile.external_approval_required")).toHaveLength(1);

      // Routing the same request to the same destination again is a no-op.
      const again = await d.sql.begin(async (tx) => {
        await store.lockProfileDestination(tx, a.projectId, URL_A);
        const row = (await store.lockCorrection(tx, (await correction(runId)).id as string, a.projectId))!;
        return routing.routeCorrectionInTx(tx, row, OPERATOR.id);
      });
      expect(again).toMatchObject({ ok: true, changed: false, eventId: null });
      expect(await events("profile.external_approval_required")).toHaveLength(1);

      // The old authorization run, started before the publisher changed, can no longer complete.
      const [oldEvent] = await events("profile.external_approval_required");
      await d.autoDispatch.deliverOneEvent(oldEvent!.id as string);
      const [oldRun] = await d.sql`select id from workflow_runs where idempotency_key like 'live:profile-external-approval:%'`;
      expect(await drive(d, oldRun!.id as string)).toBe("waiting_for_approval");

      const replaced = await set(publisher(a.projectId, URL_A, { email: "desk2@ratings.example.org" }));
      if (!replaced.ok) throw new Error(replaced.error.message);
      const published = await events("profile.external_approval_required");
      expect(published).toHaveLength(2);
      expect(published[1]!.payload).toMatchObject({ destinationId: replaced.data.destination!.id });
      expect(await correction(runId)).toMatchObject({
        status: "awaiting_external_approval",
        destinationId: replaced.data.destination!.id,
      });

      const [oldGate] = await d.sql`select id from workflow_approvals where workflow_run_id = ${oldRun!.id}`;
      const decided = await d.approvals.decideApprovalAction({
        approvalId: oldGate!.id,
        decision: "approved",
        rationale: "Approving the old publisher.",
      });
      // The old approval is bound to the old publisher: it cannot be recorded.
      expect(decided.ok).toBe(false);
      if (!decided.ok) expect(decided.error.message).toMatch(/routed to/);
      const [stillOpen] = await d.sql`select decision from workflow_approvals where id = ${oldGate!.id}`;
      expect(stillOpen!.decision).toBeNull();
      expect((await correction(runId)).status).toBe("awaiting_external_approval");
    });

    it("archiving a destination sends a ready request back to destination_required", async () => {
      const editor = await set(clientEditor(a.projectId, URL_A));
      if (!editor.ok) throw new Error(editor.error.message);
      const runId = await approvedCorrection();
      expect((await correction(runId)).status).toBe("ready_to_draft");
      const archived = await destinations.archiveCorrectionDestination(OPERATOR, {
        projectId: a.projectId,
        destinationId: editor.data.destination!.id,
        reason: "Wrong person.",
      });
      expect(archived.ok && archived.data.routed).toEqual([
        expect.objectContaining({ from: "ready_to_draft", status: "destination_required" }),
      ]);
      expect(await correction(runId)).toMatchObject({ status: "destination_required", destinationId: null });
    });
  });

  it("makes no paid model call and contacts nothing external", async () => {
    await set(publisher(a.projectId, URL_A));
    await approvedCorrection();
    const paid = await d.sql`select id from llm_calls where backend is distinct from 'ollama' or cost_micro_usd <> 0`;
    expect(paid).toHaveLength(0);
    expect(await d.sql`select id from connector_connections`).toHaveLength(0);
    noExternalActions();
  });
});
