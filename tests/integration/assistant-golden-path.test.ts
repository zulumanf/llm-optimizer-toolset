/**
 * Spec 096 golden path: the WHOLE prospecting chain walked through the
 * assistant loop — installed pack → bootstrap → estimate → confirmed run →
 * executed run → discovery. This test exists because the chain stalled
 * live at a missing rung (no path from installed pack to a run): coverage
 * of the JOURNEY, not just each tool. Anyone who adds a stage without its
 * connecting tool breaks this in CI before an operator ever hits it.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
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

const scripted = (steps: object[]): AgentCaller => {
  let i = 0;
  return async () => ({
    text: JSON.stringify(steps[Math.min(i++, steps.length - 1)]),
    tokensIn: 100,
    tokensOut: 20,
  });
};

const PACK = {
  key: "goldenville",
  version: 1,
  cityName: "Goldenville",
  hierarchy: { name: "Goldenville", kind: "city", children: [] },
  zipCodes: [],
  propertyTypes: ["condo"],
  primaryPropertyTypes: ["condo"],
  priceTiers: [],
  buyerSegments: [],
  sellerSegments: [],
  terminology: {},
  brokerages: ["Golden Realty"],
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
  ],
};

describe.skipIf(!TEST_URL)("assistant golden path (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let assistant: typeof import("@/lib/assistant/service");
  let confirm: typeof import("@/lib/assistant/confirm");
  let jobs: typeof import("@/db/jobs");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let mock: typeof import("@/lib/ai/mock");
  const LAUNCH = "cccccccc-0000-4000-8000-000000000031";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    assistant = await import("@/lib/assistant/service");
    confirm = await import("@/lib/assistant/confirm");
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
    // The chain starts from an INSTALLED pack (research_market itself is
    // network-bound and covered by its own suite with an injected caller).
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000031', 'Goldenville', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values (${LAUNCH}, 'Goldenville — luxury residential', 'bbbbbbbb-0000-4000-8000-000000000031', 'researching')`;
    await sql`insert into market_pack_drafts (city_name, payload, citations, model, agent_version, status, created_by)
      values ('Goldenville', ${sql.json(PACK as never)}, '[]'::jsonb, 'test', 'test-v1', 'installed', ${operator.id})`;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const job = await jobs.claimNextJob("golden-worker");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  it("walks installed pack → bootstrap → estimate → confirmed run → discovery without a human ever supplying an id", async () => {
    // 1. Bootstrap via the loop: launch id in, run plumbing out.
    const boot = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "get Goldenville ready to benchmark" },
        scripted([
          { action: "tool", tool: "bootstrap_market_benchmark", input: { launch_id: LAUNCH } },
          { action: "answer", answer: "Bootstrapped." },
        ])
      )
    );
    if (!boot.toolCalls[0]!.ok) throw new Error(`bootstrap failed: ${boot.toolCalls[0]!.summary}`);
    const plumbing = JSON.parse(
      boot.toolCalls[0]!.summary.replace(/… \(truncated\)$/, "")
    ) as { projectId: string; promptSetVersionId: string; promptCount: number };
    expect(plumbing.promptCount).toBeGreaterThan(0);

    // 2. Estimate via the loop (dry run — spends nothing).
    const providers = [{ provider: "mock", model: "mock-model", repetitions: 2 }];
    const est = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "estimate it", conversationId: boot.conversationId },
        scripted([
          {
            action: "tool",
            tool: "estimate_benchmark_run",
            input: {
              project_id: plumbing.projectId,
              prompt_set_version_id: plumbing.promptSetVersionId,
              providers,
              budget_usd: 5,
              label: "Goldenville golden path",
            },
          },
          { action: "answer", answer: "Estimated." },
        ])
      )
    );
    if (!est.toolCalls[0]!.ok) throw new Error(`estimate failed: ${est.toolCalls[0]!.summary}`);

    // 3. The live run is confirm-gated: the loop stages it, the human click
    //    executes it — same machinery the dock button uses.
    const staged = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "run it", conversationId: boot.conversationId },
        scripted([
          {
            action: "tool",
            tool: "start_benchmark_run",
            input: {
              project_id: plumbing.projectId,
              prompt_set_version_id: plumbing.promptSetVersionId,
              providers,
              budget_usd: 5,
              label: "Goldenville golden path",
            },
          },
          { action: "answer", answer: "Waiting on your confirm." },
        ])
      )
    );
    expect(staged.pendingActions.length).toBe(1);
    unwrap(
      await confirm.confirmAssistantAction(operator, {
        token: staged.pendingActions[0]!.token,
      })
    );
    await drainJobs(); // the worker executes, parses, scores

    const [run] = await sql`
      select id, status from runs where project_id = ${plumbing.projectId}
      order by started_at desc nulls last limit 1
    `;
    expect(run?.status).toBe("completed");

    // 4. Discovery now has answers to scan — the exact call that failed
    //    live with "Invalid discovery request" before the bootstrap rung.
    const disco = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "find the teams", conversationId: boot.conversationId },
        scripted([
          {
            action: "tool",
            tool: "run_discovery",
            input: { launch_id: LAUNCH, provider: "mock", limit: 15 },
          },
          { action: "answer", answer: "Discovery done." },
        ])
      )
    );
    if (!disco.toolCalls[0]!.ok) throw new Error(`discovery failed: ${disco.toolCalls[0]!.summary}`);
  }, 120_000);
});
