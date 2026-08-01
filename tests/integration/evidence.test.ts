/**
 * Integration tests — LLM Evidence Capture & Audit Trail spec: capture-time
 * hashing + tamper detection, metric drill-down reproducing stored scores,
 * holdout exclusion, seeded audit samples, validation separation, and a
 * hash-verified export package.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000601",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("evidence capture & audit trail (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let observations: typeof import("@/lib/evidence/observations");
  let integrity: typeof import("@/lib/evidence/integrity");
  let evidence: typeof import("@/lib/evidence/service");
  let exporter: typeof import("@/lib/evidence/export");
  let constants: typeof import("@/lib/constants");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    observations = await import("@/lib/evidence/observations");
    integrity = await import("@/lib/evidence/integrity");
    evidence = await import("@/lib/evidence/service");
    exporter = await import("@/lib/evidence/export");
    constants = await import("@/lib/constants");
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
      `truncate audit_log, jobs, evidence_exports, client_validation_observations,
       client_validation_runs, audit_samples, evidence_artifacts,
       content_versions, content_assets, gap_findings, claims, tasks, evidence,
       intervention_runs, interventions, reports, brand_candidates, competitors,
       scores, sources, response_parses, mentions, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
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
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  async function seedScoredRun(opts?: {
    holdout?: boolean;
    cite?: boolean;
    name?: string;
  }): Promise<{
    projectId: string;
    runId: string;
    versionId: string;
  }> {
    // Reused across seeds: a second project shares the same tracked
    // companies (upsertCompany rejects duplicate names by design).
    const [existing] = await sql`
      select id from companies where name = 'Lumina' and archived_at is null
    `;
    let companyId: string;
    if (existing) {
      companyId = existing.id as string;
    } else {
      const company = await companySvc.upsertCompany(user, {
        name: "Lumina",
        aliases: ["lumina.io"],
        domain: "lumina.io",
      });
      if (!company.ok) throw new Error(company.error.message);
      companyId = company.data.id;
      await companySvc.upsertCompany(user, { name: "Acme" });
    }
    const project = await projectSvc.createProject(user, {
      name: opts?.name ?? "Evidence Test",
    });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId,
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "best tools for the job?", // mock mentions Lumina + Acme
      category: "recommendation",
    });
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "MOCK_REFUSE tell me about tools", // negative observation
      category: "problem",
    });
    if (opts?.holdout) {
      await promptSvc.addPrompt(user, {
        setId: set.data.id,
        text: "holdout question about tools?",
        category: "recommendation",
        isHoldout: true,
      });
    }
    if (opts?.cite) {
      await promptSvc.addPrompt(user, {
        setId: set.data.id,
        text: "MOCK_CITE_OWNED where do I read about Lumina?",
        category: "branded",
      });
      await promptSvc.addPrompt(user, {
        setId: set.data.id,
        text: "MOCK_CITE_OTHER is there an independent review?",
        category: "comparison",
      });
    }
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
      budgetUsd: 5,
      label: "evidence run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return {
      projectId: project.data.id,
      runId: started.data.id,
      versionId: version?.id as string,
    };
  }

  it("every capture is hashed at insert; tampering is detected", async () => {
    const { runId } = await seedScoredRun();
    const [nulls] = await sql`
      select count(*)::int as n from responses
      where run_id = ${runId} and (response_hash is null or hashed_at is null)
    `;
    expect(nulls?.n).toBe(0);

    const clean = await integrity.verifyRunIntegrity(runId);
    expect(clean.mismatchedResponses).toHaveLength(0);
    expect(clean.checkedResponses).toBeGreaterThan(0);

    // Simulate out-of-band tampering (trigger disabled like a superuser would)
    await sql.unsafe(`alter table responses disable trigger responses_immutable`);
    await sql`
      update responses set response_text = response_text || ' TAMPERED'
      where id = (select id from responses where run_id = ${runId}
        and error is null limit 1)
    `;
    await sql.unsafe(`alter table responses enable trigger responses_immutable`);

    const dirty = await integrity.verifyRunIntegrity(runId);
    expect(dirty.mismatchedResponses).toHaveLength(1);
    expect(dirty.mismatchedResponses[0]?.field).toBe("response");
  });

  it("drill-down reproduces stored scores exactly; positives + negatives listed", async () => {
    const { runId } = await seedScoredRun();
    for (const metric of ["mention_rate", "recommendation_rate"] as const) {
      const result = await observations.drilldown({
        runId,
        metric,
        scoringVersion: constants.SCORING_VERSION,
      });
      expect(result).not.toBeNull();
      expect(result!.matchesStored).toBe(true);
      expect(result!.rows).toHaveLength(result!.denominator);
      expect(result!.rows.filter((r) => r.positive)).toHaveLength(result!.numerator);
      // Both positives and negatives are present in this seeded shape
      expect(result!.numerator).toBeGreaterThan(0);
      expect(result!.denominator - result!.numerator).toBeGreaterThan(0);
      expect(result!.rows.every((r) => r.responseHash)).toBe(true);
    }
  });

  it("citation drill-down finds the stored score and uses its denominator", async () => {
    // Regression: the drill-down previously asked `scores` for a metric named
    // "citation_rate" while scoring stores "citation_score", so storedValue
    // was always null and matchesStored was vacuously true. It also divided
    // by all responses where scoring divides by responses-with-any-citation.
    const { runId } = await seedScoredRun({ cite: true });
    const result = await observations.drilldown({
      runId,
      metric: "citation_score",
      scoringVersion: constants.SCORING_VERSION,
    });
    expect(result).not.toBeNull();
    // The stored row must be FOUND — the whole point of the fix.
    expect(result!.storedValue).not.toBeNull();
    expect(result!.matchesStored).toBe(true);
    // Denominator = responses with any citation: 2 cite prompts × 3 reps.
    // Numerator = responses whose Lumina mention carries an owned citation:
    // only the OWNED prompt's 3 reps.
    expect(result!.denominator).toBe(6);
    expect(result!.numerator).toBe(3);
    expect(result!.value).toBeCloseTo(0.5, 6);
    expect(result!.storedValue).toBeCloseTo(0.5, 6);
  });

  it("per-response citation ledger records url, kind, and owner (033)", async () => {
    const { runId } = await seedScoredRun({ cite: true });
    const rows = await sql`
      select rc.url, rc.kind, rc.company_id, rc.response_id
      from response_citations rc
      join responses r on r.id = rc.response_id
      where r.run_id = ${runId}
      order by rc.url
    `;
    // 2 cite prompts × 3 reps, one in-text URL each = 6 ledger rows.
    expect(rows).toHaveLength(6);
    const owned = rows.filter((r) => r.url === "https://lumina.io/docs");
    const thirdParty = rows.filter((r) =>
      (r.url as string).startsWith("https://example.com")
    );
    expect(owned).toHaveLength(3);
    expect(thirdParty).toHaveLength(3);
    // Owner attribution matches parse-time domain matching.
    expect(owned.every((r) => r.companyId !== null)).toBe(true);
    expect(thirdParty.every((r) => r.companyId === null)).toBe(true);
    expect(rows.every((r) => r.kind === "in_text")).toBe(true);
    // Immutable: the ledger is a derived record, never edited.
    await expect(
      sql`update response_citations set kind = 'search'`
    ).rejects.toThrow(/immutable|not allowed|forbid/i);
  });

  it("parse classifies sources and the run publishes lifecycle events", async () => {
    const { runId, projectId } = await seedScoredRun({ cite: true });
    const [owned] = await sql`
      select source_type, relationship, classifier_version from sources
      where project_id = ${projectId} and domain = 'lumina.io'
    `;
    expect(owned?.sourceType).toBe("client_site");
    expect(owned?.relationship).toBe("owned");
    expect(owned?.classifierVersion).toBe("source-classifier-v1");
    const [thirdParty] = await sql`
      select source_type, relationship from sources
      where project_id = ${projectId} and domain = 'example.com'
    `;
    expect(thirdParty?.sourceType).toBe("other");
    expect(thirdParty?.relationship).toBe("third_party");

    // Lifecycle events (roadmap 2.6): declared since migration 020, now
    // actually produced — started at launch, completed at finalize.
    const events = await sql`
      select type from domain_events
      where project_id = ${projectId} and type like 'benchmark.%'
      order by occurred_at asc
    `;
    expect(events.map((e) => e.type)).toEqual([
      "benchmark.started",
      "benchmark.completed",
    ]);
    void runId;
  });

  it("source intelligence is scoped per client (migration 029)", async () => {
    // Before 029, sources.url was globally unique and citation_count
    // accumulated across every client's runs. Two clients citing the same
    // URL must now produce two rows with independent counters.
    const a = await seedScoredRun({ cite: true });
    const b = await seedScoredRun({ cite: true, name: "Evidence Test B" });
    const rows = await sql`
      select project_id, citation_count from sources
      where url = 'https://lumina.io/docs' order by first_seen_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.projectId as string).sort()).toEqual(
      [a.projectId, b.projectId].sort()
    );
    // 3 repetitions each — each client's counter reflects only its own runs.
    for (const row of rows) expect(Number(row.citationCount)).toBe(3);
  });

  it("holdout prompts run but stay out of standard denominators", async () => {
    const { runId } = await seedScoredRun({ holdout: true });
    const result = await observations.drilldown({
      runId,
      metric: "mention_rate",
      scoringVersion: constants.SCORING_VERSION,
    });
    // 3 prompts × 3 reps captured, but only the 2 working prompts × 3 count
    expect(result!.denominator).toBe(6);
    expect(result!.holdoutRows).toHaveLength(3);
    expect(result!.matchesStored).toBe(true); // scoring excluded them too

    const [captured] = await sql`
      select count(*)::int as n from responses where run_id = ${runId}
    `;
    expect(captured?.n).toBe(9); // holdouts still executed
  });

  it("audit samples are reproducible from their recorded seed", async () => {
    const { runId } = await seedScoredRun();
    const one = await evidence.createAuditSample(user, { runId, size: 4, seed: 77 });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const two = await evidence.createAuditSample(user, { runId, size: 4, seed: 77 });
    if (!two.ok) throw new Error(two.error.message);
    const rows = await sql`
      select selected_response_ids, constraints_met from audit_samples
      where run_id = ${runId} order by created_at
    `;
    expect(rows[0]?.selectedResponseIds).toEqual(rows[1]?.selectedResponseIds);
    const constraints = rows[0]?.constraintsMet as {
      hasPositive: boolean;
      hasNegative: boolean;
    };
    expect(constraints.hasPositive).toBe(true);
    expect(constraints.hasNegative).toBe(true);
  });

  it("client validation stays separate and compares directionally", async () => {
    const { projectId, runId, versionId } = await seedScoredRun();
    const validation = await evidence.createClientValidationRun(user, {
      projectId,
      promptSetVersionId: versionId,
      promptCount: 2,
      seed: 11,
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    const [validationRun] = await sql`
      select selected_prompt_ids from client_validation_runs
      where id = ${validation.data.validationRunId}
    `;
    const promptId = (validationRun?.selectedPromptIds as string[])[0]!;
    const recorded = await evidence.recordClientValidationObservation(user, {
      validationRunId: validation.data.validationRunId,
      promptId,
      provider: "chatgpt-consumer",
      performedOn: "2026-07-29",
      rawResponse: "The client answer mentioned Lumina favorably.",
      claimedMentioned: true,
      claimedRecommended: false,
    });
    expect(recorded.ok).toBe(true);

    // Raw client submission is hashed and immutable
    const [obs] = await sql`
      select id, response_hash from client_validation_observations limit 1
    `;
    expect(obs?.responseHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      sql`update client_validation_observations set raw_response = 'edited'`
    ).rejects.toThrow(/insert-only/);

    // Never mixed into benchmark data: scores/responses counts unchanged
    const [benchCount] = await sql`
      select count(*)::int as n from responses where run_id = ${runId}
    `;
    expect(benchCount?.n).toBe(6);

    const comparison = await evidence.validationComparison(
      validation.data.validationRunId
    );
    expect(comparison?.clientTotal).toBe(1);
    expect(comparison?.benchmarkTotal).toBeGreaterThan(0);
  });

  it("export package: manifest hashes verify; observations reproduce metrics", async () => {
    const { runId } = await seedScoredRun();
    const result = await exporter.generateEvidenceExport(user, { runId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { artifactPath } = await import("@/lib/evidence/storage");
    const tarPath = artifactPath(result.data.storageKey);
    const tarBytes = await readFile(tarPath);
    expect(createHash("sha256").update(tarBytes).digest("hex")).toBe(
      result.data.sha256
    );

    // Unpack and verify each manifest hash
    const dest = join(tmpdir(), `evidence-test-${Date.now()}`);
    execSync(`mkdir -p "${dest}" && tar -xzf "${tarPath}" -C "${dest}"`);
    const manifest = JSON.parse(
      await readFile(join(dest, "evidence-package", "manifest.json"), "utf8")
    ) as {
      files: { path: string; sha256: string }[];
      metrics: { metric: string; numerator: number; denominator: number; matchesStoredScore: boolean }[];
      observationCount: number;
    };
    expect(manifest.files.length).toBeGreaterThan(5);
    for (const file of manifest.files) {
      const bytes = await readFile(join(dest, "evidence-package", file.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    const mention = manifest.metrics.find((m) => m.metric === "mention_rate");
    expect(mention?.matchesStoredScore).toBe(true);
    expect(manifest.observationCount).toBe(6);

    const observationsCsv = await readFile(
      join(dest, "evidence-package", "observations.csv"),
      "utf8"
    );
    expect(observationsCsv.trim().split("\n")).toHaveLength(7); // header + 6
    await rm(dest, { recursive: true, force: true });
  });
});
