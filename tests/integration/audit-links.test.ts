/**
 * Integration tests for spec 076 — branded audit links over the real
 * pipeline: auto-mint at first publish, resolution to the current published
 * audit (following supersede), burn-on-revoke with no resurrection, one
 * active link per prospect, and expiry parity with the legacy token path.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";
import {
  seedApprovedFinding,
  type PipelineModules,
} from "../helpers/prospect-fixtures";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

describe.skipIf(!TEST_URL)("branded audit links (integration)", () => {
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
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, prospect_audit_links,
       prospect_activities, prospect_stage_history,
       outreach_drafts, prospect_audit_views, prospect_audits,
       prospect_findings, prospect_benchmarks, prospect_authority_signals,
       prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  function modules(): PipelineModules {
    return {
      sql, projectSvc, setSvc, promptSvc, runSvc, execute, jobs,
      companySvc, claims, parsing, scoring, exclusivity, svc,
    };
  }

  /** Shared fixture: scored prospect-kind run, finding approved as primary. */
  async function seedReadyProspect(): Promise<{ prospectId: string; runId: string }> {
    const fixture = await seedApprovedFinding(modules(), operator, admin, {
      projectKind: "prospect",
    });
    return { prospectId: fixture.prospectId, runId: fixture.runId };
  }

  it("auto-mints at first publish; the branded key resolves to the same audit", async () => {
    const { prospectId } = await seedReadyProspect();
    const published = unwrap(await svc.publishAudit(operator, { prospectId }));

    const link = await links.auditLinkForProspect(prospectId);
    expect(link).not.toBeNull();
    expect(link?.slug).toBe("rivera-team");
    expect(link?.key).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const resolved = await links.resolveAuditLink(link?.key as string);
    expect(resolved?.token).toBe(published.accessToken);
    expect(resolved?.canonicalSlug).toBe("rivera-team");

    // The resolved token goes through the one existing snapshot path.
    const snapshot = await svc.getAuditByToken(resolved?.token as string, {
      userAgent: "vitest-branded",
    });
    expect(snapshot?.prospectName).toBe("Rivera Team");
  });

  it("follows a supersede: same key, new token", async () => {
    const { prospectId } = await seedReadyProspect();
    const first = unwrap(await svc.publishAudit(operator, { prospectId }));
    const link = await links.auditLinkForProspect(prospectId);

    const second = unwrap(await svc.publishAudit(operator, { prospectId }));
    expect(second.replaced).toBe(true);

    // Same branded link, still exactly one active, resolving to the
    // current audit's token (which spec 057 keeps stable across supersede).
    const after = await links.auditLinkForProspect(prospectId);
    expect(after?.key).toBe(link?.key);
    const resolved = await links.resolveAuditLink(link?.key as string);
    expect(resolved?.token).toBe(first.accessToken);
    const [active] = await sql`
      select count(*)::int as n from prospect_audit_links
      where prospect_id = ${prospectId} and revoked_at is null
    `;
    expect(Number(active?.n)).toBe(1);
  });

  it("burns with revokeAudit and never resurrects the old key", async () => {
    const { prospectId } = await seedReadyProspect();
    const published = unwrap(await svc.publishAudit(operator, { prospectId }));
    const link = await links.auditLinkForProspect(prospectId);

    unwrap(
      await svc.revokeAudit(operator, {
        auditId: published.auditId,
        reason: "sent to the wrong person",
      })
    );
    expect(await links.resolveAuditLink(link?.key as string)).toBeNull();

    // Republish mints a FRESH key; the burned one stays dead.
    unwrap(await svc.publishAudit(operator, { prospectId }));
    const fresh = await links.auditLinkForProspect(prospectId);
    expect(fresh).not.toBeNull();
    expect(fresh?.key).not.toBe(link?.key);
    expect(await links.resolveAuditLink(link?.key as string)).toBeNull();
    expect(await links.resolveAuditLink(fresh?.key as string)).not.toBeNull();
  });

  it("honors expiry through the same token path as legacy links", async () => {
    const { prospectId } = await seedReadyProspect();
    const published = unwrap(await svc.publishAudit(operator, { prospectId }));
    const link = await links.auditLinkForProspect(prospectId);

    unwrap(await svc.expireAudit(operator, { auditId: published.auditId }));
    const resolved = await links.resolveAuditLink(link?.key as string);
    // The key still maps (the audit is published, merely expired) — and the
    // shared token path refuses it, identically to a legacy link.
    if (resolved) {
      expect(await svc.getAuditByToken(resolved.token, { userAgent: "vitest" })).toBeNull();
    }
  });

  it("re-minting replaces; minting without a published audit refuses", async () => {
    const { prospectId } = await seedReadyProspect();
    const noAudit = await links.mintAuditLink(operator, { prospectId });
    expect(noAudit.ok).toBe(false);

    unwrap(await svc.publishAudit(operator, { prospectId }));
    const first = await links.auditLinkForProspect(prospectId);
    const reminted = unwrap(await links.mintAuditLink(operator, { prospectId }));
    expect(reminted.key).not.toBe(first?.key);
    expect(await links.resolveAuditLink(first?.key as string)).toBeNull();
    const [active] = await sql`
      select count(*)::int as n from prospect_audit_links
      where prospect_id = ${prospectId} and revoked_at is null
    `;
    expect(Number(active?.n)).toBe(1);
  });
});
