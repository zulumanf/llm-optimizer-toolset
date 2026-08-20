/**
 * Spec 095 — the dashboard's honesty rules, against a seeded database:
 * the funnel counts events (not the stage column), script user agents never
 * count as prospect interest, and internal views stay internal.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

describe.skipIf(!TEST_URL)("prospecting dashboard (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let dash: typeof import("@/lib/prospects/dashboard");
  const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
  const P2 = "aaaaaaaa-0000-4000-8000-000000000002";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    dash = await import("@/lib/prospects/dashboard");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);

    // Minimal event graph: two prospects; one contacted+opened+viewed, one
    // untouched. Direct SQL — the aggregations, not the write paths, are
    // under test here (the write paths have their own suites).
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000001', 'M', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values ('cccccccc-0000-4000-8000-000000000001', 'L', 'bbbbbbbb-0000-4000-8000-000000000001', 'researching')`;
    await sql`insert into prospects (id, launch_id, business_name, prospect_type, stage)
      values (${P1}, 'cccccccc-0000-4000-8000-000000000001', 'Hot Co', 'team', 'identified'),
             (${P2}, 'cccccccc-0000-4000-8000-000000000001', 'Cold Co', 'team', 'identified')`;
    // A published audit for P1 needs the FK chain (run → benchmark → finding).
    await sql`insert into projects (id, name) values ('dddddddd-0000-4000-8000-000000000001', 'Proj')`;
    await sql`insert into prompt_sets (id, project_id, name) values ('dddddddd-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000001', 'Set')`;
    await sql`insert into prompt_set_versions (id, prompt_set_id, version, frozen_prompts, frozen_by, frozen_at)
      values ('dddddddd-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000002', 1, '[]'::jsonb,
        '00000000-0000-4000-8000-000000000001', now())`;
    await sql`insert into runs (id, project_id, prompt_set_version_id, label, providers, trigger, budget_usd, status)
      values ('dddddddd-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000001',
        'dddddddd-0000-4000-8000-000000000003', 'dash test', '[]'::jsonb, 'manual', 1, 'completed')`;
    await sql`insert into companies (id, name) values ('dddddddd-0000-4000-8000-000000000005', 'Hot Co')`;
    await sql`insert into prospect_benchmarks (id, prospect_id, run_id, company_id)
      values ('dddddddd-0000-4000-8000-000000000006', ${P1}, 'dddddddd-0000-4000-8000-000000000004', 'dddddddd-0000-4000-8000-000000000005')`;
    await sql`insert into prompts (id, prompt_set_id, text, category, position)
      values ('dddddddd-0000-4000-8000-000000000009', 'dddddddd-0000-4000-8000-000000000002', 'q', 'recommendation', 1)`;
    await sql`insert into responses (id, run_id, prompt_id, prompt_text, provider, model, repetition)
      values ('dddddddd-0000-4000-8000-000000000007', 'dddddddd-0000-4000-8000-000000000004',
        'dddddddd-0000-4000-8000-000000000009', 'q', 'mock', 'm', 1)`;
    await sql`insert into prospect_findings (id, prospect_id, benchmark_id, kind, title, explanation,
        metrics, signal_ids, response_ids, competitor_company_ids, severity, generator_version, status, is_primary)
      values ('dddddddd-0000-4000-8000-000000000008', ${P1}, 'dddddddd-0000-4000-8000-000000000006',
        'absence', 't', 'e', '{}', '{}', array['dddddddd-0000-4000-8000-000000000007']::uuid[], '{}', 'high', 'v', 'approved', true)`;
    await sql`insert into prospect_audits (id, prospect_id, finding_id, headline, access_token, status, snapshot, published_at)
      values ('eeeeeeee-0000-4000-8000-000000000001', ${P1}, 'dddddddd-0000-4000-8000-000000000008',
        'h', 'tok-dashboard-test-000000000000000000000000', 'published', '{}', now())`;
    // An allowed gmail send with an open, plus views: one human, one curl,
    // one internal.
    await sql`insert into outreach_drafts (id, prospect_id, finding_id, channel, body, generated_by, status)
      values ('ffffffff-0000-4000-8000-000000000001', ${P1}, 'dddddddd-0000-4000-8000-000000000008', 'email', 'b', 'operator', 'approved')`;
    await sql`insert into prospect_outreach_sends (id, draft_id, prospect_id, channel, recipient_email,
        body_hash, business_purpose, gate_verdict, allowed, sent_by)
      values ('ffffffff-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000001', ${P1},
        'gmail', 'x@y.com', 'h', 'purpose purpose', '{}', true, '00000000-0000-4000-8000-000000000001')`;
    await sql`insert into outreach_email_opens (send_id, ip, user_agent)
      values ('ffffffff-0000-4000-8000-000000000002', '1.2.3.4', 'GoogleImageProxy')`;
    await sql`insert into prospect_audit_views (audit_id, user_agent, is_internal) values
      ('eeeeeeee-0000-4000-8000-000000000001', 'Mozilla/5.0 (iPhone; like Mac OS X) Safari', false),
      ('eeeeeeee-0000-4000-8000-000000000001', 'curl/8.4.0', false),
      ('eeeeeeee-0000-4000-8000-000000000001', 'Mozilla/5.0', true)`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("the funnel counts events, not the stage column", async () => {
    const funnel = await dash.eventFunnel();
    const byKey = Object.fromEntries(funnel.map((f) => [f.key, f.count]));
    expect(byKey.prospects).toBe(2);
    expect(byKey.published).toBe(1);
    expect(byKey.contacted).toBe(1); // both prospects sit at stage 'identified'
    expect(byKey.opened).toBe(1);
    expect(byKey.viewed).toBe(1);
    expect(byKey.replied).toBe(0);
  });

  it("script and internal views never count as prospect interest", async () => {
    const e = await dash.engagementNow();
    // Three view rows exist; only the human-like external one counts.
    expect(e.viewsTotal).toBe(1);
    expect(e.viewedProspects).toBe(1);
    expect(e.opensTotal).toBe(1);
  });

  it("the action queues surface the hot prospect and the stage drift", async () => {
    const q = await dash.actionQueues();
    expect(q.hot.map((h) => h.businessName)).toContain("Hot Co");
    expect(q.stageDrift).toBe(1); // contacted by ledger, recorded 'identified'
  });

  it("machine health reports the cap and suppressions without error", async () => {
    const h = await dash.machineHealth();
    expect(h.capUsed24h).toBe(1);
    expect(h.capLimit).toBeGreaterThan(0);
    expect(h.activeSuppressions).toBe(0);
  });
});
