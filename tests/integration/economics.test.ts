/** Spec 151 C4/C5: outcome capture and measured unit economics. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { clientViewerUser, operatorUser } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("economics & outcomes (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let econ: typeof import("@/lib/economics/service");
  const user = operatorUser();
  let projectId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    econ = await import("@/lib/economics/service");
  });
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
    const [project] = await sql`insert into projects (name) values ('Econ Client') returning id`;
    projectId = project!.id as string;
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${projectId}, 'S') returning id`;
    const [version] = await sql`insert into prompt_set_versions (prompt_set_id, version, frozen_prompts) values (${set!.id}, 1, '[]') returning id`;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${projectId}, ${version!.id}, 'r', '[]', 'completed', 'manual', 5) returning id
    `;
    for (let i = 0; i < 4; i += 1) {
      await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text, cost_usd, error)
        values (${run!.id}, gen_random_uuid(), 'q', 'openai', 'm', 1, 'a', ${i === 3 ? null : 0.25},
          ${i === 3 ? sql.json({ kind: "provider", message: "x" }) : null})
      `;
    }
    await sql`
      insert into llm_calls (agent_version, model, project_id, tokens_in, tokens_out, cost_micro_usd, attempts, success)
      values ('v', 'm', ${projectId}, 1, 1, 500000, 1, true), ('v', 'm', null, 1, 1, 100000, 1, true)
    `;
    await sql`
      insert into billing_events (project_id, kind, amount_cents, contract_ref)
      values (${projectId}, 'payment_received', 250000, 'ENG-test-1')
    `;
  });

  const today = new Date().toISOString().slice(0, 10);

  it("separates measured, ledger and not-recorded figures; labor is costed only with an explicit rate", async () => {
    expect((await econ.recordLabor(user, { projectId, activity: "report_review", minutes: 90, occurredOn: today })).ok).toBe(true);
    expect((await econ.recordLabor(user, { projectId, activity: "sales_call", minutes: 30, occurredOn: today })).ok).toBe(true);
    expect((await econ.recordLabor(user, { projectId, activity: "support", minutes: -10, occurredOn: today })).ok).toBe(false);

    const noRate = await econ.unitEconomics(user, { from: today, to: today, projectId });
    const p = noRate.projects[0]!;
    expect(p.measurementCostUsd).toEqual({ value: 0.75, source: "measured" });
    expect(p.internalInferenceCostUsd.value).toBeCloseTo(0.5, 6);
    expect(p).toMatchObject({ failedCells: 1, totalCells: 4 });
    expect(p.deliveryHours).toEqual({ value: 1.5, source: "ledger" });
    expect(p.salesHours.value).toBeCloseTo(0.5, 6);
    expect(p.revenueUsd).toEqual({ value: 2500, source: "ledger" });
    expect(p.laborCostUsd).toEqual({ value: null, source: "not_recorded" });
    expect(p.contributionMarginUsd.value).toBeNull();
    expect(noRate.infrastructureCostUsd.source).toBe("not_recorded");
    expect(noRate.unattributedInferenceCostUsd.value).toBeCloseTo(0.1, 6);

    const withRate = await econ.unitEconomics(user, { from: today, to: today, projectId, assumedHourlyRateUsd: 100 });
    expect(withRate.projects[0]!.contributionMarginUsd.value).toBeCloseTo(2500 - 0.75 - 0.5 - 150, 6);
    expect(withRate.assumedHourlyRateUsd).toBe(100);
  });

  it("outcomes are labelled, insert-only, superseded not edited, and never empty", async () => {
    const empty = await econ.recordClientOutcome(user, { projectId, periodStart: "2026-09-01", periodEnd: "2026-09-30", provenance: "self_reported" });
    expect(empty.ok).toBe(false);
    const first = await econ.recordClientOutcome(user, {
      projectId, periodStart: "2026-09-01", periodEnd: "2026-09-30", provenance: "self_reported",
      qualifiedLeads: 7, leadsBySource: { referral: 4, zillow: 2, chatgpt: 1 }, aiDiscoveryMentions: 1,
    });
    if (!first.ok) throw new Error(first.error.message);
    const fix = await econ.recordClientOutcome(user, {
      projectId, periodStart: "2026-09-01", periodEnd: "2026-09-30", provenance: "client_system_export",
      qualifiedLeads: 8, supersedes: first.data.outcomeId,
    });
    expect(fix.ok).toBe(true);
    const rows = await econ.listClientOutcomes(user, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qualifiedLeads: 8, provenance: "client_system_export" });
    await expect(sql`update client_outcomes set qualified_leads = 0`).rejects.toThrow(/insert-only/);
    await expect(econ.listClientOutcomes(clientViewerUser(), projectId)).rejects.toThrow(/not found/i);
  });
});
