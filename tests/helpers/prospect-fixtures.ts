/**
 * Shared prospect-pipeline fixtures (cleanup 2026-08-17). Five integration
 * suites each carried a ~150-line copy of "build a scored prospect through
 * the REAL pipeline"; a pipeline change meant five edits and, once, a
 * missed one. One implementation, parameterized where the suites differed.
 *
 * Everything drives real services with the mock provider — no hand-inserted
 * state (docs/09). Callers pass their own imported modules so each suite
 * keeps its lazy-import pattern and its own DB lifecycle.
 */
import type { CurrentUser } from "@/lib/auth";

export interface PipelineModules {
  sql: (typeof import("@/db/client"))["sql"];
  projectSvc: typeof import("@/lib/projects/service");
  setSvc: typeof import("@/lib/prompts/set-service");
  promptSvc: typeof import("@/lib/prompts/prompt-service");
  runSvc: typeof import("@/lib/runs/service");
  execute: typeof import("@/lib/runs/execute");
  jobs: typeof import("@/db/jobs");
  companySvc: typeof import("@/lib/companies/service");
  claims: typeof import("@/lib/claims/service");
  parsing: typeof import("@/lib/parsing/service");
  scoring: typeof import("@/lib/scoring/compute");
  exclusivity: typeof import("@/lib/exclusivity/service");
  svc: typeof import("@/lib/prospects/service");
}

const unwrap = <T>(
  r: { ok: true; data: T } | { ok: false; error: { message: string } }
): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};

export async function drainJobs(m: Pick<PipelineModules, "jobs" | "execute" | "parsing" | "scoring">): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const job = await m.jobs.claimNextJob("test-worker");
    if (!job) return;
    if (job.type === "execute_run") await m.execute.executeRun(job.payload.runId as string);
    else if (job.type === "parse_response")
      await m.parsing.parseResponse(job.payload.responseId as string);
    else if (job.type === "compute_scores")
      await m.scoring.computeScores(job.payload.runId as string);
    await m.jobs.completeJob(job.id);
  }
}

export interface ScoredRunFixture {
  projectId: string;
  versionId: string;
  runId: string;
  subjectCompanyId: string;
  prospectCompanyId: string;
}

/** Companies (Lumina subject, Acme rival, Rivera Team prospect), a project
 * (optionally kind='prospect'), a frozen 2-prompt set, and a scored mock
 * run (2 prompts × 3 reps = 6 valid responses). */
export async function seedScoredRun(
  m: PipelineModules,
  user: CurrentUser,
  opts: { projectKind?: "client" | "prospect"; projectName?: string } = {}
): Promise<ScoredRunFixture> {
  const subject = unwrap(await m.companySvc.upsertCompany(user, { name: "Lumina" }));
  unwrap(await m.companySvc.upsertCompany(user, { name: "Acme" }));
  const rivera = unwrap(await m.companySvc.upsertCompany(user, { name: "Rivera Team" }));
  const project = unwrap(
    await m.projectSvc.createProject(user, {
      name: opts.projectName ?? "Prospect market",
    })
  );
  if (opts.projectKind === "prospect") {
    await m.sql`update projects set kind = 'prospect' where id = ${project.id}`;
  }
  unwrap(
    await m.claims.setSubjectCompany(user, { projectId: project.id, companyId: subject.id })
  );
  const set = unwrap(
    await m.setSvc.createPromptSet(user, { projectId: project.id, name: "Set" })
  );
  for (const text of [
    "best luxury team in manhattan?",
    "which team should sell my tribeca loft?",
  ]) {
    unwrap(await m.promptSvc.addPrompt(user, { setId: set.id, text, category: "recommendation" }));
  }
  unwrap(await m.setSvc.freezePromptSet(user, { id: set.id }));
  const [version] = await m.sql`
    select id from prompt_set_versions where prompt_set_id = ${set.id}
  `;
  const run = unwrap(
    await m.runSvc.startRun(user, {
      projectId: project.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
      budgetUsd: 5,
      label: "benchmark",
    })
  );
  await drainJobs(m);
  return {
    projectId: project.id,
    versionId: version?.id as string,
    runId: run.id,
    subjectCompanyId: subject.id,
    prospectCompanyId: rivera.id,
  };
}

export interface ProspectFixture extends ScoredRunFixture {
  marketId: string;
  launchId: string;
  prospectId: string;
}

/** seedScoredRun + a Manhattan launch + the Rivera Team prospect linked to
 * its canonical company. */
export async function seedProspect(
  m: PipelineModules,
  operator: CurrentUser,
  admin: CurrentUser,
  opts: { projectKind?: "client" | "prospect" } = {}
): Promise<ProspectFixture> {
  const run = await seedScoredRun(m, operator, opts);
  const market = unwrap(
    await m.exclusivity.createMarket(admin, { name: "Manhattan", kind: "borough", aliases: [] })
  );
  const launch = unwrap(
    await m.svc.createLaunch(operator, {
      name: "Manhattan luxury residential",
      marketId: market.marketId,
      priceSegment: "luxury",
      serviceCategory: "residential brokerage",
    })
  );
  const prospect = unwrap(
    await m.svc.createProspect(operator, {
      launchId: launch.launchId,
      businessName: "Rivera Team",
      prospectType: "team",
      companyId: run.prospectCompanyId,
      teamLeader: "Ana Rivera",
    })
  );
  return {
    ...run,
    marketId: market.marketId,
    launchId: launch.launchId,
    prospectId: prospect.prospectId,
  };
}

/** Through the human gates: benchmark linked, findings generated, the top
 * candidate approved as primary — one publishAudit away from a live page. */
export async function seedApprovedFinding(
  m: PipelineModules,
  operator: CurrentUser,
  admin: CurrentUser,
  opts: { projectKind?: "client" | "prospect" } = {}
): Promise<ProspectFixture & { benchmarkId: string; findingId: string }> {
  const fixture = await seedProspect(m, operator, admin, opts);
  const { benchmarkId } = unwrap(
    await m.svc.linkBenchmark(operator, {
      prospectId: fixture.prospectId,
      runId: fixture.runId,
    })
  );
  unwrap(await m.svc.generateFindings(operator, { benchmarkId }));
  const [top] = await m.sql`
    select id from prospect_findings
    where benchmark_id = ${benchmarkId} and status = 'candidate'
    order by rank_score desc nulls last limit 1
  `;
  unwrap(
    await m.svc.reviewFinding(operator, {
      findingId: top?.id as string,
      decision: "approved",
      makePrimary: true,
    })
  );
  return { ...fixture, benchmarkId, findingId: top?.id as string };
}
