/**
 * Integration tests for spec 087 — recommendation displacement and staged
 * prompt suggestions, through the REAL pipeline (mock provider, real parse,
 * real scores). The invariants: displacement counts reconcile exactly to
 * stored current-revision mentions; the displacement finding flows
 * gap → evidence-gated task; suggestions dedupe, approve into provenanced
 * prompts, and dimensions survive the freeze.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("displacement + prompt suggestions (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let suggest: typeof import("@/lib/prompts/suggest");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let displacement: typeof import("@/lib/competitors/displacement");
  let recShare: typeof import("@/lib/scoring/recommendation-share");
  let gaps: typeof import("@/lib/gaps/service");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    suggest = await import("@/lib/prompts/suggest");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    displacement = await import("@/lib/competitors/displacement");
    recShare = await import("@/lib/scoring/recommendation-share");
    gaps = await import("@/lib/gaps/service");
    mock = await import("@/lib/ai/mock");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, tasks, evidence, gap_findings,
       prompt_suggestions, claims, competitors, scores, sources,
       response_parses, mentions, response_citations, brand_candidates,
       companies, responses, runs, prompt_set_versions, prompts, prompt_sets,
       projects cascade`
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

  /** Real pipeline where the SUBJECT (Northside) never appears in answers —
   * the default mock answer recommends Acme, then names Lumina. */
  async function seedAbsentSubject(): Promise<{ projectId: string; runId: string; subjectId: string }> {
    const project = unwrap(
      await projectSvc.createProject(operator, { name: "Displacement case" })
    );
    const subject = unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Northside",
        domain: "northside.io",
      })
    );
    unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Acme",
        domain: "acme.com",
      })
    );
    unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Lumina",
        domain: "lumina.io",
      })
    );
    unwrap(
      await claims.setSubjectCompany(operator, {
        projectId: project.id,
        companyId: subject.id,
      })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    for (let i = 0; i < 8; i += 1) {
      unwrap(
        await promptSvc.addPrompt(operator, {
          setId: set.id,
          text: `who should sell a condo in area ${i}?`,
          category: "recommendation",
          tier: 1,
          neighborhood: i % 2 === 0 ? "paulus hook" : "the heights",
          propertyType: "condo",
        })
      );
    }
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
        budgetUsd: 5,
        label: "benchmark",
      })
    );
    await drainJobs();
    const [run] = await sql`select id from runs where project_id = ${project.id}`;
    return { projectId: project.id, runId: run?.id as string, subjectId: subject.id };
  }

  it("displacement reconciles to stored mentions and flows gap → evidence-gated task", async () => {
    const { runId } = await seedAbsentSubject();

    const result = await displacement.runDisplacement(runId);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("ok");
    expect(result!.validResponses).toBe(8);
    expect(result!.subjectMentionedResponses).toBe(0);
    expect(result!.absentResponses).toBe(8);

    const acme = result!.rivals.find((r) => r.name === "Acme");
    expect(acme).toBeDefined();
    expect(acme!.meaningful).toBe(true);

    // Reconciliation against the raw ledger: current-revision recommended
    // Acme mentions on valid responses of this run.
    const [ledger] = await sql`
      select count(distinct m.response_id)::int as n
      from mentions m
      join responses r on r.id = m.response_id
      join companies c on c.id = m.company_id
      where r.run_id = ${runId} and r.error is null
        and c.name = 'Acme' and m.mentioned and m.recommended
        and not exists (select 1 from mentions newer
          where newer.response_id = m.response_id
            and newer.company_id = m.company_id
            and newer.revision > m.revision)
    `;
    expect(acme!.displacedResponses).toBe(ledger?.n as number);
    expect(acme!.displacedResponses).toBeGreaterThanOrEqual(2);
    // Dimension drilldown carries the structured prompt columns.
    expect(
      acme!.byDimension.neighborhood?.map((s) => s.segment).sort()
    ).toEqual(["paulus hook", "the heights"]);

    // Recommendation share: the subject collected none of the moments.
    const share = await recShare.runRecommendationShare(runId);
    expect(share!.overall.subjectMoments).toBe(0);
    expect(share!.overall.totalMoments).toBeGreaterThanOrEqual(6);
    expect(share!.overall.share).toBe(0);
    expect(share!.overall.status).toBe("ok");

    // Gap analysis emits the displacement finding…
    unwrap(await gaps.analyzeRun(operator, { runId }));
    const [finding] = await sql`
      select id, finding, detail, opportunity_score from gap_findings
      where run_id = ${runId} and gap_type = 'displacement'
    `;
    expect(finding).toBeDefined();
    expect(String(finding!.finding)).toContain("Acme");

    // …which promotes to a task through the existing evidence-gated path.
    const task = unwrap(
      await gaps.createTaskFromFinding(operator, { findingId: finding!.id as string })
    );
    const [taskRow] = await sql`
      select status, evidence_ids from tasks where id = ${task.taskId}
    `;
    expect(taskRow?.status).toBe("suggested");
    expect((taskRow?.evidenceIds as string[]).length).toBeGreaterThanOrEqual(1);
    const [updated] = await sql`
      select status, task_id from gap_findings where id = ${finding!.id}
    `;
    expect(updated?.status).toBe("task_created");
    expect(updated?.taskId).toBe(task.taskId);
  });

  it("subject presence prevents false displacement", async () => {
    const project = unwrap(
      await projectSvc.createProject(operator, { name: "Present subject" })
    );
    // Lumina IS the subject here — the default mock answer names it, so no
    // response is subject-absent.
    const subject = unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Lumina",
        domain: "lumina.io",
      })
    );
    unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Acme",
        domain: "acme.com",
      })
    );
    unwrap(
      await claims.setSubjectCompany(operator, {
        projectId: project.id,
        companyId: subject.id,
      })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    for (let i = 0; i < 8; i += 1) {
      unwrap(
        await promptSvc.addPrompt(operator, {
          setId: set.id,
          text: `best option for job ${i}?`,
          category: "recommendation",
        })
      );
    }
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
        budgetUsd: 5,
        label: "benchmark",
      })
    );
    await drainJobs();
    const [run] = await sql`select id from runs where project_id = ${project.id}`;

    const result = await displacement.runDisplacement(run?.id as string);
    expect(result!.subjectMentionedResponses).toBe(8);
    expect(result!.absentResponses).toBe(0);
    expect(result!.rivals).toHaveLength(0);
    expect(result!.status).toBe("insufficient_evidence");
  });

  it("suggestions stage, dedupe, approve into provenanced prompts, and survive the freeze", async () => {
    const project = unwrap(
      await projectSvc.createProject(operator, { name: "Universe" })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );

    const first = unwrap(
      await suggest.generatePromptSuggestions(operator, {
        setId: set.id,
        packKey: "jersey-city",
        cap: 10,
      })
    );
    expect(first.staged).toBe(10);

    // Re-running skips everything already staged and proposes the NEXT
    // uncovered batch — progressive staging, no duplicates ever.
    const second = unwrap(
      await suggest.generatePromptSuggestions(operator, {
        setId: set.id,
        packKey: "jersey-city",
        cap: 10,
      })
    );
    expect(second.skippedExisting).toBeGreaterThanOrEqual(10);

    const pending = await suggest.listPromptSuggestions(set.id);
    expect(pending).toHaveLength(10 + second.staged);
    expect(new Set(pending.map((s) => s.text.toLowerCase())).size).toBe(
      pending.length
    );
    expect(pending.every((s) => s.origin === "generated")).toBe(true);
    expect(pending.every((s) => s.generatorVersion === "prompt-suggest-v1+deterministic")).toBe(true);

    // Approve one: a prompt exists with provenance + dimensions.
    const target = pending[0]!;
    const approved = unwrap(
      await suggest.approvePromptSuggestion(operator, { suggestionId: target.id })
    );
    const [prompt] = await sql`
      select text, source, category, neighborhood, property_type, template_ref
      from prompts where id = ${approved.promptId}
    `;
    expect(prompt?.text).toBe(target.text);
    expect(prompt?.source).toBe("generated");
    expect(prompt?.templateRef).toBe(target.templateRef);
    expect(prompt?.neighborhood).toBe(target.neighborhood);
    expect(prompt?.propertyType).toBe(target.propertyType);

    // Double-approve refused; reject works; decided rows leave the queue.
    const again = await suggest.approvePromptSuggestion(operator, {
      suggestionId: target.id,
    });
    expect(again.ok).toBe(false);
    unwrap(
      await suggest.rejectPromptSuggestion(operator, {
        suggestionId: pending[1]!.id,
      })
    );
    expect(await suggest.listPromptSuggestions(set.id)).toHaveLength(
      pending.length - 2
    );

    // The generated prompt's provenance and dimensions survive the freeze.
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select frozen_prompts from prompt_set_versions
      where prompt_set_id = ${set.id} order by version desc limit 1
    `;
    const frozen = (version?.frozenPrompts as {
      text: string;
      source?: string | null;
      neighborhood?: string | null;
      propertyType?: string | null;
    }[]).find((p) => p.text === target.text);
    expect(frozen).toBeDefined();
    expect(frozen!.source).toBe("generated");
    expect(frozen!.neighborhood).toBe(target.neighborhood);
    expect(frozen!.propertyType).toBe(target.propertyType);
  });
});
