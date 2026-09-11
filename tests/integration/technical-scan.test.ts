/**
 * Integration test for spec 088 — the full technical-scan path against an
 * injected fake site: robots → sitemap → pages → persisted facts → findings
 * → existing task queue with real evidence refs. No network, no sleeps.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const DOMAIN = "client-site.com";
const ORIGIN = `https://${DOMAIN}`;

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const SITE: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {
  [`${ORIGIN}/robots.txt`]: {
    status: 200,
    body: [
      "User-agent: *",
      "Disallow: /private/",
      "",
      "User-agent: GPTBot",
      "Disallow: /",
      "",
      `Sitemap: ${ORIGIN}/sitemap.xml`,
    ].join("\n"),
  },
  [`${ORIGIN}/sitemap.xml`]: {
    status: 200,
    body: `<?xml version="1.0"?><urlset>
      <url><loc>${ORIGIN}/team</loc><lastmod>2026-01-10</lastmod></url>
      <url><loc>${ORIGIN}/neighborhoods/paulus-hook</loc></url>
      <url><loc>${ORIGIN}/buildings/99-hudson</loc></url>
    </urlset>`,
  },
  [`${ORIGIN}/`]: {
    status: 200,
    body: `<html><head><title>Lumina Group</title>
      <script type="application/ld+json">{"@type":"Organization","name":"Lumina Group","url":"${ORIGIN}/","sameAs":["https://linkedin.com/company/lumina"],"address":"1 Main St"}</script>
      </head><body>
      <a href="/team">Meet the team</a>
      <p>Serving Jersey City in ${new Date().getFullYear()}.</p>
      </body></html>`,
  },
  [`${ORIGIN}/team`]: {
    status: 200,
    body: `<html><head><title>Our Team</title>
      <script type="application/ld+json">{"@type":"RealEstateAgent","name":"Lumina Group"}</script>
      </head><body>
      <a href="/">Home</a>
      <p>Top producers in ${new Date().getFullYear()}.</p>
      </body></html>`,
  },
  [`${ORIGIN}/neighborhoods/paulus-hook`]: {
    status: 200,
    body: `<html><head><title>Paulus Hook Homes</title></head><body>
      <a href="/">Home</a>
      <p>Our latest Paulus Hook sales closed in ${new Date().getFullYear() - 2}.</p>
      </body></html>`,
  },
  [`${ORIGIN}/buildings/99-hudson`]: {
    status: 404,
    body: "not found",
  },
};

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const entry = SITE[url];
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(entry.body, {
      status: entry.status,
      headers: { "content-type": "text/html", ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
}

describe.skipIf(!TEST_URL)("technical discoverability scan (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let scan: typeof import("@/lib/discoverability/scan");
  let svc: typeof import("@/lib/discoverability/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    scan = await import("@/lib/discoverability/scan");
    svc = await import("@/lib/discoverability/service");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, tasks, evidence, site_findings, site_pages,
       site_scans, claims, companies, prompt_set_versions, prompts,
       prompt_sets, projects cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedProject(): Promise<string> {
    const project = unwrap(
      await projectSvc.createProject(operator, { name: "Technical case" })
    );
    const subject = unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Lumina Group",
        domain: DOMAIN,
      })
    );
    unwrap(
      await claims.setSubjectCompany(operator, {
        projectId: project.id,
        companyId: subject.id,
      })
    );
    // Monitored dimensions (spec 087): Paulus Hook is covered by an owned
    // page; The Heights is not → one intent-coverage finding expected.
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    for (const neighborhood of ["Paulus Hook", "The Heights"]) {
      unwrap(
        await promptSvc.addPrompt(operator, {
          setId: set.id,
          text: `best listing agent in ${neighborhood}?`,
          category: "recommendation",
          neighborhood,
        })
      );
    }
    return project.id;
  }

  it("scans, persists facts, derives findings, and promotes one into the task queue", async () => {
    const projectId = await seedProject();
    const result = await scan.runTechnicalScan(
      { projectId },
      { fetchImpl: fakeFetch(), delayMs: 0 }
    );

    // Scan row completed with robots + sitemap facts frozen.
    const [scanRow] = await sql`
      select status, robots, sitemaps, pages_fetched from site_scans
      where id = ${result.scanId}
    `;
    expect(scanRow?.status).toBe("completed");
    const robotsFacts = scanRow?.robots as {
      present: boolean;
      crawlerAccess: { crawler: string; rootAllowed: boolean }[];
    };
    expect(robotsFacts.present).toBe(true);
    expect(
      robotsFacts.crawlerAccess.find((c) => c.crawler === "GPTBot")?.rootAllowed
    ).toBe(false);
    expect(
      robotsFacts.crawlerAccess.find((c) => c.crawler === "Googlebot")?.rootAllowed
    ).toBe(true);

    // Pages persisted with facts: homepage + 3 sitemap URLs.
    const pages = await sql`
      select url, ok, http_status, page_kind, noindex, in_sitemap,
        sitemap_lastmod, latest_year_referenced, outlinks
      from site_pages where scan_id = ${result.scanId} order by url
    `;
    expect(pages).toHaveLength(4);
    const team = pages.find((p) => p.url === `${ORIGIN}/team`)!;
    expect(team.pageKind).toBe("team");
    expect(team.inSitemap).toBe(true);
    expect(team.sitemapLastmod).toBe("2026-01-10");
    const hudson = pages.find((p) => p.url === `${ORIGIN}/buildings/99-hudson`)!;
    expect(hudson.ok).toBe(false);
    expect(hudson.httpStatus).toBe(404);

    // Findings: the expected battery, each traceable.
    const findings = await svc.listScanFindings(result.scanId);
    const types = findings.map((f) => f.checkType);
    expect(types).toContain("robots_blocks_ai_crawler");
    expect(types).toContain("page_error"); // 99 Hudson 404
    expect(types).toContain("orphan_page"); // Paulus Hook: no inlinks
    expect(types).toContain("stale_authority_page"); // Paulus Hook: 2 years old
    expect(types).toContain("incomplete_entity_schema"); // team page schema
    expect(types).toContain("intent_coverage_gap"); // The Heights uncovered
    const coverage = findings.find((f) => f.checkType === "intent_coverage_gap")!;
    expect(coverage.observation).toContain("The Heights");
    expect(coverage.observation).not.toContain('"Paulus Hook"');

    // Promotion: finding → existing task queue with a real site_page ref.
    const orphan = findings.find((f) => f.checkType === "orphan_page")!;
    const task = unwrap(
      await svc.createTaskFromSiteFinding(operator, { findingId: orphan.id })
    );
    const [taskRow] = await sql`
      select status, priority, evidence_ids from tasks where id = ${task.taskId}
    `;
    expect(taskRow?.status).toBe("suggested");
    const evidenceIds = taskRow?.evidenceIds as string[];
    expect(evidenceIds.length).toBe(1);
    const [evidenceRow] = await sql`
      select kind, ref_id from evidence where id = ${evidenceIds[0]!}
    `;
    expect(evidenceRow?.kind).toBe("site_page");
    expect(evidenceRow?.refId).toBe(orphan.pageId);
    const [updated] = await sql`
      select status, task_id from site_findings where id = ${orphan.id}
    `;
    expect(updated?.status).toBe("task_created");
    expect(updated?.taskId).toBe(task.taskId);

    // Double promotion refused; dismiss/reopen round-trips.
    const again = await svc.createTaskFromSiteFinding(operator, { findingId: orphan.id });
    expect(again.ok).toBe(false);
    const dismissable = findings.find((f) => f.checkType === "stale_authority_page")!;
    unwrap(await svc.dismissSiteFinding(operator, { findingId: dismissable.id }));
    unwrap(await svc.reopenSiteFinding(operator, { findingId: dismissable.id }));

    // Re-scan creates a NEW scan; the historical one is untouched.
    const second = await scan.runTechnicalScan(
      { projectId },
      { fetchImpl: fakeFetch(), delayMs: 0 }
    );
    expect(second.scanId).not.toBe(result.scanId);
    const [firstStill] = await sql`
      select pages_fetched, status from site_scans where id = ${result.scanId}
    `;
    expect(firstStill?.status).toBe("completed");
    expect(firstStill?.pagesFetched).toBe(4);
  });

  it("requestTechnicalScan enqueues the job and refuses a domainless project", async () => {
    const projectId = await seedProject();
    unwrap(await svc.requestTechnicalScan(operator, { projectId }));
    const [job] = await sql`
      select type, payload from jobs where type = 'technical_scan'
    `;
    expect(job).toBeDefined();
    expect((job?.payload as { projectId: string }).projectId).toBe(projectId);

    const bare = unwrap(
      await projectSvc.createProject(operator, { name: "No domain" })
    );
    const refused = await svc.requestTechnicalScan(operator, { projectId: bare.id });
    expect(refused.ok).toBe(false);
  });
});
