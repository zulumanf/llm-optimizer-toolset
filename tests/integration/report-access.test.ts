/**
 * Spec 134 — private report access over the real pipeline: invitation
 * exchange, session authorization, forwarding allowance, revocation,
 * expiry, cross-report isolation, legacy tokens, scanner safety, view
 * stamping, internal exclusion and the access metrics.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";
import { seedApprovedFinding, type PipelineModules } from "../helpers/prospect-fixtures";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  // The exchange route asks who is at the browser; a prospect is nobody.
  return { ...actual, getCurrentUserOrNull: async () => null };
});

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";

const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };

describe.skipIf(!TEST_URL)("private report access (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let exclusivity: typeof import("@/lib/exclusivity/service");
  let svc: typeof import("@/lib/prospects/service");
  let links: typeof import("@/lib/prospects/links");
  let access: typeof import("@/lib/prospects/report-access");
  let route: typeof import("@/app/report/[slug]/[key]/route");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    exclusivity = await import("@/lib/exclusivity/service");
    svc = await import("@/lib/prospects/service");
    links = await import("@/lib/prospects/links");
    access = await import("@/lib/prospects/report-access");
    route = await import("@/app/report/[slug]/[key]/route");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, prospect_report_access_events, prospect_report_sessions,
       prospect_audit_links, prospect_activities, prospect_stage_history,
       outreach_drafts, prospect_audit_views, prospect_audits,
       prospect_findings, prospect_benchmarks, prospect_authority_signals,
       prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
    delete process.env.REPORT_SESSION_ALLOWANCE;
  });

  afterAll(async () => {
    await sql.end();
  });

  function modules(): PipelineModules {
    return { sql, projectSvc, setSvc, promptSvc, runSvc, execute, jobs, companySvc, claims, parsing, scoring, exclusivity, svc };
  }

  /** A published prospect with its invitation key, clean slug and legacy token. */
  async function seedPublished(): Promise<{ prospectId: string; auditId: string; token: string; key: string; slug: string }> {
    const fixture = await seedApprovedFinding(modules(), operator, admin, { projectKind: "prospect" });
    const published = unwrap(await svc.publishAudit(operator, { prospectId: fixture.prospectId }));
    const link = await links.auditLinkForProspect(fixture.prospectId);
    const [p] = await sql`select report_slug from prospects where id = ${fixture.prospectId}`;
    return { prospectId: fixture.prospectId, auditId: published.auditId, token: published.accessToken, key: link!.key, slug: p!.reportSlug as string };
  }

  /** A second published prospect on the same launch (the pipeline fixture
   * can seed only one company per test): same snapshot, own token and key. */
  async function cloneProspect(from: { prospectId: string; auditId: string }, name: string): Promise<{ prospectId: string; key: string; slug: string }> {
    const { randomBytes } = await import("node:crypto");
    return sql.begin(async (tx) => {
      const [p] = await tx`
        insert into prospects (launch_id, business_name, prospect_type)
        select launch_id, ${name}, prospect_type from prospects where id = ${from.prospectId}
        returning id`;
      const id = p!.id as string;
      await tx`
        insert into prospect_audits (prospect_id, finding_id, headline, snapshot, status, access_token, published_at)
        select ${id}, finding_id, headline, snapshot, 'published', ${randomBytes(32).toString("base64url")}, now()
        from prospect_audits where id = ${from.auditId}`;
      await links.ensureAuditLink(tx, null, id, name);
      const link = await links.auditLinkForProspect(id, tx);
      const [row] = await tx`select report_slug from prospects where id = ${id}`;
      return { prospectId: id, key: link!.key, slug: row!.reportSlug as string };
    });
  }

  const human = (presented: string[] = []) => ({ ip: "203.0.113.9", userAgent: BROWSER, staff: false, presentedTokens: presented });

  async function grant(credential: string, presented: string[] = []): Promise<string> {
    const r = await access.exchangeInvitation(credential, human(presented));
    if (r.kind !== "granted" || !r.sessionToken) throw new Error(`expected a fresh grant, got ${r.kind}`);
    return r.sessionToken;
  }

  /** What the page does: authorize, then record the view under the session. */
  async function view(slug: string, tokens: string[], ua = BROWSER): Promise<{ id: string } | null> {
    const s = await access.authorizeReportRequest(slug, tokens);
    if (!s) return null;
    const page = await svc.getAuditPageById(s.auditId, { userAgent: ua, sessionId: s.id, internal: s.isInternal, ip: "203.0.113.9" });
    return page ? { id: page.viewId } : null;
  }

  it("1-3: a new invitation opens the report; the clean URL works only with the session", async () => {
    const { slug, key, prospectId } = await seedPublished();
    expect(slug).toBe("rivera-team");
    const sessionToken = await grant(key);
    // The credential is never stored raw and the session is not yet counted.
    const [row] = await sql`select token_hash, first_used_at from prospect_report_sessions where prospect_id = ${prospectId}`;
    expect(row!.tokenHash).not.toBe(sessionToken);
    expect(row!.firstUsedAt).toBeNull();
    // Clean URL with the session → report, view stamped with the session.
    const v = await view(slug, [sessionToken]);
    expect(v).not.toBeNull();
    const [stamped] = await sql`select session_id, is_internal from prospect_audit_views where id = ${v!.id}`;
    expect(stamped!.sessionId).not.toBeNull();
    expect(stamped!.isInternal).toBe(false);
    // 4: the clean URL alone grants nothing.
    expect(await access.authorizeReportRequest(slug, [])).toBeNull();
    expect(await access.authorizeReportRequest(slug, ["not-a-session"])).toBeNull();
  });

  it("5-7: a forwarded invitation authorizes a second browser, up to the allowance, then fails safely", async () => {
    process.env.REPORT_SESSION_ALLOWANCE = "2";
    const { slug, key } = await seedPublished();
    await sql`update prospect_audit_links set session_allowance = 2`;
    const a = await grant(key);
    const b = await grant(key);
    expect(a).not.toBe(b);
    expect(await view(slug, [a])).not.toBeNull();
    expect(await view(slug, [b])).not.toBeNull();
    const c = await access.exchangeInvitation(key, human());
    expect(c.kind).toBe("limit");
    // Existing sessions keep working; the refusal is on the ledger.
    expect(await view(slug, [a])).not.toBeNull();
    const [refused] = await sql`select count(*)::int as n from prospect_report_access_events where kind = 'access_refused'`;
    expect(Number(refused!.n)).toBe(1);
    // 21: the same browser clicking again reuses its session — no new activation.
    const again = await access.exchangeInvitation(key, human([a]));
    expect(again.kind).toBe("granted");
    expect((again as { reused: boolean }).reused).toBe(true);
    const [sessions] = await sql`select count(*)::int as n from prospect_report_sessions`;
    expect(Number(sessions!.n)).toBe(2);
  });

  it("8-9: revoking access blocks new activations and ends existing sessions at the next request", async () => {
    const { slug, key, prospectId } = await seedPublished();
    const a = await grant(key);
    expect(await view(slug, [a])).not.toBeNull();
    const r = unwrap(await access.revokeReportAccess(operator, { prospectId, reason: "wrong recipient" }));
    expect(r.sessionsRevoked).toBe(1);
    expect((await access.exchangeInvitation(key, human())).kind).toBe("invalid");
    expect(await access.authorizeReportRequest(slug, [a])).toBeNull();
    // The audit itself is still published: a fresh invitation can be minted.
    const fresh = unwrap(await links.mintAuditLink(operator, { prospectId }));
    expect(fresh.key).not.toBe(key);
    expect((await access.exchangeInvitation(fresh.key, human())).kind).toBe("granted");
  });

  it("revokeAudit also ends every session", async () => {
    const { slug, key, auditId } = await seedPublished();
    const a = await grant(key);
    expect(await view(slug, [a])).not.toBeNull();
    unwrap(await svc.revokeAudit(operator, { auditId, reason: "content error" }));
    expect(await access.authorizeReportRequest(slug, [a])).toBeNull();
    expect((await access.exchangeInvitation(key, human())).kind).toBe("invalid");
  });

  it("10-11: an expired audit refuses the invitation; an expired session refuses the clean URL", async () => {
    const { slug, key, auditId } = await seedPublished();
    const a = await grant(key);
    expect(await view(slug, [a])).not.toBeNull();
    await sql`update prospect_report_sessions set expires_at = now() - interval '1 minute'`;
    expect(await access.authorizeReportRequest(slug, [a])).toBeNull();
    const b = await grant(key);
    unwrap(await svc.expireAudit(operator, { auditId }));
    expect(await access.authorizeReportRequest(slug, [b])).toBeNull();
    expect((await access.exchangeInvitation(key, human())).kind).toBe("invalid");
  });

  it("a pending session that never reaches the report evaporates and never counts", async () => {
    const { slug, key } = await seedPublished();
    const pending = await grant(key);
    await sql`update prospect_report_sessions set expires_at = now() - interval '1 second'`;
    expect(await access.authorizeReportRequest(slug, [pending])).toBeNull();
    const m = await access.reportAccessMetrics((await sql`select id from prospects`)[0]!.id as string);
    expect(m.externalSessionCount).toBe(0);
  });

  it("12-13: a session for one report cannot open another report", async () => {
    const one = await seedPublished();
    await sql`update prospects set report_slug = 'other-team', business_name = 'Other Team' where id = ${one.prospectId}`;
    // A second prospect on the same market, published with its own key.
    const two = await cloneProspect(one, "Second Team");
    const slug2 = two.slug;
    expect(slug2).toBe("second-team");
    const a = await grant(one.key);
    const b = await grant(two.key);
    expect(await access.authorizeReportRequest("other-team", [a])).not.toBeNull();
    expect(await access.authorizeReportRequest(slug2, [a])).toBeNull();
    expect(await access.authorizeReportRequest("other-team", [b])).toBeNull();
    expect(await access.authorizeReportRequest(slug2, [b])).not.toBeNull();
  });

  it("14-16: a legacy token still works, lands on the clean URL, and touches no evidence", async () => {
    const { slug, token, prospectId, auditId } = await seedPublished();
    const [before] = await sql`select snapshot, access_token, published_at from prospect_audits where id = ${auditId}`;
    const r = await access.exchangeInvitation(token, human());
    expect(r.kind).toBe("granted");
    expect((r as { slug: string }).slug).toBe(slug);
    const s = await access.authorizeReportRequest(slug, [(r as { sessionToken: string }).sessionToken]);
    expect(s?.prospectId).toBe(prospectId);
    const [after] = await sql`select snapshot, access_token, published_at from prospect_audits where id = ${auditId}`;
    expect(after).toEqual(before);
    // The legacy session is attributed to the prospect's active link.
    const [sess] = await sql`select link_id from prospect_report_sessions`;
    expect(sess!.linkId).not.toBeNull();
  });

  it("17: an invalid credential yields nothing and no ledger row naming a prospect", async () => {
    await seedPublished();
    expect((await access.exchangeInvitation("0000000000000000", human())).kind).toBe("invalid");
    expect((await access.exchangeInvitation("x".repeat(43), human())).kind).toBe("invalid");
    expect((await access.exchangeInvitation("../../etc", human())).kind).toBe("invalid");
    const [n] = await sql`select count(*)::int as n from prospect_report_access_events`;
    expect(Number(n!.n)).toBe(0);
  });

  it("18: HEAD creates nothing; a scanner GET creates no session and no view", async () => {
    const { slug, key } = await seedPublished();
    const head = await route.HEAD();
    expect(head.status).toBe(204);
    expect(head.headers.get("x-robots-tag")).toContain("noindex");
    for (const ua of ["curl/8.4", "Mozilla/5.0", ""]) {
      const r = await access.exchangeInvitation(key, { ...human(), userAgent: ua });
      expect(r.kind).toBe("scanner");
    }
    const [n] = await sql`select count(*)::int as n from prospect_report_sessions`;
    expect(Number(n!.n)).toBe(0);
    expect(await access.authorizeReportRequest(slug, [])).toBeNull();
    const [views] = await sql`select count(*)::int as n from prospect_audit_views`;
    expect(Number(views!.n)).toBe(0);
  });

  it("19-20: operator sessions are internal and excluded; external views are counted per session", async () => {
    const { slug, key, prospectId } = await seedPublished();
    const staff = await access.exchangeInvitation(key, { ...human(), staff: true });
    expect(staff.kind).toBe("granted");
    const staffToken = (staff as { sessionToken: string }).sessionToken;
    const staffSession = await access.authorizeReportRequest(slug, [staffToken]);
    expect(staffSession?.isInternal).toBe(true);
    await svc.getAuditPageById(staffSession!.auditId, { userAgent: BROWSER, sessionId: staffSession!.id, internal: true });
    let m = await access.reportAccessMetrics(prospectId);
    expect(m.externalSessionCount).toBe(0);
    expect(m.totalExternalViews).toBe(0);
    expect(m.firstExternalViewAt).toBeNull();
    // Two external browsers, three page loads → 2 sessions, 3 views.
    const a = await grant(key);
    const b = await grant(key);
    await view(slug, [a]);
    await view(slug, [a]);
    await view(slug, [b]);
    m = await access.reportAccessMetrics(prospectId);
    expect(m.externalSessionCount).toBe(2);
    expect(m.totalExternalViews).toBe(3);
    expect(m.firstExternalAccessAt).not.toBeNull();
    expect(m.firstExternalViewAt).not.toBeNull();
    expect(m.lastExternalViewAt).not.toBeNull();
    // Internal sessions never count toward the allowance either.
    const [internalCount] = await sql`select count(*)::int as n from prospect_report_sessions where is_internal`;
    expect(Number(internalCount!.n)).toBe(1);
  });

  it("22-26: the exchange route sets an HttpOnly cookie, redirects to the clean URL and sends private headers", async () => {
    const { slug, key } = await seedPublished();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(`http://localhost:3000/report/${slug}/${key}?next=answers`, {
      headers: { "user-agent": BROWSER, "x-forwarded-for": "203.0.113.9" },
    });
    const res = await route.GET(req, { params: Promise.resolve({ slug, key }) });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.endsWith(`/report/${slug}/answers`)).toBe(true);
    expect(location).not.toContain(key);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^rfr_${slug}=`));
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain(`Path=/report/${slug}`);
    expect(cookie).not.toContain(key);
    // A wrong slug with a valid key still lands on the canonical slug.
    const wrong = await route.GET(
      new NextRequest(`http://localhost:3000/report/wrong-name/${key}`, { headers: { "user-agent": BROWSER } }),
      { params: Promise.resolve({ slug: "wrong-name", key }) }
    );
    expect(wrong.headers.get("location")?.endsWith(`/report/${slug}`)).toBe(true);
    // An invalid key redirects to the private state with no cookie.
    const bad = await route.GET(
      new NextRequest(`http://localhost:3000/report/${slug}/0000000000000000`, { headers: { "user-agent": BROWSER } }),
      { params: Promise.resolve({ slug, key: "0000000000000000" }) }
    );
    expect(bad.status).toBe(303);
    expect(bad.headers.get("set-cookie")).toBeNull();
    // A malformed slug is a bare 404 with no redirect at all.
    const malformed = await route.GET(
      new NextRequest(`http://localhost:3000/report/Bad%20Slug/${key}`, { headers: { "user-agent": BROWSER } }),
      { params: Promise.resolve({ slug: "Bad Slug", key }) }
    );
    expect(malformed.status).toBe(404);
  });

  it("27: colliding business names get the market, then a number, and never reuse a slug", async () => {
    const one = await seedPublished();
    // Distinct names (the launch forbids exact duplicates) that slugify alike.
    const two = await cloneProspect(one, "Rivera Team!");
    expect(two.slug).toBe("rivera-team-manhattan");
    const three = await cloneProspect(one, "Rivera, Team");
    expect(three.slug).toBe("rivera-team-2");
    const [dupes] = await sql`select count(*)::int as n from (select report_slug from prospects group by report_slug having count(*) > 1) d`;
    expect(Number(dupes!.n)).toBe(0);
  });
});
