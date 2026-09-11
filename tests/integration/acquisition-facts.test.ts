/**
 * Acquisition facts against a migrated database: Touch 1 identity follows
 * the draft chain but a founder reply chained to the snapshot is not a
 * second Touch 1; Era 1 is separated; a sequence-less positive reply still
 * surfaces; QA fixtures never count as clients.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

describe.skipIf(!TEST_URL)("acquisition facts (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let facts: typeof import("@/lib/prospects/acquisition-facts");
  let derive: typeof import("@/lib/prospects/acquisition");
  const ACTOR = "00000000-0000-4000-8000-000000000001";
  const P1 = "aaaaaaaa-0000-4000-8000-000000000011";
  const P2 = "aaaaaaaa-0000-4000-8000-000000000012";
  const PF = "aaaaaaaa-0000-4000-8000-000000000013";
  const M = "bbbbbbbb-0000-4000-8000-000000000011";
  const MF = "bbbbbbbb-0000-4000-8000-000000000012";
  const L = "cccccccc-0000-4000-8000-000000000011";
  const LF = "cccccccc-0000-4000-8000-000000000012";
  const PROJ = "dddddddd-0000-4000-8000-000000000011";
  const PROJF = "dddddddd-0000-4000-8000-000000000012";
  const COMP = "dddddddd-0000-4000-8000-000000000015";
  const RIVAL = "dddddddd-0000-4000-8000-000000000016";
  const RUN = "dddddddd-0000-4000-8000-000000000014";
  const FINDING = "dddddddd-0000-4000-8000-000000000018";
  const D1 = "ffffffff-0000-4000-8000-000000000011";
  const D2 = "ffffffff-0000-4000-8000-000000000012";
  const D3 = "ffffffff-0000-4000-8000-000000000013";
  const S1 = "ffffffff-0000-4000-8000-000000000021";
  const S2 = "ffffffff-0000-4000-8000-000000000022";
  const S3 = "ffffffff-0000-4000-8000-000000000023";
  const R1 = "ffffffff-0000-4000-8000-000000000031";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    facts = await import("@/lib/prospects/acquisition-facts");
    derive = await import("@/lib/prospects/acquisition");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);

    await sql`insert into markets (id, name, kind) values (${M}, 'Raleigh', 'city'), (${MF}, 'QA131 Sandbox Market', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values (${L}, 'Raleigh — luxury residential', ${M}, 'researching'), (${LF}, 'QA131 launch', ${MF}, 'researching')`;
    await sql`insert into companies (id, name) values (${COMP}, 'Steve Wall'), (${RIVAL}, 'Rival Team')`;
    await sql`insert into prospects (id, launch_id, business_name, prospect_type, stage, company_id)
      values (${P1}, ${L}, 'Steve Wall', 'individual_agent', 'replied', ${COMP}),
             (${P2}, ${L}, 'Old Era Co', 'team', 'contacted', null),
             (${PF}, ${LF}, 'QA131 Fixture Team', 'team', 'contracted', null)`;
    await sql`insert into projects (id, name) values (${PROJ}, 'Real Client'), (${PROJF}, 'QA131 Fixture Team')`;
    await sql`insert into prompt_sets (id, project_id, name) values ('dddddddd-0000-4000-8000-000000000022', ${PROJ}, 'Set')`;
    await sql`insert into prompt_set_versions (id, prompt_set_id, version, frozen_prompts, frozen_by, frozen_at)
      values ('dddddddd-0000-4000-8000-000000000023', 'dddddddd-0000-4000-8000-000000000022', 1, '[]'::jsonb, ${ACTOR}, now())`;
    await sql`insert into runs (id, project_id, prompt_set_version_id, label, providers, trigger, budget_usd, status, cost_usd)
      values (${RUN}, ${PROJ}, 'dddddddd-0000-4000-8000-000000000023', 'acq test', '[]'::jsonb, 'manual', 1, 'completed', 3.5)`;
    await sql`insert into prospect_benchmarks (id, prospect_id, run_id, company_id)
      values ('dddddddd-0000-4000-8000-000000000026', ${P1}, ${RUN}, ${COMP})`;
    await sql`insert into prompts (id, prompt_set_id, text, category, position)
      values ('dddddddd-0000-4000-8000-000000000029', 'dddddddd-0000-4000-8000-000000000022', 'q', 'recommendation', 1)`;
    await sql`insert into responses (id, run_id, prompt_id, prompt_text, provider, model, repetition)
      values ('dddddddd-0000-4000-8000-000000000027', ${RUN}, 'dddddddd-0000-4000-8000-000000000029', 'q', 'openai', 'm', 1)`;
    await sql`insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review)
      values ('dddddddd-0000-4000-8000-000000000027', ${RIVAL}, 1, true, true, 'v', 1, false)`;
    await sql`insert into prospect_findings (id, prospect_id, benchmark_id, kind, title, explanation,
        metrics, signal_ids, response_ids, competitor_company_ids, severity, generator_version, status, is_primary)
      values (${FINDING}, ${P1}, 'dddddddd-0000-4000-8000-000000000026', 'absence', 't', 'e', '{}', '{}',
        array['dddddddd-0000-4000-8000-000000000027']::uuid[], '{}', 'high', 'v', 'approved', true)`;
    const snapshot = {
      templateVersion: "competitive_mismatch_reply_v1", runId: RUN, provider: "openai", answerCount: 256, modelCount: 1,
      capturedAt: null, completedAt: null, scopeCopy: "", audiences: [], metricType: "closed_volume",
      prospect: { companyId: COMP, prospectId: P1, name: "Steve Wall", recommendationCount: 1, productionSignalId: "x", productionSourceUrl: "", productionYear: 2025, productionValue: 74, productionDisplay: "$74M" },
      competitor: { companyId: RIVAL, prospectId: null, name: "Rival Team", recommendationCount: 14, productionSignalId: "y", productionSourceUrl: "", productionYear: 2025, productionValue: 40, productionDisplay: "$40M", productionRatio: 0.54, recommendationGap: 13 },
      thresholds: { minRecommendationGap: 2, maxCompetitorProductionRatio: 0.9, maxBenchmarkAgeDays: 14 },
    };
    // Touch 1 with frozen evidence, then its em-dash rewrite (no snapshot, no
    // template version) which is the draft actually sent.
    await sql`insert into outreach_drafts (id, prospect_id, finding_id, channel, body, generated_by, status, prompt_version, evidence_snapshot)
      values (${D1}, ${P1}, ${FINDING}, 'email', 'b', 'system', 'superseded', 'competitive_mismatch_reply_v1', ${sql.json(snapshot as never)})`;
    await sql`insert into outreach_drafts (id, prospect_id, finding_id, channel, body, generated_by, status, parent_id, version)
      values (${D2}, ${P1}, ${FINDING}, 'email', 'b2', 'system', 'approved', ${D1}, 2)`;
    await sql`insert into prospect_outreach_sends (id, draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose, gate_verdict, allowed, sent_by, sent_at)
      values (${S1}, ${D2}, ${P1}, 'gmail', 'steve@example.com', 'h', 'purpose purpose', '{}', true, ${ACTOR}, now() - interval '3 days')`;
    // The positive reply asking for pricing, and the founder's reply whose
    // draft chain reaches the same snapshot (the learning-log duplicate).
    await sql`insert into prospect_replies (id, prospect_id, send_id, body_text, received_at, classification, classifier_version, recorded_by)
      values (${R1}, ${P1}, ${S1}, 'Yes, spell out your pricing.', now() - interval '2 days', 'positive_interest', 'test', ${ACTOR})`;
    await sql`insert into outreach_drafts (id, prospect_id, finding_id, channel, body, generated_by, status, parent_id, version, reply_to_id)
      values (${D3}, ${P1}, ${FINDING}, 'email', 'Pricing: $7,500/month for 3 months', 'operator', 'approved', ${D2}, 3, ${R1})`;
    await sql`insert into prospect_outreach_sends (id, draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose, gate_verdict, allowed, sent_by, sent_at)
      values (${S2}, ${D3}, ${P1}, 'gmail', 'steve@example.com', 'h2', 'purpose purpose', '{}', true, ${ACTOR}, now() - interval '1 day')`;
    // Era 1: a plain reply-first send with no frozen evidence anywhere.
    await sql`insert into outreach_drafts (id, prospect_id, finding_id, channel, body, generated_by, status, prompt_version)
      values ('ffffffff-0000-4000-8000-000000000014', ${P2}, ${FINDING}, 'email', 'old', 'system', 'approved', 'reply-first-email-v1')`;
    await sql`insert into prospect_outreach_sends (id, draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose, gate_verdict, allowed, sent_by, sent_at)
      values (${S3}, 'ffffffff-0000-4000-8000-000000000014', ${P2}, 'gmail', 'old@example.com', 'h3', 'purpose purpose', '{}', true, ${ACTOR}, now() - interval '10 days')`;
    // Two signed engagements: one real, one QA fixture.
    await sql`insert into client_engagements (project_id, prospect_id, market_id, starts_on, ends_on, renewal_review_on, monthly_fee_usd, total_value_usd, contract_status, contract_ref, contract_signed_at)
      values (${PROJ}, ${P1}, ${M}, '2026-10-01', '2026-12-31', '2026-12-01', 7500, 22500, 'signed', 'ref-1', now()),
             (${PROJF}, ${PF}, ${MF}, '2026-10-01', '2026-12-31', '2026-12-01', 1, 3, 'signed', 'ref-qa', now())`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("identifies Touch 1 through the draft chain, excludes the founder reply, separates Era 1 and ignores fixture clients", async () => {
    const f = await facts.acquisitionFacts();
    expect(f.t1.map((x) => x.prospectId)).toEqual([P1]);
    expect(f.t1[0]).toMatchObject({ recsProspect: 1, recsCompetitor: 14, competitorCompanyId: RIVAL, runId: RUN, bounced: false });
    expect(f.touchSends.map((s) => [s.kind, s.offerPresented])).toEqual([["FOUNDER", true]]);
    expect(f.era1).toMatchObject({ prospects: 1, sends: 1 });
    expect(f.clientsWon).toBe(1);
    expect(f.benchmarkSpendUsd).toBe(3.5);
    expect(f.competitorRanks).toEqual([{ runId: RUN, companyId: RIVAL, rank: 1 }]);
    expect(f.sequences).toEqual([]);

    const p = derive.deriveAcquisition(f, new Date());
    expect(p.hero).toMatchObject({ uniqueT1: 1, deliveredT1: 1, clientsWon: 1 });
    expect(p.hero.sends).toMatchObject({ t1: 1, t2: 0, t3: 0, founder: 1, corrections: 0 });
    expect(p.hero.positiveReplies).toEqual({ n: 1, of: 1, rate: 1 });
    // No sequence row, still a live high-intent opportunity (pricing asked, offer sent).
    expect(p.opportunities.map((o) => [o.businessName, o.replyType])).toEqual([["Steve Wall", "HIGH_INTENT"]]);
    expect(p.funnel.find((r) => r.key === "offer")!.count).toBe(1);
    expect(p.eras.map((e) => e.uniqueProspects)).toEqual([1, 1]);
  });
});
