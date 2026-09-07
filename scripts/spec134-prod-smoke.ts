/**
 * Spec 134 — production-safe smoke test of private report access.
 *
 * Builds an ISOLATED fixture on the deployed database (QA134 market, launch,
 * companies, project, synthetic run, prospect, published audit) and drives
 * the deployed app over HTTP: invitation → session cookie → clean URL →
 * second browser via the same invitation → clean URL alone refused →
 * revocation → both sessions refused. Ryan's and Steve's rows are
 * snapshotted before and compared after; fixtures are archived at the end.
 * No email is sent (nothing is drafted or scheduled).
 *
 *   npx tsx scripts/spec134-prod-smoke.ts
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";

const RYAN = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0";
const TAG = "QA134";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 qa134";

const results: { phase: string; status: "PASS" | "FAIL"; detail: string }[] = [];
function expect(phase: string, cond: boolean, detail = "") { results.push({ phase, status: cond ? "PASS" : "FAIL", detail }); console.log(`${cond ? "PASS" : "FAIL"} ${phase} ${detail}`); }
const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.data; };

async function snapshotRealRows(): Promise<string> {
  const rows = await sql`
    select p.id, p.stage, p.report_slug, p.archived_at,
      (select count(*) from prospect_audits a where a.prospect_id = p.id) as audits,
      (select md5(string_agg(a.snapshot::text, '' order by a.id)) from prospect_audits a where a.prospect_id = p.id) as evidence,
      (select count(*) from prospect_audit_links l where l.prospect_id = p.id and l.revoked_at is null) as links,
      (select count(*) from prospect_report_sessions s where s.prospect_id = p.id) as sessions,
      (select count(*) from outreach_drafts d where d.prospect_id = p.id) as drafts,
      (select count(*) from prospect_outreach_sends s where s.prospect_id = p.id) as sends
    from prospects p where p.id = ${RYAN} or p.business_name ilike '%steve wall%'
    order by p.id`;
  return JSON.stringify(rows);
}

async function actor(): Promise<CurrentUser> {
  const [row] = await sql`select id, email, name, role from users where role = 'admin' and active order by created_at asc limit 1`;
  if (!row) throw new Error("no active admin user");
  return { id: row.id as string, email: row.email as string, name: row.name as string, role: "admin" };
}

async function syntheticRun(projectId: string, versionId: string, subjectId: string, rivalId: string, label: string): Promise<string> {
  const [run] = await sql`
    insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd, cost_usd, completed_at, reuse_captures)
    values (${projectId}, ${versionId}, ${label}, ${sql.json([{ provider: "qa-fixture", model: "qa-fixture", repetitions: 2 }])}, 'completed', 'manual', 0, 0, now(), false)
    returning id`;
  const prompts = await sql`select p."promptId" as prompt_id, p.text from prompt_set_versions v, jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, text text) where v.id = ${versionId} order by p.text`;
  let i = 0;
  for (const pr of prompts) {
    for (const rep of [1, 2]) {
      const hit = i % 4 === 0;
      const [resp] = await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text, raw_payload, cost_usd)
        values (${run!.id}, ${pr.promptId}, ${pr.text}, 'qa-fixture', 'qa-fixture', ${rep}, ${`${TAG} synthetic answer: ${hit ? `${TAG} Fixture Team and ` : ""}${TAG} Rival Team.`}, ${sql.json({ qa: TAG })}, 0)
        returning id`;
      await sql`insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review) values (${resp!.id}, ${rivalId}, 1, true, true, ${TAG + "-fixture"}, 1, false)`;
      if (hit) await sql`insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review) values (${resp!.id}, ${subjectId}, 1, true, true, ${TAG + "-fixture"}, 1, false)`;
      i += 1;
    }
  }
  return run!.id as string;
}

interface Browser { cookie: string | null }
async function click(base: string, path: string, b: Browser): Promise<Response> {
  const res = await fetch(`${base}${path}`, { redirect: "manual", headers: { "user-agent": UA, ...(b.cookie ? { cookie: b.cookie } : {}) } });
  const set = res.headers.getSetCookie?.() ?? [];
  const rfr = set.find((c) => c.startsWith("rfr_"));
  if (rfr) b.cookie = rfr.split(";")[0]!;
  return res;
}

async function main() {
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("APP_URL not set");
  const before = await snapshotRealRows();
  const admin = await actor();
  const [mig] = await sql`select 1 from schema_migrations where name = '107_private_report_access.sql'`;
  expect("migration 107 applied", Boolean(mig));

  const excl = await import("@/lib/exclusivity/service");
  const prospects = await import("@/lib/prospects/service");
  const companies = await import("@/lib/companies/service");
  const projects = await import("@/lib/projects/service");
  const claims = await import("@/lib/claims/service");
  const sets = await import("@/lib/prompts/set-service");
  const promptSvc = await import("@/lib/prompts/prompt-service");
  const access = await import("@/lib/prospects/report-access");

  // ------------------------------------------------------------ fixture
  const stamp = Date.now().toString(36);
  const market = unwrap(await excl.createMarket(admin, { name: `${TAG} Sandbox Market ${stamp}`, kind: "custom", aliases: [] }));
  const launch = unwrap(await prospects.createLaunch(admin, { name: `${TAG} launch ${stamp}`, marketId: market.marketId, priceSegment: "luxury", serviceCategory: "residential brokerage" }));
  const subject = unwrap(await companies.upsertCompany(admin, { name: `${TAG} Fixture Team ${stamp}` }));
  const rival = unwrap(await companies.upsertCompany(admin, { name: `${TAG} Rival Team ${stamp}` }));
  const project = unwrap(await projects.createProject(admin, { name: `${TAG} Market benchmark ${stamp}`, description: "Spec 134 production smoke fixture — archived after run." }));
  await sql`update projects set kind = 'prospect' where id = ${project.id}`;
  unwrap(await claims.setSubjectCompany(admin, { projectId: project.id, companyId: subject.id }));
  const set = unwrap(await sets.createPromptSet(admin, { projectId: project.id, name: `${TAG} questions` }));
  for (const text of [`${TAG} who is the best luxury team in the sandbox market?`, `${TAG} which team should sell my sandbox loft?`, `${TAG} who handles sandbox waterfront listings?`]) {
    unwrap(await promptSvc.addPrompt(admin, { setId: set.id, text, category: "recommendation" }));
  }
  unwrap(await sets.freezePromptSet(admin, { id: set.id }));
  const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.id}`;
  const runId = await syntheticRun(project.id, version!.id as string, subject.id, rival.id, `${TAG} baseline`);
  const prospect = unwrap(await prospects.createProspect(admin, { launchId: launch.launchId, businessName: `${TAG} Fixture Team ${stamp}`, prospectType: "team", companyId: subject.id }));
  const pid = prospect.prospectId;
  // Score the synthetic run (mentions → scores) so the benchmark can link — the same
  // step the worker performs after parsing; provider "qa-fixture" keeps it isolated.
  const scoring = await import("@/lib/scoring/compute");
  await scoring.computeScores(runId);
  const { benchmarkId } = unwrap(await prospects.linkBenchmark(admin, { prospectId: pid, runId }));
  unwrap(await prospects.generateFindings(admin, { benchmarkId }));
  const [top] = await sql`select id from prospect_findings where benchmark_id = ${benchmarkId} and status = 'candidate' order by rank_score desc nulls last limit 1`;
  unwrap(await prospects.reviewFinding(admin, { findingId: top!.id as string, decision: "approved", makePrimary: true }));
  const published = unwrap(await prospects.publishAudit(admin, { prospectId: pid }));
  const [link] = await sql`select l.key, p.report_slug from prospect_audit_links l join prospects p on p.id = l.prospect_id where l.prospect_id = ${pid} and l.revoked_at is null`;
  const slug = link!.reportSlug as string;
  const key = link!.key as string;
  expect("fixture published with clean slug + invitation", Boolean(slug && key), `slug=${slug}`);

  try {
    // ------------------------------------------------------------ HTTP
    const invitation = `/report/${slug}/${key}`;
    const clean = `/report/${slug}`;
    const head = await fetch(`${base}${invitation}`, { method: "HEAD", redirect: "manual", headers: { "user-agent": UA } });
    expect("HEAD creates nothing", head.status === 204, `status ${head.status}`);
    const [afterHead] = await sql`select count(*)::int as n from prospect_report_sessions where prospect_id = ${pid}`;
    expect("HEAD: zero sessions", Number(afterHead!.n) === 0);

    const scanner = await fetch(`${base}${invitation}`, { redirect: "manual", headers: { "user-agent": "curl/8.4" } });
    expect("scanner GET: redirect, no cookie", scanner.status === 303 && !(scanner.headers.getSetCookie?.() ?? []).some((c) => c.startsWith("rfr_")), `status ${scanner.status}`);

    const A: Browser = { cookie: null };
    const exA = await click(base, invitation, A);
    const locA = exA.headers.get("location") ?? "";
    expect("A: invitation → 303 to the clean URL, credential gone", exA.status === 303 && locA.endsWith(clean) && !locA.includes(key), locA.replace(key, "<key>"));
    expect("A: HttpOnly session cookie set", Boolean(A.cookie) && /httponly/i.test((exA.headers.getSetCookie?.() ?? []).join(";")));
    expect("A: private headers on the exchange", exA.headers.get("x-robots-tag")?.includes("noindex") === true && exA.headers.get("cache-control")?.includes("no-store") === true);
    const pageA = await click(base, clean, A);
    const htmlA = await pageA.text();
    expect("A: clean URL renders the report", pageA.status === 200 && htmlA.includes(`${TAG} Fixture Team`), `status ${pageA.status}`);
    expect("A: raw credential absent from HTML", !htmlA.includes(key) && !htmlA.includes(published.accessToken));
    expect("A: report page private headers", pageA.headers.get("x-robots-tag")?.includes("noindex") === true);

    const B: Browser = { cookie: null };
    await click(base, invitation, B);
    const pageB = await click(base, clean, B);
    expect("B: forwarded invitation → own session → report", pageB.status === 200 && (await pageB.text()).includes(`${TAG} Fixture Team`) && B.cookie !== A.cookie);

    const C: Browser = { cookie: null };
    const pageC = await click(base, clean, C);
    const htmlC = await pageC.text();
    // Streaming under the root loading boundary commits the shell before notFound() resolves (status may read 200);
    // the invariant is the body: the private state, none of the report.
    expect("C: clean URL alone is refused", !htmlC.includes(`${TAG} Fixture Team`) && htmlC.includes("opens from its invitation"), `status ${pageC.status}`);

    const L: Browser = { cookie: null };
    const legacy = await click(base, `/audit/${published.accessToken}`, L);
    const legacyLoc = legacy.headers.get("location") ?? "";
    expect("legacy /audit/<token> exchanges and lands on the clean URL", legacy.status === 303 && legacyLoc.endsWith(clean) && Boolean(L.cookie), `status ${legacy.status}`);
    const legacyPage = await click(base, clean, L);
    expect("legacy session renders the report", legacyPage.status === 200 && (await legacyPage.text()).includes(`${TAG} Fixture Team`));
    // The same browser clicking again reuses its session — no new activation.
    await click(base, invitation, L);

    const m = await access.reportAccessMetrics(pid);
    const [sess] = await sql`select count(*)::int as n, bool_or(is_internal) as any_internal from prospect_report_sessions where prospect_id = ${pid} and first_used_at is not null`;
    expect("three used sessions recorded (A, B, legacy) — repeat click reused", Number(sess!.n) === 3, `internal=${sess!.anyInternal} externalSessions=${m.externalSessionCount} externalViews=${m.totalExternalViews}`);
    const [events] = await sql`select count(*) filter (where kind = 'session_created')::int as created, count(*) filter (where kind = 'access_refused')::int as refused, count(*) filter (where kind = 'access_granted' and detail->>'reused' = 'true')::int as reused from prospect_report_access_events where prospect_id = ${pid}`;
    expect("access events ledger", Number(events!.created) === 3 && Number(events!.refused) >= 1 && Number(events!.reused) === 1, JSON.stringify(events));

    // ------------------------------------------------------------ revoke
    unwrap(await access.revokeReportAccess(admin, { prospectId: pid, reason: `${TAG} smoke revocation` }));
    const afterA = await click(base, clean, A);
    const afterB = await click(base, clean, B);
    const [bodyA, bodyB] = [await afterA.text(), await afterB.text()];
    expect("revocation: A and B refused on refresh", !bodyA.includes(`${TAG} Fixture Team`) && !bodyB.includes(`${TAG} Fixture Team`) && bodyA.includes("opens from its invitation"), `${afterA.status}/${afterB.status}`);
    const D: Browser = { cookie: null };
    const exD = await click(base, invitation, D);
    expect("revocation: invitation cannot activate", exD.status === 303 && !D.cookie);
  } finally {
    // ------------------------------------------------------------ archive
    await sql`update prospects set archived_at = now(), notes = ${`${TAG} production smoke fixture — archived`} where id = ${pid}`;
    await projects.archiveProject(admin, { id: project.id });
    await sql`update companies set archived_at = now() where name like ${TAG + "%"} and archived_at is null`;
    await sql`update market_launches set archived_at = now() where name like ${TAG + "%"}`;
  }

  const after = await snapshotRealRows();
  expect("Ryan/Steve rows unchanged", before === after);
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await sql.end();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => { console.error(err); await sql.end(); process.exit(1); });
