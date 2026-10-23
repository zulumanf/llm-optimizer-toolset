/**
 * Spec 147 slice 2 — a found contradiction becomes a deterministic, persisted
 * correction request that waits at the human approval gate, bound to its hash.
 *
 * Real test database and the real engine, event bus and approval action. The
 * network is a stubbed global fetch: the profile page, and the local Ollama
 * endpoint for extraction (gpt-oss) and comparison (qwen3:30b). Nothing else
 * is reachable, and nothing external happens.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

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

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const PROFILE_URL = "https://directory.example.com/agents/perez-realty";
const WRONG_BROKER = "Perez Realty Group is a Compass team in Jersey City.";
const WRONG_SALES = "Perez Realty Group closed 40 homes in 2025.";
const RIGHT_BROKER_TEXT = "Perez Realty Group is affiliated with Douglas Elliman.";
const RIGHT_SALES_TEXT = "Perez Realty Group closed 42 homes in 2025.";
const MODEL_PROSE = "Model explanation: the brokerage differs.";

function page(lines: string[], marker = ""): string {
  return `<html><head><title>Perez Realty Group</title></head><body>${lines
    .map((l) => `<p>${l}</p>`)
    .join("")}${marker ? `<!-- ${marker} -->` : ""}</body></html>`;
}

function draft(wording: string, normalized: string, category: string) {
  return {
    subject: "Perez Realty Group",
    predicate: "states",
    object: "",
    originalWording: wording,
    normalizedWording: normalized,
    category,
    asOf: null,
    value: null,
    confidence: 0.9,
    locator: "",
  };
}

const EXTRACTABLE: Record<string, ReturnType<typeof draft>> = {
  [WRONG_BROKER]: draft(WRONG_BROKER, "Perez Realty Group is affiliated with Compass.", "affiliation"),
  [WRONG_SALES]: draft(WRONG_SALES, "Perez Realty Group closed 40 homes in 2025.", "transaction"),
  [RIGHT_BROKER_TEXT]: draft(RIGHT_BROKER_TEXT, RIGHT_BROKER_TEXT, "affiliation"),
};

describe.skipIf(!TEST_URL)("profile correction requests (spec 147 slice 2)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let start: typeof import("@/lib/profile-corrections/start");
  let dispatch: typeof import("@/lib/profile-corrections/dispatch");
  let automation: typeof import("@/lib/automation/workflows");
  let autoDispatch: typeof import("@/lib/automation/dispatch");
  let engine: typeof import("@/lib/workflow/engine");
  let approvals: typeof import("@/app/workflows/actions");
  let corrections: typeof import("@/lib/profile-corrections/approval");
  let store: typeof import("@/db/profile-corrections");

  let projectId = "";
  let engagementId = "";
  let otherProjectId = "";
  let evidence: string[] = [];
  let currentPage = "";
  let fetchCalls: string[] = [];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    start = await import("@/lib/profile-corrections/start");
    dispatch = await import("@/lib/profile-corrections/dispatch");
    automation = await import("@/lib/automation/workflows");
    autoDispatch = await import("@/lib/automation/dispatch");
    engine = await import("@/lib/workflow/engine");
    approvals = await import("@/app/workflows/actions");
    corrections = await import("@/lib/profile-corrections/approval");
    store = await import("@/db/profile-corrections");
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS;
  });

  beforeEach(async () => {
    await truncateAll(sql);
    await seedTestActors(sql);
    expect((await automation.bootstrapAutomation()).errors).toEqual([]);

    const [market] = await sql`insert into markets (name, kind) values ('Jersey City', 'city') returning id`;
    const [company] = await sql`
      insert into companies (name, aliases, domain, is_self)
      values ('Perez Realty Group', ${[]}, null, true) returning id
    `;
    const [project] = await sql`
      insert into projects (name, subject_company_id) values ('Perez Realty', ${company!.id}) returning id
    `;
    projectId = project!.id as string;
    const [other] = await sql`insert into projects (name) values ('Rival Realty') returning id`;
    otherProjectId = other!.id as string;
    const [engagement] = await sql`
      insert into client_engagements (project_id, market_id, starts_on, ends_on, renewal_review_on,
        monthly_fee_usd, total_value_usd, stage)
      values (${projectId}, ${market!.id}, '2026-10-01', '2026-12-31', '2026-12-01', 1000, 3000, 'active')
      returning id
    `;
    engagementId = engagement!.id as string;
    await sql`
      insert into engagement_context_items (engagement_id, project_id, kind, label, provenance, source_ref)
      values (${engagementId}, ${projectId}, 'asset', ${PROFILE_URL}, 'client_confirmed', ${PROFILE_URL})
    `;

    evidence = [];
    for (const note of ["Brokerage license record", "2025 MLS closed-sales export", "Agent roster"]) {
      const [row] = await sql`
        insert into evidence (kind, ref_id, note) values ('source', gen_random_uuid(), ${note}) returning id
      `;
      evidence.push(row!.id as string);
    }
    await sql`
      insert into claims (project_id, key, canonical_text, status, evidence_ids)
      values
        (${projectId}, 'brokerage', ${RIGHT_BROKER_TEXT}, 'approved', ${[evidence[0]!, evidence[2]!]}::uuid[]),
        (${projectId}, 'sales.2025.count', ${RIGHT_SALES_TEXT}, 'approved', ${[evidence[1]!]}::uuid[])
    `;
  });

  // ------------------------------------------------------------- network

  function stubNetwork() {
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push(url);
        if (url.endsWith("/api/chat")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            model?: string;
            messages?: { role: string; content: string }[];
          };
          const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
          const content = body.model === "qwen3:30b" ? compareAnswer(user) : extractAnswer();
          return new Response(
            JSON.stringify({ message: { role: "assistant", content }, prompt_eval_count: 10, eval_count: 5 }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url === PROFILE_URL) {
          return new Response(currentPage, { status: 200, headers: { "content-type": "text/html" } });
        }
        return new Response("not found", { status: 404 });
      })
    );
  }

  /** Extraction proposes exactly the extractable sentences on the current page. */
  function extractAnswer(): string {
    const claims = Object.entries(EXTRACTABLE)
      .filter(([sentence]) => currentPage.includes(sentence))
      .map(([, claim]) => claim);
    return JSON.stringify({ claims });
  }

  /** Comparison pairs wrong brokerage/sales observations with their approved facts. */
  function compareAnswer(user: string): string {
    const payload = JSON.parse(user.slice(user.indexOf("{"))) as {
      context: {
        observedClaims: { claimId: string; normalizedWording: string }[];
        approvedFacts: { claims: { id: string; key: string; text: string }[] };
      };
    };
    const approved = (key: string) => payload.context.approvedFacts.claims.find((c) => c.key === key)!;
    const contradictions = payload.context.observedClaims.flatMap((o) => {
      if (o.normalizedWording.includes("Compass")) {
        const a = approved("brokerage");
        return [{ observedClaimId: o.claimId, approvedClaimId: a.id, statementA: o.normalizedWording, statementB: a.text, severity: "critical", explanation: MODEL_PROSE }];
      }
      if (o.normalizedWording.includes("40 homes")) {
        const a = approved("sales.2025.count");
        return [{ observedClaimId: o.claimId, approvedClaimId: a.id, statementA: o.normalizedWording, statementB: a.text, severity: "high", explanation: MODEL_PROSE }];
      }
      return [];
    });
    return JSON.stringify({ contradictions, confidence: 0.93 });
  }

  // ------------------------------------------------------------ drivers

  const PARKED_OR_DONE = [
    "waiting_for_approval",
    "completed",
    "failed",
    "cancelled",
    "safely_stopped",
    "timed_out",
    "partially_completed",
  ];

  async function drive(runId: string): Promise<string> {
    let state = "";
    for (let i = 0; i < 25; i += 1) {
      state = await engine.advanceWorkflow(runId);
      if (PARKED_OR_DONE.includes(state)) break;
    }
    return state;
  }

  /** Queue → release → deliver → run, up to the approval gate (or an end). */
  async function checkProfile(now: Date): Promise<{ runId: string; state: string }> {
    const queued = await start.startProfileChecks(operator, { projectId, origin: "operator" }, now);
    expect(queued.ok && queued.data.queued).toHaveLength(1);
    const report = await dispatch.dispatchProfileChecks();
    expect(report.released).toHaveLength(1);
    const [row] = await sql`select * from profile_check_requests where id = ${report.released[0]!}`;
    await autoDispatch.deliverOneEvent(row!.eventId as string);
    const [run] = await sql`select id from workflow_runs where idempotency_key = ${row!.runIdempotencyKey}`;
    const runId = run!.id as string;
    return { runId, state: await drive(runId) };
  }

  async function approvalFor(runId: string) {
    const [row] = await sql`select id, decision, detail from workflow_approvals where workflow_run_id = ${runId}`;
    return row!;
  }

  async function correctionFor(runId: string) {
    const [row] = await sql`select * from profile_correction_requests where workflow_run_id = ${runId}`;
    return row;
  }

  const DAY1 = new Date("2026-10-05T12:00:00Z");
  const DAY2 = new Date("2026-10-06T12:00:00Z");
  const DAY3 = new Date("2026-10-07T12:00:00Z");

  // -------------------------------------------------------------- tests

  it("builds, verifies and records one deterministic request, then waits for a human", async () => {
    currentPage = page([WRONG_SALES, WRONG_BROKER]);
    stubNetwork();
    const { runId, state } = await checkProfile(DAY1);
    expect(state).toBe("waiting_for_approval");

    const row = await correctionFor(runId);
    expect(row).toMatchObject({
      projectId,
      profileUrl: PROFILE_URL,
      status: "awaiting_approval",
      requestVersion: "profile-correction-request-v1",
      itemCount: 2,
      maxSeverity: "critical",
    });
    const request = row!.request as {
      items: { pageWording: string; approvedStatement: string; severity: string; evidenceIds: string[] }[];
      evidenceIds: string[];
    };
    expect(request.items.map((i) => [i.severity, i.pageWording, i.approvedStatement])).toEqual([
      ["critical", WRONG_BROKER, RIGHT_BROKER_TEXT],
      ["high", WRONG_SALES, RIGHT_SALES_TEXT],
    ]);
    expect(request.items[0]!.evidenceIds).toEqual([evidence[0]!, evidence[2]!].sort());
    expect(JSON.stringify(request)).not.toContain(MODEL_PROSE);

    // What the operator approves: the exact request, its hash and version,
    // with the evidence ids attached to the approval row.
    const approval = await approvalFor(runId);
    const artifact = (approval.detail as { output: { artifact: Record<string, unknown> } }).output.artifact;
    expect(artifact).toMatchObject({
      requestVersion: "profile-correction-request-v1",
      requestSha256: row!.requestSha256,
      correctionRequestId: row!.id,
    });
    expect(artifact.request).toEqual(row!.request);
    const [evidenceIds] = await sql`select evidence_ids from workflow_approvals where id = ${approval.id}`;
    expect([...(evidenceIds!.evidenceIds as string[])].sort()).toEqual([...evidence].sort());

    // Nothing external has happened: only the page and the local model were
    // contacted, every model call was local and free, nothing was drafted.
    expect(fetchCalls.filter((u) => u !== PROFILE_URL && !u.endsWith("/api/chat"))).toEqual([]);
    const paid = await sql`select id from llm_calls where backend is distinct from 'ollama' or cost_micro_usd <> 0`;
    expect(paid).toHaveLength(0);
    const compareCalls = await sql`select model from llm_calls where agent_version = 'detect-contradictions-v2'`;
    expect(compareCalls.map((c) => c.model)).toEqual(["qwen3:30b"]);
    expect(await sql`select id from connector_connections`).toHaveLength(0);
    expect(await sql`select id from jobs where type like 'email%' or type like '%send%'`).toHaveLength(0);
    const nodes = await sql`select node_key from node_runs where workflow_run_id = ${runId}`;
    expect(nodes.map((n) => n.nodeKey)).not.toContain("submit");
  });

  it("binds an approval to the request hash and records it after re-proving the facts", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const { runId } = await checkProfile(DAY1);
    const approval = await approvalFor(runId);

    const decided = await approvals.decideApprovalAction({
      approvalId: approval.id,
      decision: "approved",
      rationale: "Checked the license record and the page.",
    });
    expect(decided.ok).toBe(true);
    expect(await drive(runId)).toBe("completed");

    // Approved, then routed (slice 3): with no recorded destination it waits.
    const row = await correctionFor(runId);
    expect(row).toMatchObject({ status: "destination_required", approvalId: approval.id, destinationId: null });
    expect(row!.decidedBy).toBe("00000000-0000-4000-8000-000000000001");
    const audit = await sql`
      select action from audit_log where entity = 'profile_correction_request' and entity_id = ${row!.id}
      order by at
    `;
    expect(audit.map((a) => a.action)).toEqual([
      "profile_correction.awaiting_approval",
      "profile_correction.approved",
      "profile_correction.destination_required",
    ]);
  });

  it("refuses to record an approval for a request other than the stored one", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const { runId } = await checkProfile(DAY1);
    const approval = await approvalFor(runId);
    // The shown artifact is edited after it was built: the old hash no longer applies.
    await sql`
      update workflow_approvals
      set detail = jsonb_set(detail, '{output,artifact,request,items,0,approvedStatement}', '"Perez Realty Group is affiliated with Corcoran."')
      where id = ${approval.id}
    `;
    const decided = await approvals.decideApprovalAction({
      approvalId: approval.id,
      decision: "approved",
      rationale: "Looks right to me.",
    });
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error.message).toMatch(/does not match the hash/);
    expect((await approvalFor(runId)).decision).toBeNull();
    expect((await correctionFor(runId))!.status).toBe("awaiting_approval");
  });

  it("keeps the stored request immutable and undeletable", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const { runId } = await checkProfile(DAY1);
    const row = await correctionFor(runId);
    await expect(
      sql`update profile_correction_requests set request = '{}'::jsonb where id = ${row!.id}`
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`update profile_correction_requests set request_sha256 = ${"b".repeat(64)} where id = ${row!.id}`
    ).rejects.toThrow(/immutable/);
    await expect(sql`delete from profile_correction_requests where id = ${row!.id}`).rejects.toThrow(/forbidden/);
  });

  it("fails closed and frees the profile when a fact changes before approval", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const { runId } = await checkProfile(DAY1);
    await sql`update claims set evidence_ids = ${[evidence[0]!]}::uuid[] where key = 'brokerage'`;

    const decided = await approvals.decideApprovalAction({
      approvalId: (await approvalFor(runId)).id,
      decision: "approved",
      rationale: "Approving the correction.",
    });
    expect(decided.ok).toBe(true);
    expect(await drive(runId)).not.toBe("completed");
    const row = await correctionFor(runId);
    expect(row!.status).toBe("expired");
    expect(String(row!.closedReason)).toMatch(/approved_facts_changed_before_approval: .*evidence_mismatch/);
  });

  it("persists a rejection with the decision and lets a later check correct the profile", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const first = await checkProfile(DAY1);
    const approval = await approvalFor(first.runId);
    const decided = await approvals.decideApprovalAction({
      approvalId: approval.id,
      decision: "rejected",
      rationale: "The client is moving brokerages next week.",
    });
    expect(decided.ok).toBe(true);
    const rejected = await correctionFor(first.runId);
    expect(rejected).toMatchObject({
      status: "rejected",
      approvalId: approval.id,
      decisionRationale: "The client is moving brokerages next week.",
    });
    expect(await drive(first.runId)).toBe("safely_stopped");

    // The profile is free again: a later check (the page changed) builds a new request.
    currentPage = page([WRONG_BROKER], "revised");
    const second = await checkProfile(DAY2);
    expect(second.state).toBe("waiting_for_approval");
    expect((await correctionFor(second.runId))!.status).toBe("awaiting_approval");
    expect(await sql`select id from profile_correction_requests`).toHaveLength(2);
  });

  it("lets an operator withdraw a pending request, which frees the profile", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const { runId } = await checkProfile(DAY1);
    const row = await correctionFor(runId);

    // While it is open, the profile is not queued again.
    const blocked = await start.startProfileChecks(operator, { projectId, origin: "operator" }, DAY2);
    expect(blocked.ok && blocked.data.skipped.map((s) => s.reason)).toEqual(["open_correction"]);

    const withdrawn = await corrections.withdrawCorrectionRequest(operator, {
      projectId,
      correctionRequestId: row!.id,
      reason: "Client updated the page themselves.",
    });
    expect(withdrawn.ok).toBe(true);
    expect((await correctionFor(runId))!).toMatchObject({ status: "withdrawn", closedBy: operator.id });

    const again = await start.startProfileChecks(operator, { projectId, origin: "operator" }, DAY3);
    expect(again.ok && again.data.queued).toHaveLength(1);

    // Another project's operator path cannot reach it.
    const foreign = await corrections.withdrawCorrectionRequest(operator, {
      projectId: otherProjectId,
      correctionRequestId: row!.id,
      reason: "Wrong client.",
    });
    expect(foreign.ok).toBe(false);
  });

  it("never opens a second request for the same profile, even from a concurrent run", async () => {
    process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS = "2";
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    // Two checks released before either reached its correction.
    for (const now of [DAY1, DAY2]) {
      const r = await start.startProfileChecks(operator, { projectId, origin: "operator" }, now);
      expect(r.ok && r.data.queued).toHaveLength(1);
    }
    const report = await dispatch.dispatchProfileChecks();
    expect(report.released).toHaveLength(2);
    const runIds: string[] = [];
    for (const id of report.released) {
      const [q] = await sql`select * from profile_check_requests where id = ${id}`;
      await autoDispatch.deliverOneEvent(q!.eventId as string);
      const [run] = await sql`select id from workflow_runs where idempotency_key = ${q!.runIdempotencyKey}`;
      runIds.push(run!.id as string);
    }
    // The second run sees the same bytes; give it a distinct page so it compares.
    expect(await drive(runIds[0]!)).toBe("waiting_for_approval");
    currentPage = page([WRONG_BROKER], "second fetch");
    expect(await drive(runIds[1]!)).toBe("safely_stopped");

    const rows = await sql`select workflow_run_id, status from profile_correction_requests`;
    expect(rows).toEqual([{ workflowRunId: runIds[0], status: "awaiting_approval" }]);
    const [verify] = await sql`
      select output from node_runs where workflow_run_id = ${runIds[1]!} and node_key = 'verify_correction'
    `;
    expect(verify!.output).toMatchObject({ duplicateOf: { workflowRunId: runIds[0], status: "awaiting_approval" } });
  });

  it("decides a true insert race at the database: exactly one open request", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const { runId } = await checkProfile(DAY1);
    const original = await correctionFor(runId);
    await corrections.withdrawCorrectionRequest(operator, {
      projectId,
      correctionRequestId: original!.id,
      reason: "Clearing for the race test.",
    });
    const versionId = (await sql`select version_id from workflow_runs where id = ${runId}`)[0]!.versionId;
    const racers: string[] = [];
    for (const key of ["race-a", "race-b", "race-c"]) {
      const [run] = await sql`
        insert into workflow_runs (version_id, project_id, idempotency_key, state)
        values (${versionId}, ${projectId}, ${key}, 'running') returning id
      `;
      racers.push(run!.id as string);
    }
    const results = await Promise.all(
      racers.map((workflowRunId) =>
        sql.begin((tx) =>
          store.insertCorrectionRequest(tx, {
            projectId,
            workflowRunId,
            checkRequestId: null,
            contextItemId: null,
            profileUrl: PROFILE_URL,
            requestVersion: original!.requestVersion as string,
            request: original!.request as Record<string, unknown>,
            requestSha256: original!.requestSha256 as string,
            beforeSourceArtifactId: original!.beforeSourceArtifactId as string,
            beforeSha256: original!.beforeSha256 as string,
            evidencePacketId: original!.evidencePacketId as string,
            itemCount: original!.itemCount as number,
            maxSeverity: original!.maxSeverity as string,
            createdBy: null,
          })
        )
      )
    );
    expect(results.filter((r) => "created" in r)).toHaveLength(1);
    expect(results.filter((r) => "existing" in r)).toHaveLength(2);
    const open = await sql`select id from profile_correction_requests where status = 'awaiting_approval'`;
    expect(open).toHaveLength(1);
  });

  it("creates no correction request for a clean profile", async () => {
    currentPage = page([RIGHT_BROKER_TEXT]);
    stubNetwork();
    const { runId, state } = await checkProfile(DAY1);
    expect(state).toBe("completed");
    expect(await sql`select id from profile_correction_requests`).toHaveLength(0);
    const nodes = await sql`select node_key from node_runs where workflow_run_id = ${runId}`;
    expect(nodes.map((n) => n.nodeKey)).toContain("no_error");
    expect(nodes.map((n) => n.nodeKey)).not.toContain("build_correction");
  });

  it("refuses at the database a request that points at another client's run or page", async () => {
    currentPage = page([WRONG_BROKER]);
    stubNetwork();
    const { runId } = await checkProfile(DAY1);
    const row = await correctionFor(runId);
    await expect(
      sql.begin((tx) =>
        store.insertCorrectionRequest(tx, {
          projectId: otherProjectId,
          workflowRunId: runId,
          checkRequestId: null,
          contextItemId: null,
          profileUrl: PROFILE_URL,
          requestVersion: row!.requestVersion as string,
          request: row!.request as Record<string, unknown>,
          requestSha256: row!.requestSha256 as string,
          beforeSourceArtifactId: row!.beforeSourceArtifactId as string,
          beforeSha256: row!.beforeSha256 as string,
          evidencePacketId: row!.evidencePacketId as string,
          itemCount: 1,
          maxSeverity: "critical",
          createdBy: null,
        })
      )
    ).rejects.toThrow(/not in project/);
  });
});
