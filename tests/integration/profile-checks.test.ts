/**
 * Spec 147 slice 1 — confirmed profile URLs enter the profile-correction
 * workflow through a durable queue and a bounded dispatcher, and the run
 * fetches the public page with no connector before the unchanged canonical
 * extraction. Real test database; the network (profile pages and the local
 * Ollama endpoint) is a stubbed global fetch, so no model or site is called.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000801",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

const PROFILE_HTML = `<html><head><title>Ana Perez | Agent profile</title></head><body>
<h1>Ana Perez</h1><p>Ana Perez is an agent with Perez Realty Group in Jersey City.</p>
</body></html>`;

describe.skipIf(!TEST_URL)("profile checks: queue, dispatcher, public fetch (spec 147 slice 1)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let urls: typeof import("@/lib/profile-corrections/urls");
  let start: typeof import("@/lib/profile-corrections/start");
  let dispatch: typeof import("@/lib/profile-corrections/dispatch");
  let constants: typeof import("@/lib/profile-corrections/constants");
  let automation: typeof import("@/lib/automation/workflows");
  let autoDispatch: typeof import("@/lib/automation/dispatch");
  let engine: typeof import("@/lib/workflow/engine");
  let authority: typeof import("@/lib/automation/workflows/authority");

  let marketId = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    urls = await import("@/lib/profile-corrections/urls");
    start = await import("@/lib/profile-corrections/start");
    dispatch = await import("@/lib/profile-corrections/dispatch");
    constants = await import("@/lib/profile-corrections/constants");
    automation = await import("@/lib/automation/workflows");
    autoDispatch = await import("@/lib/automation/dispatch");
    engine = await import("@/lib/workflow/engine");
    authority = await import("@/lib/automation/workflows/authority");
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    delete process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS;
    await truncateAll(sql);
    await seedTestActors(sql);
    // Definitions + event subscriptions, as the worker's bootstrap installs them.
    const boot = await automation.bootstrapAutomation();
    expect(boot.errors).toEqual([]);
    const [m] = await sql`insert into markets (name, kind) values ('Jersey City', 'city') returning id`;
    marketId = m!.id as string;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS;
  });

  // ------------------------------------------------------------ fixtures

  async function client(
    name: string,
    opts: { stage?: string; approvedFacts?: boolean; subject?: string } = {}
  ): Promise<{ projectId: string; engagementId: string }> {
    const [p] = await sql`insert into projects (name) values (${name}) returning id`;
    const projectId = p!.id as string;
    const [e] = await sql`
      insert into client_engagements (project_id, market_id, starts_on, ends_on, renewal_review_on,
        monthly_fee_usd, total_value_usd, stage)
      values (${projectId}, ${marketId}, '2026-10-01', '2026-12-31', '2026-12-01', 1000, 3000,
        ${opts.stage ?? "active"})
      returning id
    `;
    if (opts.approvedFacts !== false) {
      await sql`
        insert into claims (project_id, key, canonical_text, status)
        values (${projectId}, 'brokerage', ${`${name} is affiliated with Perez Realty Group.`}, 'approved')
      `;
    }
    if (opts.subject) {
      const [c] = await sql`
        insert into companies (name, aliases, domain, is_self)
        values (${opts.subject}, ${[]}, ${null}, true) returning id
      `;
      await sql`update projects set subject_company_id = ${c!.id} where id = ${projectId}`;
    }
    return { projectId, engagementId: e!.id as string };
  }

  async function asset(
    c: { projectId: string; engagementId: string },
    sourceRef: string | null,
    opts: { kind?: string; provenance?: string; at?: string } = {}
  ): Promise<string> {
    const [row] = await sql`
      insert into engagement_context_items (engagement_id, project_id, kind, label, provenance, source_ref, created_at)
      values (${c.engagementId}, ${c.projectId}, ${opts.kind ?? "asset"}, ${sourceRef ?? "no url"},
        ${opts.provenance ?? "client_confirmed"}, ${sourceRef}, ${opts.at ?? new Date().toISOString()})
      returning id
    `;
    return row!.id as string;
  }

  async function queueRows(projectId?: string) {
    return projectId
      ? sql`select * from profile_check_requests where project_id = ${projectId} order by created_at, id`
      : sql`select * from profile_check_requests order by created_at, id`;
  }

  async function profileVersionId(): Promise<string> {
    const [row] = await sql`
      select v.id from workflow_versions v join workflow_definitions d on d.id = v.definition_id
      where d.key = ${authority.PROFILE_CORRECTION_KEY} order by v.version desc limit 1
    `;
    return row!.id as string;
  }

  async function seedRun(idempotencyKey: string, state: string, projectId: string | null = null) {
    await sql`
      insert into workflow_runs (version_id, project_id, idempotency_key, state)
      values (${await profileVersionId()}, ${projectId}, ${idempotencyKey}, ${state})
    `;
  }

  // ---------------------------------------------------------- URL source

  describe("confirmed profile URL source", () => {
    it("reads only this project's live, client-confirmed asset URLs", async () => {
      const a = await client("Perez Realty");
      const b = await client("Rival Realty");
      const closed = await client("Former Client", { stage: "completed" });

      const zillow = await asset(a, "https://www.zillow.com/profile/ana-perez", { at: "2026-10-01T00:00:00Z" });
      const site = await asset(a, "https://perezrealty.example/", { at: "2026-10-01T00:00:01Z" });
      await asset(a, "https://priority.example/", { kind: "priority_area" });
      await asset(a, "https://observed.example/", { provenance: "publicly_observed" });
      await asset(b, "https://rival.example/agent");
      await asset(closed, "https://former.example/agent");

      const result = await urls.listConfirmedProfileUrls(a.projectId);
      expect(result.urls).toEqual([
        { contextItemId: zillow, profileUrl: "https://www.zillow.com/profile/ana-perez" },
        { contextItemId: site, profileUrl: "https://perezrealty.example/" },
      ]);
      expect(result.skipped).toEqual([]);

      expect((await urls.listConfirmedProfileUrls(b.projectId)).urls.map((u) => u.profileUrl)).toEqual([
        "https://rival.example/agent",
      ]);
      // A closed engagement's assets are not checked.
      expect((await urls.listConfirmedProfileUrls(closed.projectId)).urls).toEqual([]);
    });

    it("skips invalid and non-http rows, removes duplicates and caps at 25", async () => {
      const a = await client("Perez Realty");
      const first = await asset(a, "https://www.zillow.com/profile/ana", { at: "2026-10-01T00:00:00Z" });
      const dup = await asset(a, "https://WWW.ZILLOW.com/profile/ana", { at: "2026-10-01T00:00:01Z" });
      const ftp = await asset(a, "ftp://files.example/profile", { at: "2026-10-01T00:00:02Z" });
      const junk = await asset(a, "not a url", { at: "2026-10-01T00:00:03Z" });
      const none = await asset(a, null, { at: "2026-10-01T00:00:04Z" });
      for (let i = 0; i < 26; i += 1) {
        await asset(a, `https://directory.example/agent/${i}`, {
          at: new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString(),
        });
      }

      const result = await urls.listConfirmedProfileUrls(a.projectId);
      expect(result.urls).toHaveLength(25);
      expect(result.urls[0]).toEqual({ contextItemId: first, profileUrl: "https://www.zillow.com/profile/ana" });
      const reasons = Object.fromEntries(result.skipped.map((s) => [s.contextItemId, s.reason]));
      expect(reasons[dup]).toBe("duplicate_url");
      expect(reasons[ftp]).toBe("invalid_url");
      expect(reasons[junk]).toBe("invalid_url");
      expect(reasons[none]).toBe("no_url");
      expect(result.skipped.filter((s) => s.reason === "over_cap")).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------- start

  describe("startProfileChecks", () => {
    it("queues one durable request per eligible URL and launches no run", async () => {
      const a = await client("Perez Realty");
      await asset(a, "https://www.zillow.com/profile/ana", { at: "2026-10-01T00:00:00Z" });
      await asset(a, "https://perezrealty.example/", { at: "2026-10-01T00:00:01Z" });
      await asset(a, "mailto:ana@example.com", { at: "2026-10-01T00:00:02Z" });

      const result = await start.startProfileChecks(operator, { projectId: a.projectId, origin: "operator" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe("queued");
      expect(result.data.queued).toHaveLength(2);
      expect(result.data.skipped.map((s) => s.reason)).toEqual(["invalid_url"]);

      const rows = await queueRows(a.projectId);
      expect(rows.map((r) => [r.status, r.kind, r.origin])).toEqual([
        ["queued", "check", "operator"],
        ["queued", "check", "operator"],
      ]);
      for (const row of rows) {
        expect(row.runIdempotencyKey).toBe(constants.profileCheckRunKey(a.projectId, row.id as string));
        expect(String(row.windowKey)).toMatch(/^day:\d{4}-\d{2}-\d{2}$/);
      }
      // Starting never starts a workflow run, and one dispatcher job is queued.
      expect((await sql`select count(*)::int as n from workflow_runs`)[0]!.n).toBe(0);
      const jobs = await sql`select type from jobs where type = ${constants.PROFILE_CHECK_DISPATCH_JOB} and status = 'queued'`;
      expect(jobs).toHaveLength(1);
      const audit = await sql`select action, project_id from audit_log where action = 'profile_checks.queued'`;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.projectId).toBe(a.projectId);
    });

    it("returns a deterministic no-profiles result and queues nothing", async () => {
      const a = await client("Perez Realty");
      const result = await start.startProfileChecks(operator, { projectId: a.projectId, origin: "operator" });
      expect(result.ok && result.data).toMatchObject({
        status: "nothing_queued",
        queued: [],
        skipped: [{ contextItemId: null, profileUrl: null, reason: "no_confirmed_profiles" }],
      });
      expect(await queueRows()).toHaveLength(0);
    });

    it("suppresses a duplicate within the window but not across operator/schedule windows", async () => {
      const a = await client("Perez Realty");
      await asset(a, "https://www.zillow.com/profile/ana");
      const monday = new Date("2026-10-05T12:00:00Z");

      const first = await start.startProfileChecks(operator, { projectId: a.projectId, origin: "operator" }, monday);
      const again = await start.startProfileChecks(operator, { projectId: a.projectId, origin: "operator" }, monday);
      expect(first.ok && first.data.queued).toHaveLength(1);
      expect(again.ok && again.data.queued).toHaveLength(0);
      expect(again.ok && again.data.skipped.map((s) => s.reason)).toEqual(["already_requested"]);

      const weekly1 = await start.startWeeklyProfileChecks(monday);
      const weekly2 = await start.startWeeklyProfileChecks(new Date("2026-10-08T12:00:00Z"));
      expect(weekly1.queued).toBe(1);
      expect(weekly2.queued).toBe(0);

      const rows = await queueRows(a.projectId);
      expect(rows.map((r) => r.windowKey).sort()).toEqual(["day:2026-10-05", "week:2026-10-05"]);
    });

    it("blocks a project with no approved facts, and refuses a client role", async () => {
      const a = await client("Perez Realty", { approvedFacts: false });
      await asset(a, "https://www.zillow.com/profile/ana");
      const blocked = await start.startProfileChecks(operator, { projectId: a.projectId, origin: "operator" });
      expect(blocked.ok && blocked.data).toMatchObject({ status: "blocked", blockedReason: "no_approved_facts" });
      expect(await queueRows()).toHaveLength(0);

      const refused = await start.startProfileChecks(clientViewer, { projectId: a.projectId, origin: "operator" });
      expect(refused.ok).toBe(false);
    });

    it("keeps queueing the remaining URLs when one fails to queue", async () => {
      const a = await client("Perez Realty");
      await asset(a, "https://good-one.example/", { at: "2026-10-01T00:00:00Z" });
      await asset(a, "https://bad.example/", { at: "2026-10-01T00:00:01Z" });
      await asset(a, "https://good-two.example/", { at: "2026-10-01T00:00:02Z" });
      // A database-level refusal for exactly one URL.
      await sql.unsafe(`
        create function test_refuse_bad() returns trigger language plpgsql as $$
        begin
          if new.profile_url = 'https://bad.example/' then raise exception 'refused for test'; end if;
          return new;
        end $$;
        create trigger test_refuse_bad before insert on profile_check_requests
          for each row execute function test_refuse_bad();
      `);
      try {
        const result = await start.startProfileChecks(operator, { projectId: a.projectId, origin: "operator" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.queued.map((q) => q.profileUrl)).toEqual([
          "https://good-one.example/",
          "https://good-two.example/",
        ]);
        expect(result.data.skipped.map((s) => [s.profileUrl, s.reason])).toEqual([
          ["https://bad.example/", "queue_failed"],
        ]);
      } finally {
        await sql.unsafe(`
          drop trigger test_refuse_bad on profile_check_requests;
          drop function test_refuse_bad();
        `);
      }
    });

    it("schedules every live client through the same path, isolating failures", async () => {
      const a = await client("Perez Realty");
      const b = await client("Rival Realty");
      const blocked = await client("No Facts Realty", { approvedFacts: false });
      await asset(a, "https://a.example/");
      await asset(b, "https://b.example/");
      await asset(blocked, "https://c.example/");

      const summary = await start.startWeeklyProfileChecks(new Date("2026-10-06T12:00:00Z"));
      expect(summary).toMatchObject({ projects: 3, queued: 2, blocked: 1, failed: 0 });
      const rows = await queueRows();
      expect(rows.every((r) => r.origin === "schedule" && r.windowKey === "week:2026-10-05")).toBe(true);
    });
  });

  // ---------------------------------------------------------- dispatcher

  describe("bounded dispatcher", () => {
    async function queueFor(names: string[], perClient = 1) {
      const out: { projectId: string }[] = [];
      for (const [i, name] of names.entries()) {
        const c = await client(name);
        for (let j = 0; j < perClient; j += 1) {
          await asset(c, `https://${name.toLowerCase().replace(/\W+/g, "-")}.example/${j}`, {
            at: new Date(Date.UTC(2026, 9, 1, i, 0, j)).toISOString(),
          });
        }
        const r = await start.startProfileChecks(operator, { projectId: c.projectId, origin: "operator" });
        expect(r.ok).toBe(true);
        out.push({ projectId: c.projectId });
      }
      return out;
    }

    it("releases one check at the default capacity and keeps the rest durably queued", async () => {
      await queueFor(["Alpha"], 3);
      const report = await dispatch.dispatchProfileChecks();
      expect(report.limit).toBe(1);
      expect(report.released).toHaveLength(1);

      const rows = await queueRows();
      expect(rows.map((r) => r.status)).toEqual(["released", "queued", "queued"]);
      const events = await sql`select type, project_id, payload from domain_events where type = 'profile.check_requested'`;
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        checkRequestId: rows[0]!.id,
        contextItemId: rows[0]!.contextItemId,
        profileUrl: rows[0]!.profileUrl,
        origin: "operator",
      });
      // The release is still inference-active (no run yet): nothing more goes.
      const second = await dispatch.dispatchProfileChecks();
      expect(second.released).toHaveLength(0);
      expect((await queueRows()).filter((r) => r.status === "queued")).toHaveLength(2);
    });

    it("applies one global capacity across projects, oldest first", async () => {
      const [alpha, beta] = await queueFor(["Alpha", "Beta"]);
      process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS = "1";
      await dispatch.dispatchProfileChecks();
      const released = (await queueRows()).filter((r) => r.status === "released");
      expect(released.map((r) => r.projectId)).toEqual([alpha!.projectId]);

      // Alpha's run becomes active, then parks for approval: only then does Beta go.
      await seedRun(released[0]!.runIdempotencyKey as string, "running", alpha!.projectId);
      expect((await dispatch.dispatchProfileChecks()).released).toHaveLength(0);
      await sql`update workflow_runs set state = 'waiting_for_approval'`;
      const next = await dispatch.dispatchProfileChecks();
      expect(next.released).toHaveLength(1);
      expect((await queueRows(beta!.projectId))[0]!.status).toBe("released");
    });

    it("honours a configured capacity and refuses an invalid one", async () => {
      await queueFor(["Alpha"], 4);
      process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS = "3";
      expect((await dispatch.dispatchProfileChecks()).released).toHaveLength(3);

      process.env.PROFILE_CHECK_MAX_INFERENCE_RUNS = "26";
      await expect(dispatch.dispatchProfileChecks()).rejects.toThrow(/1 to 25/);
      expect((await queueRows()).filter((r) => r.status === "queued")).toHaveLength(1);
    });

    it("counts any active profile-correction run, not only queue releases", async () => {
      await queueFor(["Alpha"]);
      await seedRun("live:profile:https://elsewhere.example/", "running");
      expect((await dispatch.dispatchProfileChecks()).released).toHaveLength(0);
      await sql`update workflow_runs set state = 'completed'`;
      expect((await dispatch.dispatchProfileChecks()).released).toHaveLength(1);
    });

    it("never double-releases under concurrent dispatchers (advisory lock)", async () => {
      await queueFor(["Alpha", "Beta", "Gamma"]);
      const reports = await Promise.all([
        dispatch.dispatchProfileChecks(),
        dispatch.dispatchProfileChecks(),
        dispatch.dispatchProfileChecks(),
        dispatch.dispatchProfileChecks(),
      ]);
      expect(reports.reduce((n, r) => n + r.released.length, 0)).toBe(1);
      expect((await queueRows()).filter((r) => r.status === "released")).toHaveLength(1);
      expect(await sql`select id from domain_events where type = 'profile.check_requested'`).toHaveLength(1);
    });

    it("recovers a release that never became a run", async () => {
      await queueFor(["Alpha"], 2);
      await dispatch.dispatchProfileChecks();
      const [stuck] = (await queueRows()).filter((r) => r.status === "released");
      await sql`update profile_check_requests set released_at = now() - interval '16 minutes' where id = ${stuck!.id}`;

      const report = await dispatch.dispatchProfileChecks();
      expect(report.abandoned).toEqual([stuck!.id]);
      expect(report.released).toHaveLength(1);
      const rows = await queueRows();
      expect(rows.find((r) => r.id === stuck!.id)).toMatchObject({ status: "failed", reason: "release_timed_out" });
      expect(rows.filter((r) => r.status === "released")).toHaveLength(1);
    });

    it("re-enqueues itself while due work waits, and stops when the queue is empty", async () => {
      await queueFor(["Alpha"], 2);
      await sql`delete from jobs`;
      const report = await dispatch.dispatchProfileChecks();
      expect(report.rescheduled).toBe(true);
      const [job] = await sql`select run_after > now() as later from jobs where type = ${constants.PROFILE_CHECK_DISPATCH_JOB} and status = 'queued'`;
      expect(job?.later).toBe(true);

      await sql`delete from jobs`;
      await sql`update profile_check_requests set status = 'skipped', reason = 'test' where status = 'queued'`;
      expect((await dispatch.dispatchProfileChecks()).rescheduled).toBe(false);
    });

    it("keeps queue history: rows cannot be deleted", async () => {
      await queueFor(["Alpha"]);
      await expect(sql`delete from profile_check_requests`).rejects.toThrow(/forbidden/);
    });
  });

  // ----------------------------------------------- release → workflow run

  describe("released check → profile-correction run", () => {
    const PROFILE_URL = "https://directory.example.com/agents/ana-perez";

    function stubNetwork(page: { status: number; body: string }) {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          calls.push(url);
          if (url.endsWith("/api/chat")) {
            // The local Ollama endpoint: extraction finds nothing to propose,
            // so the comparison runs on an empty observed set.
            const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
            const content =
              body.model === "qwen3:30b"
                ? JSON.stringify({ contradictions: [], confidence: 0.95 })
                : JSON.stringify({ claims: [] });
            return new Response(
              JSON.stringify({ message: { role: "assistant", content }, prompt_eval_count: 10, eval_count: 5 }),
              { status: 200, headers: { "content-type": "application/json" } }
            );
          }
          if (url === PROFILE_URL) {
            return new Response(page.body, { status: page.status, headers: { "content-type": "text/html" } });
          }
          return new Response("not found", { status: 404 });
        })
      );
      return calls;
    }

    async function releaseOne(projectId: string) {
      const r = await start.startProfileChecks(operator, { projectId, origin: "operator" });
      expect(r.ok && r.data.queued).toHaveLength(1);
      const report = await dispatch.dispatchProfileChecks();
      expect(report.released).toHaveLength(1);
      const [row] = await queueRows(projectId);
      await autoDispatch.deliverOneEvent(row!.eventId as string);
      const runs = await sql`select * from workflow_runs where idempotency_key = ${row!.runIdempotencyKey}`;
      expect(runs).toHaveLength(1);
      return { row: row!, run: runs[0]! };
    }

    async function drive(runId: string): Promise<string> {
      let state = "";
      for (let i = 0; i < 20; i += 1) {
        state = await engine.advanceWorkflow(runId);
        if (["completed", "failed", "cancelled", "safely_stopped", "timed_out", "partially_completed"].includes(state)) break;
      }
      return state;
    }

    it("starts exactly one run of the right workflow, for the right tenant, with no connector", async () => {
      const a = await client("Perez Realty", { subject: "Perez Realty Group" });
      const b = await client("Rival Realty", { subject: "Rival Realty" });
      await asset(a, PROFILE_URL);
      await asset(b, "https://rival.example/agent");
      const calls = stubNetwork({ status: 200, body: PROFILE_HTML });

      const { row, run } = await releaseOne(a.projectId);
      expect(run.projectId).toBe(a.projectId);
      expect(run.input).toMatchObject({
        event: { type: "profile.check_requested" },
        payload: { checkRequestId: row.id, profileUrl: PROFILE_URL, contextItemId: row.contextItemId },
      });
      const [def] = await sql`
        select d.key from workflow_versions v join workflow_definitions d on d.id = v.definition_id
        where v.id = ${run.versionId}
      `;
      expect(def!.key).toBe(authority.PROFILE_CORRECTION_KEY);

      // Re-delivering the event collapses onto the same run.
      await autoDispatch.deliverOneEvent(row.eventId as string);
      expect(await sql`select id from workflow_runs`).toHaveLength(1);

      // No connector connection exists anywhere, and the run still completes.
      expect(await sql`select id from connector_connections`).toHaveLength(0);
      const state = await drive(run.id as string);
      expect(state).toBe("completed");

      const nodes = await sql`select node_key, state, output from node_runs where workflow_run_id = ${run.id} order by started_at nulls last, node_key`;
      const byKey = Object.fromEntries(nodes.map((n) => [n.nodeKey as string, n]));
      expect(byKey.fetch_profile!.state).toBe("succeeded");
      expect(byKey.fetch_profile!.output).toMatchObject({ ok: true, data: { url: PROFILE_URL, status: 200, reachable: true } });
      expect(byKey.canonical_extract!.state).toBe("succeeded");
      expect(byKey.compare!.state).toBe("succeeded");
      expect(byKey.no_error!.state).toBe("succeeded");

      // canonical_extract ingested the page itself, as before (spec 145B),
      // with no connector provenance.
      const artifacts = await sql`select project_id, origin, original_url, provider from source_artifacts`;
      expect(artifacts).toEqual([
        { projectId: a.projectId, origin: "url_fetch", originalUrl: PROFILE_URL, provider: null },
      ]);
      expect(byKey.canonical_extract!.output).toMatchObject({
        sourceArtifactId: expect.any(String),
        claims: [],
      });
      // The page was fetched twice (reachability gate, then ingest) and
      // nothing else on the open web was contacted.
      expect(calls.filter((u) => u === PROFILE_URL)).toHaveLength(2);
      expect(calls.filter((u) => !u.endsWith("/api/chat") && u !== PROFILE_URL)).toEqual([]);

      // Once the run is terminal it no longer holds capacity.
      expect(await (await import("@/db/profile-corrections")).countInferenceActive(sql, dispatch.PROFILE_INFERENCE_WORKFLOW_KEYS)).toBe(0);
    });

    it("stops safely before extraction when the page is unreachable", async () => {
      const a = await client("Perez Realty", { subject: "Perez Realty Group" });
      await asset(a, PROFILE_URL);
      stubNetwork({ status: 503, body: "down" });
      const { run } = await releaseOne(a.projectId);
      expect(await drive(run.id as string)).toBe("safely_stopped");
      const [fetchNode] = await sql`select output from node_runs where workflow_run_id = ${run.id} and node_key = 'fetch_profile'`;
      expect(fetchNode!.output).toMatchObject({ ok: true, data: { reachable: false, status: 503 } });
      expect(await sql`select id from source_artifacts`).toHaveLength(0);
    });
  });
});
