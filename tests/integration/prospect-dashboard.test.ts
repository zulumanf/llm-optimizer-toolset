/**
 * Spec 095/098 — the cockpit's honesty rules, against a seeded database:
 * contacted derives from the ledger (not the stage column), script /
 * internal / scanner-window / operator-IP views never count as prospect
 * interest, beacon events attach to the view that rendered the page, and
 * branded-link views are attributed while bare-token views are not.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { startOfOperatorDay } from "@/lib/prospects/intent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

describe.skipIf(!TEST_URL)("prospecting dashboard (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let dash: typeof import("@/lib/prospects/dashboard");
  const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
  const P2 = "aaaaaaaa-0000-4000-8000-000000000002";
  const V_HUMAN = "99999999-0000-4000-8000-000000000001";
  const V_HUMAN2 = "99999999-0000-4000-8000-000000000002";
  const V_CURL = "99999999-0000-4000-8000-000000000003";
  const V_INTERNAL = "99999999-0000-4000-8000-000000000004";
  let beacon: typeof import("@/app/api/audit-signal/route");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    dash = await import("@/lib/prospects/dashboard");
    beacon = await import("@/app/api/audit-signal/route");
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
    // sent_at set at insert (the ledger is insert-only) and backdated an
    // hour so the human view below lands outside the scanner window.
    await sql`insert into prospect_outreach_sends (id, draft_id, prospect_id, channel, recipient_email,
        body_hash, business_purpose, gate_verdict, allowed, sent_by, sent_at)
      values ('ffffffff-0000-4000-8000-000000000002', 'ffffffff-0000-4000-8000-000000000001', ${P1},
        'gmail', 'x@y.com', 'h', 'purpose purpose', '{}', true, '00000000-0000-4000-8000-000000000001',
        now() - interval '1 hour')`;
    await sql`insert into outreach_email_opens (send_id, ip, user_agent)
      values ('ffffffff-0000-4000-8000-000000000002', '1.2.3.4', 'GoogleImageProxy')`;
    // The human view arrived through the branded link (attributed); a
    // second human view 20 minutes later in another session has no key.
    await sql`insert into prospect_audit_views (id, audit_id, viewed_at, user_agent, is_internal, link_key) values
      (${V_HUMAN}, 'eeeeeeee-0000-4000-8000-000000000001', now() - interval '30 minutes', 'Mozilla/5.0 (iPhone; like Mac OS X) Safari', false, 'abcdefghabcdefgh'),
      (${V_HUMAN2}, 'eeeeeeee-0000-4000-8000-000000000001', now() - interval '10 minutes', 'Mozilla/5.0 (Macintosh) Safari', false, null)`;
    await sql`insert into prospect_audit_views (id, audit_id, viewed_at, user_agent, is_internal) values
      (${V_CURL}, 'eeeeeeee-0000-4000-8000-000000000001', now(), 'curl/8.4.0', false),
      (${V_INTERNAL}, 'eeeeeeee-0000-4000-8000-000000000001', now(), 'Mozilla/5.0', true)`;
    // A view recorded BEFORE the send: pre-outreach, never funnel evidence.
    await sql`insert into prospect_audit_views (audit_id, viewed_at, user_agent, is_internal) values
      ('eeeeeeee-0000-4000-8000-000000000001', now() - interval '3 hours', 'Mozilla/5.0 (Windows NT 10.0) Chrome/126', false)`;
    // A view from the operator's declared IP: internal by definition.
    process.env.INTERNAL_VIEW_IPS = "203.0.113.99";
    await sql`insert into prospect_audit_views (audit_id, viewed_at, ip, user_agent, is_internal) values
      ('eeeeeeee-0000-4000-8000-000000000001', now(), '203.0.113.99', 'Mozilla/5.0 (Macintosh) Safari', false)`;
    // A browser-UA view seconds after the send: a mail-provider link
    // scanner, never prospect interest (the send above is stamped now()).
    await sql`insert into prospect_audit_views (audit_id, viewed_at, user_agent, is_internal)
      select 'eeeeeeee-0000-4000-8000-000000000001', s.sent_at + interval '10 seconds',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126', false
      from prospect_outreach_sends s where s.id = 'ffffffff-0000-4000-8000-000000000002'`;
  });

  afterAll(async () => {
    await sql.end();
  });

  const post = (body: unknown) =>
    beacon.POST(new Request("http://test/api/audit-signal", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

  it("the beacon records events against a human view, silently drops everything else", async () => {
    const ok = await post({
      viewId: V_HUMAN, sessionId: "sess-aaaaaaaa", visitorId: "vis-aaaaaaaa",
      events: [
        { kind: "engaged_time", value: 30 }, { kind: "engaged_time", value: 75 },
        { kind: "scroll", value: 50 }, { kind: "scroll", value: 90 },
        { kind: "section_viewed", target: "competitors" }, { kind: "evidence_expanded", target: "prompts" },
      ],
    });
    expect(ok.status).toBe(204);
    // Second session, different browser identity.
    expect((await post({ viewId: V_HUMAN2, sessionId: "sess-bbbbbbbb", visitorId: "vis-bbbbbbbb", events: [{ kind: "scroll", value: 25 }] })).status).toBe(204);
    // Internal view, unknown view, malformed body, bad kind: 204 and nothing written.
    expect((await post({ viewId: V_INTERNAL, sessionId: "sess-cccccccc", events: [{ kind: "scroll", value: 25 }] })).status).toBe(204);
    expect((await post({ viewId: "99999999-0000-4000-8000-00000000ffff", sessionId: "sess-cccccccc", events: [{ kind: "scroll", value: 25 }] })).status).toBe(204);
    expect((await post("{not json")).status).toBe(204);
    expect((await post({ viewId: V_HUMAN, sessionId: "sess-cccccccc", events: [{ kind: "heatmap", value: 1 }] })).status).toBe(204);
    const [cnt] = await sql`select count(*)::int as n from prospect_audit_engagement_events`;
    expect(cnt?.n).toBe(7);
    const [internal] = await sql`select count(*)::int as m from prospect_audit_engagement_events where view_id = ${V_INTERNAL}`;
    expect(internal?.m).toBe(0);
  });

  it("per-prospect facts: contacted from the ledger, only human post-outreach views, beacon aggregates attached", async () => {
    const facts = await dash.prospectFacts();
    const hot = facts.find((f) => f.prospectId === P1)!;
    const cold = facts.find((f) => f.prospectId === P2)!;
    expect(hot.sentAts).toHaveLength(1);
    expect(hot.stage).toBe("identified"); // stage column lags; contact is still a fact
    expect(hot.opens).toBe(1);
    // 7 view rows exist; the 2 human-like external ones + the pre-outreach one survive the filter.
    expect(hot.views).toHaveLength(3);
    const attributed = hot.views.find((v) => v.linkKey !== null)!;
    expect(attributed.sessionId).toBe("sess-aaaaaaaa");
    expect(attributed.engagedSeconds).toBe(75);
    expect(attributed.maxScrollPercent).toBe(90);
    expect(attributed.sectionsViewed).toEqual(["competitors"]);
    expect(attributed.evidenceExpanded).toBe(true);
    expect(cold.views).toHaveLength(0);
    expect(cold.sentAts).toHaveLength(0);
  });

  it("the cockpit derives the cohort and ranks the engaged prospect first", async () => {
    const c = await dash.cockpit();
    expect(c.cohort.contacted).toBe(1);
    expect(c.cohort.viewed).toBe(1);
    expect(c.cohort.engaged).toBe(1);
    expect(c.cohort.replied).toBe(0);
    expect(c.cohort.auditViews).toBe(2);
    expect(c.cohort.auditSessions).toBe(2);
    expect(c.cohort.auditVisitorIdentities).toBe(2);
    expect(c.cohort.preOutreachViews).toBe(1);
    expect(c.cohort.attributedLinkProspects).toBe(1);
    expect(c.stageDrift).toBe(1);
    expect(c.cohort.diagnosis.verdict).toBe("not_enough_data");
    const [first, second] = c.prospects;
    expect(first!.businessName).toBe("Hot Co");
    expect(first!.engagement.repeat).toBe(true);
    expect(first!.engagement.possibleAdditionalVisitor).toBe(true);
    expect(first!.engagement.attribution).toBe("attributed_link");
    expect(first!.intentLabel).toBe("Engaged");
    expect(first!.intentScore).toBe(10); // spec 099: multiple sessions +1, not +3
    expect(second!.businessName).toBe("Cold Co");
    expect(second!.priorityTier).toBe(9);
  });

  it("the window lens cuts sends and views; the timeline labels pre-outreach and repeat visits", async () => {
    const today = await dash.cockpit({ window: "today" });
    // The seeded send is an hour old; "today" is the operator's (ET) day,
    // so within the first hour after midnight ET it legitimately falls out.
    const sentAt = new Date(Date.now() - 3_600_000);
    expect(today.cohort.contacted).toBe(sentAt >= startOfOperatorDay(new Date()) ? 1 : 0);
    const timeline = await dash.prospectTimeline(P1);
    const labels = timeline.map((t) => t.label);
    expect(labels[0]).toBe("Audit visit (before outreach)");
    expect(labels).toContain("Email sent");
    expect(labels).toContain("First qualifying post-outreach audit visit · via emailed link");
    expect(labels).toContain("Repeat audit session");
    expect(labels.filter((l) => l === "Reached 90% depth")).toHaveLength(1);
    expect(labels).toContain("Expanded supporting evidence");
  });

  it("machine health reports the cap, suppressions, and the research queue", async () => {
    const h = await dash.machineHealth();
    expect(h.capUsed24h).toBe(1);
    expect(h.capLimit).toBeGreaterThan(0);
    expect(h.activeSuppressions).toBe(0);
    expect(h.researchQueue.map((r) => r.businessName)).toEqual(["Hot Co"]);
  });
});
