/**
 * Integration tests for spec 033 — the MCP tool registry against a real
 * database: read tools return what the pages render, mutating tools reuse
 * the services' gates, idempotency keys replay instead of re-executing,
 * and every executed mutation lands in the append-only ledger.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000201",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const reviewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000301",
  email: "rev@test.local",
  name: "Reviewer",
  role: "reviewer",
};

const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("mcp tools (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let tools: typeof import("@/lib/mcp/tools");
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let gaps: typeof import("@/lib/gaps/service");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    tools = await import("@/lib/mcp/tools");
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    gaps = await import("@/lib/gaps/service");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`update users set role = 'reviewer' where id = ${reviewer.id}`;
    await sql`update users set role = 'client_viewer' where id = ${clientViewer.id}`;
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, mcp_invocations, jobs, tasks, evidence, gap_findings,
       learnings, action_outcomes,
       intervention_runs, interventions, reports, brand_candidates, competitors,
       scores, sources, response_citations, response_parses, mentions, companies,
       responses, runs, prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run")
        await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      else if (job.type === "start_scheduled_run") {
        // Intervention retests are future-dated; leave them queued.
      }
      await jobs.completeJob(job.id);
    }
  }

  interface Seeded {
    projectId: string;
    setId: string;
    versionId: string;
  }

  async function seedProject(): Promise<Seeded> {
    await companySvc.upsertCompany(operator, { name: "Lumina", isSelf: true });
    await companySvc.upsertCompany(operator, { name: "Rival Co" });
    const project = await projectSvc.createProject(operator, { name: "MCP Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(operator, {
      projectId: project.data.id,
      name: "Core prompts",
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
    return {
      projectId: project.data.id,
      setId: set.data.id,
      versionId: version?.id as string,
    };
  }

  function runInput(seeded: Seeded, extra: Record<string, unknown> = {}) {
    return {
      project_id: seeded.projectId,
      prompt_set_version_id: seeded.versionId,
      label: "mcp run",
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budget_usd: 5,
      ...extra,
    };
  }

  it("registers exactly the spec-033 tool set", () => {
    const names = tools.MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(21);
    expect(tools.MCP_TOOLS.filter((t) => t.group === "operator").map((t) => t.name)).toEqual(
      ["run_prompt_set", "create_experiment", "import_prompts", "record_learning"]
    );
    for (const tool of tools.MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it("rejects unknown tools and invalid input as classified errors", async () => {
    const unknown = await tools.invokeTool(operator, "improve_ai_visibility_everywhere", {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.kind).toBe("validation");

    const bad = await tools.invokeTool(operator, "get_project", { project_id: "nope" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("validation");
  });

  it("read tools return seeded registry state and honest empty states", async () => {
    const seeded = await seedProject();

    const projects = await tools.invokeTool(operator, "list_projects", {});
    expect(projects.ok).toBe(true);
    if (projects.ok) {
      const rows = projects.data as { id: string; name: string }[];
      expect(rows.map((p) => p.name)).toContain("MCP Test");
    }

    const project = await tools.invokeTool(operator, "get_project", {
      project_id: seeded.projectId,
    });
    expect(project.ok).toBe(true);
    if (project.ok) {
      const data = project.data as {
        subject_company: { name: string } | null;
        companies: { companyName: string }[];
      };
      expect(data.subject_company?.name).toBe("Lumina");
    }

    const sets = await tools.invokeTool(operator, "list_prompt_sets", {
      project_id: seeded.projectId,
    });
    expect(sets.ok).toBe(true);
    if (sets.ok) {
      const rows = sets.data as { name: string; versions: { version: number }[] }[];
      expect(rows[0]?.name).toBe("Core prompts");
      expect(rows[0]?.versions).toHaveLength(1);
    }

    // No runs yet: summary is empty, not an error.
    const summary = await tools.invokeTool(operator, "get_visibility_summary", {
      project_id: seeded.projectId,
    });
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      const data = summary.data as { latest_scored_run_id: string | null };
      expect(data.latest_scored_run_id).toBeNull();
    }

    const missing = await tools.invokeTool(operator, "get_project", {
      project_id: "33333333-3333-4333-8333-333333333333",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe("not_found");
  });

  it("run_prompt_set dry_run matches the service estimate and creates nothing", async () => {
    const seeded = await seedProject();
    const dry = await tools.invokeTool(
      operator,
      "run_prompt_set",
      runInput(seeded, { dry_run: true })
    );
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      const data = dry.data as { dry_run: boolean; estimate: { cellCount: number } };
      expect(data.dry_run).toBe(true);
      const direct = await runSvc.estimateRunForVersion({
        promptSetVersionId: seeded.versionId,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      });
      if (!direct.ok) throw new Error(direct.error.message);
      expect(data.estimate).toEqual(direct.data);
    }
    const runRows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
    expect(runRows[0]?.count).toBe(0);
    const ledgerRows = await sql<{ count: number }[]>`
      select count(*)::int as count from mcp_invocations
    `;
    expect(ledgerRows[0]?.count).toBe(0);
  });

  it("run_prompt_set executes end to end and the analysis tools read it back", async () => {
    const seeded = await seedProject();
    const started = await tools.invokeTool(operator, "run_prompt_set", runInput(seeded));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const runId = (started.data as { run_id: string }).run_id;

    const [ledgerRow] = await sql`
      select tool, actor_id, outcome, entity_kind, entity_id from mcp_invocations
    `;
    expect(ledgerRow?.tool).toBe("run_prompt_set");
    expect(ledgerRow?.actorId).toBe(operator.id);
    expect(ledgerRow?.outcome).toBe("ok");
    expect(ledgerRow?.entityId).toBe(runId);

    // Before parsing: results tool reports status, not phantom mentions.
    const unparsed = await tools.invokeTool(operator, "get_prompt_results", {
      run_id: runId,
    });
    expect(unparsed.ok).toBe(true);
    if (unparsed.ok) {
      expect((unparsed.data as { mentions: unknown[] }).mentions).toHaveLength(0);
    }

    await drainJobs();

    const status = await tools.invokeTool(operator, "get_run_status", { run_id: runId });
    expect(status.ok).toBe(true);
    if (status.ok) {
      const data = status.data as {
        run: { status: string };
        cells: { total: number; captured: number };
        pending_review: number;
      };
      expect(data.run.status).toBe("completed");
      expect(data.cells.total).toBe(2);
      expect(data.cells.captured).toBe(2);
    }

    const results = await tools.invokeTool(operator, "get_prompt_results", {
      run_id: runId,
    });
    expect(results.ok).toBe(true);
    if (results.ok) {
      expect(
        (results.data as { mentions: unknown[] }).mentions.length
      ).toBeGreaterThan(0);
    }

    const compare = await tools.invokeTool(operator, "compare_competitors", {
      project_id: seeded.projectId,
    });
    expect(compare.ok).toBe(true);
    if (compare.ok) {
      const rows = compare.data as { is_self: boolean; metrics: Record<string, number> }[];
      const self = rows.find((r) => r.is_self);
      expect(self).toBeDefined();
      expect(Object.keys(self?.metrics ?? {}).length).toBeGreaterThan(0);
    }

    const summary = await tools.invokeTool(operator, "get_visibility_summary", {
      project_id: seeded.projectId,
    });
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      const data = summary.data as {
        latest_scored_run_id: string | null;
        trend: unknown[];
      };
      expect(data.latest_scored_run_id).toBe(runId);
      expect(data.trend.length).toBeGreaterThan(0);
    }

    const analyzed = await gaps.analyzeRun(operator, { runId });
    if (!analyzed.ok) throw new Error(analyzed.error.message);
    const report = await tools.invokeTool(operator, "get_gap_report", {
      project_id: seeded.projectId,
      run_id: runId,
    });
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect((report.data as unknown[]).length).toBe(analyzed.data.findings);
    }

    const citations = await tools.invokeTool(operator, "get_citation_sources", {
      project_id: seeded.projectId,
    });
    expect(citations.ok).toBe(true);
  });

  it("an idempotency key replays instead of creating a second run", async () => {
    const seeded = await seedProject();
    const input = runInput(seeded, { idempotency_key: "weekly-2026-08-01" });

    const first = await tools.invokeTool(operator, "run_prompt_set", input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const runId = (first.data as { run_id: string }).run_id;
    expect((first.data as { idempotent_replay: boolean }).idempotent_replay).toBe(false);

    const second = await tools.invokeTool(operator, "run_prompt_set", input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((second.data as { idempotent_replay: boolean }).idempotent_replay).toBe(true);
    expect((second.data as { entity_id: string }).entity_id).toBe(runId);

    const runRows = await sql<{ count: number }[]>`select count(*)::int as count from runs`;
    expect(runRows[0]?.count).toBe(1);
    const okRows = await sql<{ count: number }[]>`
      select count(*)::int as count from mcp_invocations where outcome = 'ok'
    `;
    expect(okRows[0]?.count).toBe(1);
  });

  it("staff act under the platform's own write gate; non-staff are refused entirely", async () => {
    const seeded = await seedProject();

    // Reviewer is staff: the same assertCanWrite that lets them mutate in
    // the UI lets them mutate here — attributed to them in the ledger.
    const write = await tools.invokeTool(reviewer, "run_prompt_set", runInput(seeded));
    expect(write.ok).toBe(true);
    const [row] = await sql`
      select outcome, actor_id from mcp_invocations where tool = 'run_prompt_set'
    `;
    expect(row?.outcome).toBe("ok");
    expect(row?.actorId).toBe(reviewer.id);

    // A client identity gets no tool surface at all — read or write — and
    // leaves no ledger row because nothing executed.
    const clientRead = await tools.invokeTool(clientViewer, "list_runs", {
      project_id: seeded.projectId,
    });
    expect(clientRead.ok).toBe(false);
    if (!clientRead.ok) expect(clientRead.error.kind).toBe("forbidden");

    const clientWrite = await tools.invokeTool(
      clientViewer,
      "run_prompt_set",
      runInput(seeded)
    );
    expect(clientWrite.ok).toBe(false);
    if (!clientWrite.ok) expect(clientWrite.error.kind).toBe("forbidden");

    const ledgerRows = await sql<{ count: number }[]>`
      select count(*)::int as count from mcp_invocations
    `;
    expect(ledgerRows[0]?.count).toBe(1);
  });

  it("create_experiment schedules retests exactly like the form path", async () => {
    const seeded = await seedProject();
    const started = await tools.invokeTool(operator, "run_prompt_set", runInput(seeded));
    expect(started.ok).toBe(true);
    await drainJobs();

    const dry = await tools.invokeTool(operator, "create_experiment", {
      project_id: seeded.projectId,
      title: "Comparison page",
      shipped_at: new Date().toISOString().slice(0, 10),
      prompt_set_version_id: seeded.versionId,
      dry_run: true,
    });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      expect((dry.data as { validated_only: boolean }).validated_only).toBe(true);
    }

    const created = await tools.invokeTool(operator, "create_experiment", {
      project_id: seeded.projectId,
      title: "Comparison page",
      shipped_at: new Date().toISOString().slice(0, 10),
      prompt_set_version_id: seeded.versionId,
      idempotency_key: "exp-1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const interventionId = (created.data as { intervention_id: string }).intervention_id;

    const scheduled = await sql`
      select payload from jobs where type = 'start_scheduled_run'
    `;
    expect(scheduled).toHaveLength(3);

    const listed = await tools.invokeTool(operator, "list_experiments", {
      project_id: seeded.projectId,
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const rows = listed.data as { id: string; baselines: number }[];
      expect(rows[0]?.id).toBe(interventionId);
      expect(rows[0]?.baselines).toBeGreaterThan(0);
    }

    const view = await tools.invokeTool(operator, "get_experiment", {
      intervention_id: interventionId,
    });
    expect(view.ok).toBe(true);

    const replay = await tools.invokeTool(operator, "create_experiment", {
      project_id: seeded.projectId,
      title: "Comparison page",
      shipped_at: new Date().toISOString().slice(0, 10),
      prompt_set_version_id: seeded.versionId,
      idempotency_key: "exp-1",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect((replay.data as { idempotent_replay: boolean }).idempotent_replay).toBe(true);
      expect((replay.data as { entity_id: string }).entity_id).toBe(interventionId);
    }
  });

  it("competitive depth over MCP: head-to-head and citation profiles", async () => {
    const seeded = await seedProject();

    // Before any run: honest empty states.
    const empty = await tools.invokeTool(operator, "get_head_to_head", {
      project_id: seeded.projectId,
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect((empty.data as { run_id?: string | null; runId: string | null }).runId).toBeNull();
    }

    const started = await tools.invokeTool(operator, "run_prompt_set", runInput(seeded));
    expect(started.ok).toBe(true);
    await drainJobs();

    const h2h = await tools.invokeTool(operator, "get_head_to_head", {
      project_id: seeded.projectId,
    });
    expect(h2h.ok).toBe(true);
    if (h2h.ok) {
      const data = h2h.data as { version: string; runId: string | null };
      expect(data.version).toBe("head-to-head-v1");
      expect(data.runId).not.toBeNull();
    }

    const profiles = await tools.invokeTool(operator, "compare_citation_profiles", {
      project_id: seeded.projectId,
    });
    expect(profiles.ok).toBe(true);
    if (profiles.ok) {
      const data = profiles.data as { note: string; profiles: unknown[] };
      expect(data.note).toContain("not proof");
    }
  });

  it("prompt intelligence over MCP: dry-run import, real import, clusters", async () => {
    const seeded = await seedProject();
    const content = [
      "Best CRM for real estate agents",
      "Which CRM should we pick for real estate agents?",
      "Jersey City waterfront condos", // no rule → rejected
    ].join("\n");

    const dry = await tools.invokeTool(operator, "import_prompts", {
      prompt_set_id: seeded.setId,
      content,
      dry_run: true,
    });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      const data = dry.data as { would_import: number; rejected: unknown[] };
      expect(data.would_import).toBe(2);
      expect(data.rejected).toHaveLength(1);
    }
    const beforeRows = await sql<{ count: number }[]>`
      select count(*)::int as count from prompts where source = 'import'
    `;
    expect(beforeRows[0]?.count).toBe(0);

    const real = await tools.invokeTool(operator, "import_prompts", {
      prompt_set_id: seeded.setId,
      content,
      idempotency_key: "import-1",
    });
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    expect((real.data as { added: number }).added).toBe(2);

    const replay = await tools.invokeTool(operator, "import_prompts", {
      prompt_set_id: seeded.setId,
      content,
      idempotency_key: "import-1",
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect((replay.data as { idempotent_replay: boolean }).idempotent_replay).toBe(true);
    }

    const clusters = await tools.invokeTool(operator, "get_prompt_clusters", {
      prompt_set_id: seeded.setId,
    });
    expect(clusters.ok).toBe(true);
    if (clusters.ok) {
      const data = clusters.data as {
        cluster_version: string;
        clusters: { promptIds: string[] }[];
      };
      expect(data.cluster_version).toContain("prompt-cluster-v1");
      // Seed prompt + two imported CRM prompts; the CRM pair clusters.
      expect(data.clusters.some((c) => c.promptIds.length === 2)).toBe(true);
    }
  });

  it("learnings round-trip over MCP: record with ledger + replay, then search", async () => {
    const seeded = await seedProject();

    const dry = await tools.invokeTool(operator, "record_learning", {
      project_id: seeded.projectId,
      category: "content",
      statement: "Comparison pages lift recommendation rate.",
      confidence_label: "probable",
      dry_run: true,
    });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      expect((dry.data as { validated_only: boolean }).validated_only).toBe(true);
    }

    const input = {
      project_id: seeded.projectId,
      category: "content",
      statement: "Comparison pages lift recommendation rate.",
      confidence_label: "probable",
      idempotency_key: "learn-1",
    };
    const recorded = await tools.invokeTool(operator, "record_learning", input);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const learningId = (recorded.data as { learning_id: string }).learning_id;

    const replay = await tools.invokeTool(operator, "record_learning", input);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect((replay.data as { idempotent_replay: boolean }).idempotent_replay).toBe(true);
      expect((replay.data as { entity_id: string }).entity_id).toBe(learningId);
    }

    // 'confirmed' without measured sources is refused through the same gate.
    const confirmed = await tools.invokeTool(operator, "record_learning", {
      project_id: seeded.projectId,
      category: "content",
      statement: "This is proven.",
      confidence_label: "confirmed",
    });
    expect(confirmed.ok).toBe(false);
    if (!confirmed.ok) expect(confirmed.error.kind).toBe("validation");

    const found = await tools.invokeTool(operator, "search_learnings", {
      query: "comparison",
      project_id: seeded.projectId,
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      const rows = found.data as { id: string }[];
      expect(rows.map((r) => r.id)).toContain(learningId);
    }
  });

  it("create_experiment carries the hypothesis through to the intervention", async () => {
    const seeded = await seedProject();
    const started = await tools.invokeTool(operator, "run_prompt_set", runInput(seeded));
    expect(started.ok).toBe(true);
    await drainJobs();

    const created = await tools.invokeTool(operator, "create_experiment", {
      project_id: seeded.projectId,
      title: "Comparison page",
      hypothesis: "The comparison page should lift recommendation rate.",
      shipped_at: new Date().toISOString().slice(0, 10),
      prompt_set_version_id: seeded.versionId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [row] = await sql`
      select hypothesis from interventions
      where id = ${(created.data as { intervention_id: string }).intervention_id}
    `;
    expect(row?.hypothesis).toBe("The comparison page should lift recommendation rate.");
  });

  it("the invocation ledger is append-only", async () => {
    const seeded = await seedProject();
    const started = await tools.invokeTool(operator, "run_prompt_set", runInput(seeded));
    expect(started.ok).toBe(true);
    await expect(
      sql`update mcp_invocations set outcome = 'error'`
    ).rejects.toThrow(/immutable|forbid/i);
    await expect(sql`delete from mcp_invocations`).rejects.toThrow(/immutable|forbid/i);
  });

  it("list_pending_approvals returns an empty inbox without error", async () => {
    const approvals = await tools.invokeTool(operator, "list_pending_approvals", {});
    expect(approvals.ok).toBe(true);
    if (approvals.ok) expect(approvals.data).toEqual([]);
  });
});
