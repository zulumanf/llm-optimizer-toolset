/**
 * Evidence-before-cost (production-readiness plan 2.6): a successful provider
 * call whose model lost its pricing row mid-run must keep its raw payload —
 * captured with cost NULL, never $0, never discarded as an error — and the
 * run must stop launching further unpriceable calls.
 *
 * Run creation validates pricing, so this state is only reachable when the
 * pricing table regresses between validation and execution — exactly what
 * the mock below simulates.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

vi.mock("@/lib/ai/pricing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/pricing")>();
  return {
    ...real,
    costMicroUsd: () => {
      throw new Error('No pricing entry for model "mock-model" (simulated regression)');
    },
  };
});

const TEST_URL = process.env.TEST_DATABASE_URL;

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ef",
  email: "op@test.local",
  name: "Op",
  role: "operator",
};

describe.skipIf(!TEST_URL)("unpriced capture (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    await seedTestActors(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("captures the payload with NULL cost and halts instead of discarding evidence", async () => {
    const projectSvc = await import("@/lib/projects/service");
    const setSvc = await import("@/lib/prompts/set-service");
    const promptSvc = await import("@/lib/prompts/prompt-service");
    const runSvc = await import("@/lib/runs/service");
    const execute = await import("@/lib/runs/execute");

    const project = await projectSvc.createProject(operator, { name: "Unpriced" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(operator, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(operator, {
      setId: set.data.id,
      text: "What are the best tools?",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(operator, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(operator, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
      label: "unpriced run",
    });
    if (!started.ok) throw new Error(started.error.message);

    await execute.executeRun(started.data.id);

    const responses = await sql`
      select raw_payload, cost_usd, error from responses
      where run_id = ${started.data.id}
    `;
    // At least one call was captured, none were recorded as errors, and
    // every captured cost is NULL — unknown, not zero.
    expect(responses.length).toBeGreaterThan(0);
    for (const row of responses) {
      expect(row.error).toBeNull();
      expect(row.rawPayload).not.toBeNull();
      expect(row.costUsd).toBeNull();
    }

    const [run] = await sql`
      select status, status_detail from runs where id = ${started.data.id}
    `;
    expect(["completed", "partial"]).toContain(run!.status);
    expect(run!.statusDetail ?? "").toMatch(/pricing/);
  });
});
