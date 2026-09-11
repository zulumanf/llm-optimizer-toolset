/**
 * Spec 097 — the A→Z city prospecting pipeline as a state machine: budget
 * refusal before any spend, then the full walk (existing launch → discovery
 * via an injected source → confidence-gated seeding → benchmark within
 * budget → run completes → prospects linked and scored) driven only by
 * advanceCityPipelines(), the exact function the worker tick calls.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const PACK = {
  key: "mockington",
  version: 1,
  cityName: "Mockington",
  hierarchy: { name: "Mockington", kind: "city", children: [] },
  zipCodes: [],
  propertyTypes: ["condo"],
  primaryPropertyTypes: ["condo"],
  priceTiers: [],
  buyerSegments: [],
  sellerSegments: [],
  terminology: {},
  brokerages: ["Mock Realty"],
  publications: [],
  excludedPlaceNames: [],
  templates: [
    {
      key: "best-agent",
      text: "Who is the best real estate agent in {city}?",
      category: "recommendation",
      tier: 1,
      audience: "buyer",
      scope: "city",
    },
    {
      key: "sell-with",
      text: "Which team should I sell my {city} home with?",
      category: "recommendation",
      tier: 1,
      audience: "seller",
      scope: "city",
    },
  ],
};

describe.skipIf(!TEST_URL)("city prospecting pipeline (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let pipeline: typeof import("@/lib/prospects/city-pipeline");
  let registry: typeof import("@/lib/prospects/providers/registry");
  let jobs: typeof import("@/db/jobs");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let mock: typeof import("@/lib/ai/mock");

  async function seedCompletedRun(providers: object[], id: string): Promise<void> {
    await sql`insert into projects (id, name) values (${id}, ${"seed " + id})`;
    await sql`insert into prompt_sets (id, project_id, name) values (${id.replace("1", "2")}, ${id}, 'seed set')`;
    await sql`insert into prompt_set_versions (id, prompt_set_id, version, frozen_prompts, frozen_by, frozen_at)
      values (${id.replace("1", "3")}, ${id.replace("1", "2")}, 1, '[]'::jsonb, ${operator.id}, now())`;
    await sql`insert into runs (id, project_id, prompt_set_version_id, label, providers, trigger, budget_usd, status, completed_at)
      values (${id.replace("1", "4")}, ${id}, ${id.replace("1", "3")}, 'seed run',
        ${sql.json(providers as never)}, 'manual', 5, 'completed', now())`;
  }

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("pipeline-worker");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    pipeline = await import("@/lib/prospects/city-pipeline");
    registry = await import("@/lib/prospects/providers/registry");
    jobs = await import("@/db/jobs");
    execute = await import("@/lib/runs/execute");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    mock.resetMockProvider();

    // City exists (installed pack + launch) so the pipeline's installing
    // step short-circuits — research itself is network-bound and covered
    // by its own suite.
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000041', 'Mockington', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values ('cccccccc-0000-4000-8000-000000000041', 'Mockington — luxury residential', 'bbbbbbbb-0000-4000-8000-000000000041', 'researching')`;
    await sql`insert into market_pack_drafts (city_name, payload, citations, model, agent_version, status, created_by)
      values ('Mockington', ${sql.json(PACK as never)}, '[]'::jsonb, 'test', 'test-v1', 'installed', ${operator.id})`;
    // A second city for the budget-refusal test, so its partial progress
    // (discovery/seeding run before the estimate refusal) never pollutes
    // the A→Z walk's assertions.
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000042', 'Failville', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values ('cccccccc-0000-4000-8000-000000000042', 'Failville — luxury residential', 'bbbbbbbb-0000-4000-8000-000000000042', 'researching')`;
    await sql`insert into market_pack_drafts (city_name, payload, citations, model, agent_version, status, created_by)
      values ('Failville', ${sql.json({ ...PACK, key: "failville", cityName: "Failville", hierarchy: { name: "Failville", kind: "city", children: [] } } as never)}, '[]'::jsonb, 'test', 'test-v1', 'installed', ${operator.id})`;

    // Injected discovery source: two candidates straddling the threshold.
    registry.setProspectSourceForTests("perplexity", {
      id: "perplexity",
      discoverProspects: async () => [
        {
          provider: "perplexity",
          sourceType: "search",
          sourceUrl: "https://example.test/realtrends",
          retrievedAt: new Date().toISOString(),
          confidence: 0.9,
          provenance: "ai_inferred",
          data: { businessName: "Mockington Top Team" },
        },
        {
          provider: "perplexity",
          sourceType: "search",
          sourceUrl: "https://example.test/realtrends",
          retrievedAt: new Date().toISOString(),
          confidence: 0.4,
          provenance: "ai_inferred",
          data: { businessName: "Maybe A Team" },
        },
      ],
    } as never);
  });

  afterAll(async () => {
    registry.setProspectSourceForTests("perplexity", null as never);
    await sql.end();
  });

  it("refuses a run whose estimate exceeds the confirmed budget — nothing spends", async () => {
    // Newest completed run carries an expensively-priced real model; the
    // pipeline copies that config, estimates, and must refuse the $0.01 cap.
    await seedCompletedRun(
      [{ provider: "anthropic", model: "claude-opus-5", repetitions: 4 }],
      "11111111-0000-4000-8000-000000000001"
    );
    const started = unwrap(
      await pipeline.startCityProspecting(operator, {
        cityName: "Failville",
        state: "Delaware",
        targetProspects: 5,
        budgetUsd: 0.01,
      })
    );
    for (let i = 0; i < 8; i += 1) await pipeline.advanceCityPipelines();
    const row = await pipeline.getCityProspecting(started.pipelineId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/exceeds the confirmed budget/);
    const [runs] = await sql`select count(*)::int as n from runs where label like 'City prospecting%'`;
    expect(runs?.n).toBe(0);
  });

  it("walks A→Z: discovery → gated seeding → budgeted benchmark → scoring", async () => {
    // A newer completed run with the mock provider becomes the copied config.
    await seedCompletedRun(
      [{ provider: "mock", model: "mock-model", repetitions: 3 }],
      "11111111-0000-4000-8000-000000000011"
    );
    const started = unwrap(
      await pipeline.startCityProspecting(operator, {
        cityName: "Mockington",
        state: "Delaware",
        targetProspects: 5,
        budgetUsd: 5,
      })
    );

    // Tick until the run is started (installing→discovering→seeding→benchmarking).
    for (let i = 0; i < 8; i += 1) await pipeline.advanceCityPipelines();
    let row = await pipeline.getCityProspecting(started.pipelineId);
    if (row?.status === "failed") throw new Error(`pipeline failed: ${row.error}`);
    expect(row?.status).toBe("running");

    // Only the high-confidence candidate became a prospect.
    const prospects = await sql`
      select business_name from prospects
      where launch_id = 'cccccccc-0000-4000-8000-000000000041' and archived_at is null
    `;
    expect(prospects.map((p) => p.businessName)).toEqual(["Mockington Top Team"]);
    const [staged] = await sql`
      select count(*)::int as n from prospect_discovery_candidates
      where status = 'pending' and launch_id = 'cccccccc-0000-4000-8000-000000000041'
    `;
    expect(staged?.n).toBe(1); // the 0.4 candidate awaits the human (Failville's own stays on its launch)

    // The worker completes the run; the next ticks score and finish.
    await drainJobs();
    for (let i = 0; i < 4; i += 1) await pipeline.advanceCityPipelines();
    row = await pipeline.getCityProspecting(started.pipelineId);
    expect(row?.status).toBe("completed");
    expect(row?.log.map((l) => l.step)).toContain("scoring");

    const [linked] = await sql`
      select count(*)::int as n from prospect_benchmarks b
      join prospects p on p.id = b.prospect_id
      where p.launch_id = 'cccccccc-0000-4000-8000-000000000041'
    `;
    expect(linked?.n).toBe(1);
    const [findings] = await sql`
      select count(*)::int as n from prospect_findings f
      join prospects p on p.id = f.prospect_id
      where p.launch_id = 'cccccccc-0000-4000-8000-000000000041' and f.status = 'candidate'
    `;
    expect(findings?.n).toBeGreaterThan(0);

    // Idempotent when done: another advance changes nothing.
    const report = await pipeline.advanceCityPipelines();
    expect(report.advanced + report.waiting + report.failed).toBe(0);
  });

  it("spec 102: retry resumes a failed pipeline at the status it failed from", async () => {
    const failed = await pipeline.getCityProspecting("Failville");
    expect(failed?.status).toBe("failed");
    expect(failed?.failedFromStatus).toBe("benchmarking");

    // Guard: a completed pipeline cannot be retried.
    const done = await pipeline.getCityProspecting("Mockington");
    const refused = await pipeline.retryCityProspecting(operator, { pipelineId: done!.id });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("conflict");

    const retried = unwrap(
      await pipeline.retryCityProspecting(operator, { pipelineId: failed!.id })
    );
    expect(retried.resumedFrom).toBe("benchmarking");
    const row = await pipeline.getCityProspecting(failed!.id);
    expect(row?.status).toBe("benchmarking");
    expect(row?.error).toBeNull();
    expect(row?.failedFromStatus).toBeNull();
    expect(row?.log.map((l) => l.step)).toContain("retried");
  });

  it("spec 102: a confirmed cancel ends the pipeline, and the city can start fresh afterwards", async () => {
    const active = await pipeline.getCityProspecting("Failville");
    expect(active?.status).toBe("benchmarking");

    // Through the human gate, exactly as the dock's Confirm click executes it.
    const confirm = await import("@/lib/assistant/confirm");
    const [conv] = await sql`
      insert into assistant_conversations (user_id, title)
      values (${operator.id}, 'cancel test') returning id
    `;
    const pendingAction = await confirm.mintPendingAction(
      operator,
      conv!.id as string,
      "cancel_city_pipeline",
      { pipeline_id: active!.id, reason: "Budget was set far too low." }
    );
    // Minting executed nothing.
    expect((await pipeline.getCityProspecting(active!.id))?.status).toBe("benchmarking");
    unwrap(await confirm.confirmAssistantAction(operator, { token: pendingAction.token }));

    const cancelled = await pipeline.getCityProspecting(active!.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toContain("too low");
    expect(cancelled?.log.map((l) => l.step)).toContain("cancelled");

    // Cancel is terminal: a second cancel refuses.
    const again = await pipeline.cancelCityProspecting(operator, {
      pipelineId: active!.id,
      reason: "Cancelling twice.",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe("conflict");

    // A cancelled city no longer blocks a fresh kickoff.
    const restarted = unwrap(
      await pipeline.startCityProspecting(operator, {
        cityName: "Failville",
        state: "Delaware",
        targetProspects: 5,
        budgetUsd: 5,
      })
    );
    unwrap(
      await pipeline.cancelCityProspecting(operator, {
        pipelineId: restarted.pipelineId,
        reason: "Just proving restart works.",
      })
    );
  });

  it("spec 102: cancelling a running pipeline stops its in-flight benchmark run's spend", async () => {
    await seedCompletedRun(
      [{ provider: "mock", model: "mock-model", repetitions: 3 }],
      "11111111-0000-4000-8000-000000000031"
    );
    const runId = "41111111-0000-4000-8000-000000000031";
    await sql`update runs set status = 'running', completed_at = null where id = ${runId}`;
    const [row] = await sql`
      insert into city_prospecting_pipelines (city_name, state_name, status, run_id, requested_by)
      values ('Runville', 'Delaware', 'running', ${runId}, ${operator.id})
      returning id
    `;
    const cancelled = unwrap(
      await pipeline.cancelCityProspecting(operator, {
        pipelineId: row!.id as string,
        reason: "Operator abort while running.",
      })
    );
    expect(cancelled.runOutcome).toContain("cancelled");
    const [run] = await sql`select status, status_detail from runs where id = ${runId}`;
    expect(run?.status).toBe("partial");
    expect(run?.statusDetail).toBe("cancelled");
  });

  it("spec 102: a pre-102 failure (no failed_from_status) retries at the derived status", async () => {
    const [row] = await sql`
      insert into city_prospecting_pipelines
        (city_name, state_name, status, launch_id, error, requested_by)
      values ('Legacyville', 'Delaware', 'failed', 'cccccccc-0000-4000-8000-000000000041',
        'legacy failure', ${operator.id})
      returning id
    `;
    const retried = unwrap(
      await pipeline.retryCityProspecting(operator, { pipelineId: row!.id as string })
    );
    expect(retried.resumedFrom).toBe("discovering"); // launch exists, no version/run yet
    unwrap(
      await pipeline.cancelCityProspecting(operator, {
        pipelineId: row!.id as string,
        reason: "Cleanup after derivation check.",
      })
    );
  });

  it("spec 102: the list answers 'what pipelines are there?' and the tick ignores cancelled rows", async () => {
    const all = await pipeline.listCityPipelines("all", 50);
    expect(all.pipelines.length).toBeGreaterThanOrEqual(5);
    expect(all.omitted).toBe(0);
    const cancelled = await pipeline.listCityPipelines("cancelled", 50);
    expect(cancelled.pipelines.length).toBeGreaterThanOrEqual(4);
    expect(cancelled.pipelines.every((p) => p.status === "cancelled")).toBe(true);
    expect(cancelled.pipelines[0]!.logTail.length).toBeGreaterThan(0);
    const capped = await pipeline.listCityPipelines("all", 1);
    expect(capped.pipelines.length).toBe(1);
    expect(capped.omitted).toBe(all.pipelines.length - 1);

    // Everything is now terminal — the tick has nothing to pick up.
    const report = await pipeline.advanceCityPipelines();
    expect(report.advanced + report.waiting + report.failed).toBe(0);
  });

  it("the assistant confirm summary states city, target, and budget", async () => {
    const { getAssistantTool } = await import("@/lib/assistant/tools");
    const tool = getAssistantTool("run_city_prospecting")!;
    const summary = tool.summarize!({
      city_name: "Wilmington",
      state: "Delaware",
      target_prospects: 15,
      budget_usd: 10,
    });
    expect(summary).toContain("Wilmington");
    expect(summary).toContain("15");
    expect(summary).toContain("$10");
  });
});
