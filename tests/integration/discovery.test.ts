/**
 * Integration tests for spec 027 — external source discovery.
 *
 * No test performs a live search or a live fetch. The search caller, the agent
 * caller and `fetch` are all injected, matching how `lib/ai/agent.ts` is
 * already tested — a suite that reached the open web would be non-deterministic
 * and would spend money.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const ARTICLE_HTML = `<html><head><title>Coverage</title></head><body>
<h1>Harbour Line Group expands</h1>
<p>Harbour Line Group opened a second office in Jersey City in 2025.</p>
<p>The team is led by Dana Okafor.</p>
</body></html>`;

/** An OpenAI Responses-API payload carrying url_citation annotations. */
function searchPayload(urls: { url: string; title: string }[]) {
  return {
    output: [
      {
        content: [
          {
            annotations: urls.map((u) => ({
              type: "url_citation",
              url: u.url,
              title: u.title,
            })),
          },
        ],
      },
    ],
  };
}

describe.skipIf(!TEST_URL)("external source discovery (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimSvc: typeof import("@/lib/claims/service");
  let discovery: typeof import("@/lib/knowledge/discovery/service");

  let projectA = "";
  let projectB = "";

  /**
   * Serves canned bytes for any http(s) fetch, including robots.txt, and
   * installs itself globally.
   *
   * `ingestSource` fetches through the global `fetch` and takes no injection
   * point. Stubbing the global is preferable to widening tested production
   * code to suit a test — and it guarantees the robots check and the ingest
   * see the same fixture, which two separate stubs would not.
   */
  const installFetch = (opts: { robots?: string; body?: string; fail?: boolean }) => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) {
        return new Response(opts.robots ?? "User-agent: *\nDisallow:", { status: 200 });
      }
      if (opts.fail) return new Response("nope", { status: 500 });
      return new Response(opts.body ?? ARTICLE_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", impl);
    return impl;
  };

  const stubSearch = (urls: { url: string; title: string }[]) => async () => ({
    rawPayload: searchPayload(urls),
    costMicroUsd: 1_000,
  });

  /** Deterministic stand-in for the claim-extraction agent. */
  const stubAgent = (claims: unknown[]) =>
    (async () => ({
      text: JSON.stringify({ claims }),
      tokensIn: 100,
      tokensOut: 50,
    })) as never;

  /**
   * Shaped to `claimExtractionOutputSchema`. `originalWording` must be a
   * verbatim substring of the extracted document or the extractor rejects it —
   * which is the guard being relied on here, not worked around.
   */
  const CLAIM = [
    {
      subject: "Harbour Line Group",
      predicate: "operates_office",
      object: "Jersey City",
      originalWording: "Harbour Line Group opened a second office in Jersey City in 2025.",
      normalizedWording: "Harbour Line Group opened a second office in Jersey City in 2025.",
      category: "operations",
      asOf: null,
      value: null,
      locator: "",
      confidence: 0.9,
    },
  ];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimSvc = await import("@/lib/claims/service");
    discovery = await import("@/lib/knowledge/discovery/service");

    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  afterEach(() => {
    // Leaving a stubbed global fetch installed would silently change the
    // behaviour of every suite that runs after this one.
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate discovery_candidates, discovery_runs, extraction_runs,
        extracted_documents, claim_contradictions, claim_versions, claims,
        source_artifacts, knowledge_entities, evidence, competitors, companies,
        jobs, domain_events, audit_log, projects
      restart identity cascade
    `);
    const a = await projectSvc.createProject(user, { name: "Harbour Line Group" });
    const b = await projectSvc.createProject(user, { name: "Rival Client" });
    if (!a.ok || !b.ok) throw new Error("project setup failed");
    projectA = a.data.id;
    projectB = b.data.id;

    const company = await companySvc.upsertCompany(user, {
      name: "Harbour Line Group",
      aliases: ["Harbour Line"],
      domain: "harbourline.example",
    });
    if (!company.ok) throw new Error("company setup failed");
    await claimSvc.setSubjectCompany(user, {
      projectId: projectA,
      companyId: company.data.id,
    });
  });

  it("captures pages, proposes claims from stored bytes, and reconciles its counts", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA, maxPages: 2 },
      {
        searchCaller: stubSearch([
          { url: "https://press.example/harbour-line", title: "Coverage" },
        ]),
        agentCaller: stubAgent(CLAIM),
        fetchImpl: installFetch({}),
        delayMs: 0,
      }
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.candidatesIngested).toBeGreaterThan(0);
    expect(res.data.claimsProposed).toBeGreaterThan(0);

    // Every proposed claim must cite bytes we actually hold.
    const [artifact] = await sql`
      select id, original_url, sha256 from source_artifacts where project_id = ${projectA}
    `;
    expect(artifact).toBeTruthy();
    expect(artifact!.sha256).toBeTruthy();

    // Counts on the run row reconcile with the summary.
    const [run] = await sql`
      select candidates_found, candidates_ingested, claims_proposed, status
      from discovery_runs where id = ${res.data.discoveryRunId}
    `;
    expect(run!.candidatesIngested).toBe(res.data.candidatesIngested);
    expect(run!.claimsProposed).toBe(res.data.claimsProposed);
  }, 60_000);

  it("proposes nothing when every fetch fails, and says why", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA, maxPages: 3 },
      {
        searchCaller: stubSearch([{ url: "https://press.example/a", title: "A" }]),
        agentCaller: stubAgent(CLAIM),
        fetchImpl: installFetch({ fail: true }),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.claimsProposed).toBe(0);
    expect(res.data.candidatesIngested).toBe(0);
    expect(res.data.skipped.fetch_failed).toBeGreaterThan(0);
    // "Found nothing" and "could not fetch" must not read the same.
    expect(res.data.narrative).toMatch(/could not be fetched/i);
    expect(res.data.narrative).not.toMatch(/returned no pages/i);
  }, 60_000);

  it("distinguishes an empty result set from an unfetchable one", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA },
      {
        searchCaller: stubSearch([]),
        agentCaller: stubAgent([]),
        fetchImpl: installFetch({}),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.candidatesFound).toBe(0);
    expect(res.data.narrative).toMatch(/returned no pages/i);
  }, 60_000);

  it("never re-ingests the client's own domain", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA },
      {
        searchCaller: stubSearch([
          { url: "https://harbourline.example/team", title: "Team" },
        ]),
        agentCaller: stubAgent(CLAIM),
        fetchImpl: installFetch({}),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.candidatesIngested).toBe(0);
    expect(res.data.skipped.own_domain).toBeGreaterThan(0);

    const rows = await sql`select count(*)::int as n from source_artifacts where project_id = ${projectA}`;
    expect(rows[0]!.n).toBe(0);
  }, 60_000);

  it("respects robots.txt", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA },
      {
        searchCaller: stubSearch([{ url: "https://press.example/blocked", title: "B" }]),
        agentCaller: stubAgent(CLAIM),
        fetchImpl: installFetch({ robots: "User-agent: *\nDisallow: /" }),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.skipped.robots_disallowed).toBeGreaterThan(0);
    expect(res.data.candidatesIngested).toBe(0);
  }, 60_000);

  it("is idempotent: a second run ingests nothing new", async () => {
    const opts = {
      searchCaller: stubSearch([{ url: "https://press.example/harbour-line", title: "C" }]),
      agentCaller: stubAgent(CLAIM),
      fetchImpl: installFetch({}),
      delayMs: 0,
    };
    const first = await discovery.runExternalDiscovery(user, { projectId: projectA }, opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.candidatesIngested).toBe(1);

    const second = await discovery.runExternalDiscovery(user, { projectId: projectA }, opts);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.candidatesIngested).toBe(0);
    expect(second.data.skipped.already_ingested).toBeGreaterThan(0);

    const rows = await sql`select count(*)::int as n from source_artifacts where project_id = ${projectA}`;
    expect(rows[0]!.n).toBe(1);
  }, 90_000);

  it("records every candidate considered, including the rejected ones", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA },
      {
        searchCaller: stubSearch([
          { url: "https://harbourline.example/own", title: "Own" },
          { url: "https://press.example/keep", title: "Keep" },
        ]),
        agentCaller: stubAgent(CLAIM),
        fetchImpl: installFetch({}),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const rows = await sql`
      select decision, skip_reason from discovery_candidates
      where discovery_run_id = ${res.data.discoveryRunId}
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.decision === "skipped" && r.skipReason === "own_domain")).toBe(true);
    // Every skip carries a reason — the constraint enforces it, this proves it.
    for (const row of rows) {
      if (row.decision === "skipped") expect(row.skipReason).toBeTruthy();
    }
  }, 60_000);

  it("keeps the candidate record immutable", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA },
      {
        searchCaller: stubSearch([{ url: "https://press.example/x", title: "X" }]),
        agentCaller: stubAgent(CLAIM),
        fetchImpl: installFetch({}),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(true);
    await expect(
      sql`update discovery_candidates set decision = 'ingested'`
    ).rejects.toThrow();
  }, 60_000);

  it("refuses to run for a client with no subject company", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectB },
      {
        searchCaller: stubSearch([]),
        agentCaller: stubAgent([]),
        fetchImpl: installFetch({}),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toMatch(/subject company/i);
  }, 60_000);

  it("writes nothing into another client's scope", async () => {
    const res = await discovery.runExternalDiscovery(
      user,
      { projectId: projectA },
      {
        searchCaller: stubSearch([{ url: "https://press.example/iso", title: "Iso" }]),
        agentCaller: stubAgent(CLAIM),
        fetchImpl: installFetch({}),
        delayMs: 0,
      }
    );
    expect(res.ok).toBe(true);
    const [other] = await sql`
      select count(*)::int as n from source_artifacts where project_id = ${projectB}
    `;
    expect(other!.n).toBe(0);
    const [otherCandidates] = await sql`
      select count(*)::int as n from discovery_candidates where project_id = ${projectB}
    `;
    expect(otherCandidates!.n).toBe(0);
  }, 60_000);
});
