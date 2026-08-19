/**
 * Integration tests for spec 008 — per-project subjects (no cross-client
 * talk) and the verified claims register.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000301",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("client knowledge (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    mock = await import("@/lib/ai/mock");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, claims, tasks, evidence, intervention_runs,
       interventions, reports, brand_candidates, competitors, scores, sources,
       response_parses, mentions, companies, responses, runs,
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

  async function makeClientProject(
    name: string,
    companyName: string,
    aliases: string[] = []
  ): Promise<{ projectId: string; companyId: string }> {
    const company = await companySvc.upsertCompany(user, {
      name: companyName,
      aliases,
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name });
    if (!project.ok) throw new Error(project.error.message);
    const subject = await claims.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    if (!subject.ok) throw new Error(subject.error.message);
    return { projectId: project.data.id, companyId: company.data.id };
  }

  async function runForProject(projectId: string, promptText: string): Promise<string> {
    const set = await setSvc.createPromptSet(user, { projectId, name: "Set" });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: promptText,
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(user, {
      projectId,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
      budgetUsd: 5,
      label: `${projectId.slice(0, 8)} run`,
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return started.data.id;
  }

  it("two clients, two subjects — measurements never cross-talk", async () => {
    // Mock canned text mentions "Acme" and "Lumina"
    const clientA = await makeClientProject("Client A", "Lumina", ["lumina.com"]);
    const clientB = await makeClientProject("Client B", "Acme");

    const runA = await runForProject(clientA.projectId, "best tools?");
    const runB = await runForProject(clientB.projectId, "best tools?");

    // Client A's run never mentions Client B's subject, and vice versa
    const mentionsA = await sql`
      select distinct company_id from mentions m
      join responses r on r.id = m.response_id where r.run_id = ${runA}
    `;
    const mentionsB = await sql`
      select distinct company_id from mentions m
      join responses r on r.id = m.response_id where r.run_id = ${runB}
    `;
    expect(mentionsA.map((m) => m.companyId)).toEqual([clientA.companyId]);
    expect(mentionsB.map((m) => m.companyId)).toEqual([clientB.companyId]);

    const scoresA = await sql`
      select distinct company_id from scores where run_id = ${runA}
    `;
    expect(scoresA.map((s) => s.companyId)).toEqual([clientA.companyId]);
  });

  it("parse refuses when a project has no subject and no legacy is_self", async () => {
    const project = await projectSvc.createProject(user, { name: "No Subject" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "anything",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
      budgetUsd: 5,
      label: "no subject run",
    });
    const job = await jobs.claimNextJob("test-worker");
    await execute.executeRun(job!.payload.runId as string);
    // Lifecycle events (2.6) enqueue deliver_events between execute and
    // parse — claim past anything that isn't the parse job.
    let parseJob = await jobs.claimNextJob("test-worker");
    while (parseJob && parseJob.type !== "parse_response") {
      await jobs.completeJob(parseJob.id);
      parseJob = await jobs.claimNextJob("test-worker");
    }
    await expect(
      parsing.parseResponse(parseJob!.payload.responseId as string)
    ).rejects.toThrow(/subject company/);
  });

  it("legacy is_self still works as the fallback subject", async () => {
    await companySvc.upsertCompany(user, { name: "Lumina", isSelf: true });
    const project = await projectSvc.createProject(user, { name: "Legacy" });
    if (!project.ok) throw new Error(project.error.message);
    const runId = await runForProject(project.data.id, "best tools?");
    const [count] = await sql`
      select count(*)::int as n from scores where run_id = ${runId}
    `;
    expect(count?.n).toBeGreaterThan(0);
  });

  it("claims: evidence required, approve supersedes, only proposed rejectable", async () => {
    const { projectId } = await makeClientProject("Claims Co", "Lumina");

    const noEvidence = await claims.proposeClaim(user, {
      projectId,
      key: "category_positioning",
      canonicalText: "Link-in-bio for realtors",
      evidence: [],
    });
    expect(noEvidence.ok).toBe(false);

    const v1 = await claims.proposeClaim(user, {
      projectId,
      key: "Category Positioning", // normalizes to category_positioning
      canonicalText: "Lumina is a link-in-bio tool built for real estate agents.",
      asOf: "2026-07-27",
      evidence: [{ url: "https://lumina.com", note: "Homepage positioning" }],
    });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.data.key).toBe("category_positioning");

    const approved1 = await claims.approveClaim(user, { claimId: v1.data.id });
    expect(approved1.ok).toBe(true);
    if (approved1.ok) expect(approved1.data.supersededId).toBeNull();

    // Second version of the same fact supersedes on approval
    const v2 = await claims.proposeClaim(user, {
      projectId,
      key: "category_positioning",
      canonicalText: "Lumina is the link-in-bio platform for real estate agents.",
      evidence: [{ url: "https://lumina.com/about", note: "Updated wording" }],
    });
    if (!v2.ok) throw new Error(v2.error.message);
    const approved2 = await claims.approveClaim(user, { claimId: v2.data.id });
    expect(approved2.ok).toBe(true);
    if (approved2.ok) expect(approved2.data.supersededId).toBe(v1.data.id);

    const all = await claims.listClaims(projectId);
    const statuses = all
      .filter((c) => c.key === "category_positioning")
      .map((c) => c.status)
      .sort();
    expect(statuses).toEqual(["approved", "superseded"]);

    // Approved claims can't be rejected; double-approve fails
    const rejectApproved = await claims.rejectClaim(user, {
      claimId: v2.data.id,
    });
    expect(rejectApproved.ok).toBe(false);
    const doubleApprove = await claims.approveClaim(user, { claimId: v1.data.id });
    expect(doubleApprove.ok).toBe(false);

    const audits = await sql`
      select action from audit_log where entity = 'claim' order by at
    `;
    expect(audits.map((a) => a.action)).toEqual([
      "claim.propose",
      "claim.approve",
      "claim.propose",
      "claim.approve",
    ]);
  });

  it("operator-set review dates enable expiry detection; contradictions are resolvable (D2)", async () => {
    const { projectId } = await makeClientProject("Lifecycle Co", "Lumina");
    const proposed = await claims.proposeClaim(user, {
      projectId,
      key: "office_count",
      canonicalText: "Lumina operates three offices.",
      evidence: [{ url: "https://lumina.com/about", note: "About page" }],
    });
    if (!proposed.ok) throw new Error(proposed.error.message);
    await claims.approveClaim(user, { claimId: proposed.data.id });

    // Before D2 nothing wrote review_date, so this detector was blind by
    // construction: review_date was null on every claim, everywhere.
    const detectors = await import("@/lib/knowledge/maintenance/detectors");
    const before = await detectors.detectExpiredClaims(projectId);
    expect(before.findings).toHaveLength(0);

    const dated = await claims.setClaimDates(user, {
      claimId: proposed.data.id,
      effectiveDate: "2026-01-01",
      reviewDate: "2026-06-01", // already past — the promise to re-verify broke
    });
    expect(dated.ok).toBe(true);

    const after = await detectors.detectExpiredClaims(projectId);
    expect(after.findings).toHaveLength(1);
    expect(after.findings[0]!.summary).toContain("office_count");

    const listed = await claims.listClaims(projectId);
    const claim = listed.find((c) => c.id === proposed.data.id)!;
    expect(claim.effectiveDate).toBe("2026-01-01");
    expect(claim.reviewDate).toBe("2026-06-01");

    // Contradictions: raise one by hand, then settle it through the new
    // write path — resolveContradiction previously had zero callers.
    const [contradiction] = await sql`
      insert into claim_contradictions (project_id, claim_id, severity,
        description, detected_by)
      values (${projectId}, ${proposed.data.id}, 'high',
        'Office count disagrees with the site footer', 'value_divergence')
      returning id
    `;
    const noNote = await claims.resolveClaimContradiction(user, {
      contradictionId: contradiction!.id,
      status: "resolved",
      resolution: "",
    });
    expect(noNote.ok).toBe(false);

    const settled = await claims.resolveClaimContradiction(user, {
      contradictionId: contradiction!.id,
      status: "resolved",
      resolution: "Re-verified against the site footer; approved corrected claim.",
    });
    expect(settled.ok).toBe(true);

    const [row] = await sql`
      select status, resolution from claim_contradictions where id = ${contradiction!.id}
    `;
    expect(row!.status).toBe("resolved");
    const [audit] = await sql`
      select action from audit_log where entity = 'claim_contradiction'
    `;
    expect(audit!.action).toBe("claim.contradiction.resolved");

    // Settling twice is refused — the record is already made.
    const again = await claims.resolveClaimContradiction(user, {
      contradictionId: contradiction!.id,
      status: "dismissed",
      resolution: "duplicate",
    });
    expect(again.ok).toBe(false);
  });

  it("instructions: create governs immediately, approval gates, revision versions (D3)", async () => {
    const { projectId } = await makeClientProject("Rules Co", "Lumina");
    const instructions = await import("@/lib/knowledge/instructions/service");

    // The layer was schema-complete with no writer: production tables were
    // empty and every drafting packet ran with no brand-voice rules.
    const created = await instructions.createInstruction(user, {
      projectId,
      instructionType: "brand_voice",
      scope: "project",
      title: "Plain voice",
      body: "Write plainly; never use superlatives the claims do not support.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let resolved = await instructions.resolveInstructions({ projectId });
    expect(resolved.instructions.map((i) => i.title)).toContain("Plain voice");

    // requiresApproval: a draft rule does not govern until a human approves.
    const gated = await instructions.createInstruction(user, {
      projectId,
      instructionType: "prohibited_claim",
      scope: "project",
      title: "No exclusivity wording",
      body: "Never imply the client is the only provider in a market.",
      requiresApproval: true,
    });
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;

    resolved = await instructions.resolveInstructions({ projectId });
    expect(resolved.instructions.map((i) => i.title)).not.toContain(
      "No exclusivity wording"
    );
    expect(resolved.excluded.some((e) => e.title === "No exclusivity wording")).toBe(true);

    const pending = await instructions.pendingInstructionApprovals(projectId);
    expect(pending.map((p) => p.title)).toContain("No exclusivity wording");

    const approved = await instructions.approveInstructionVersion(user, {
      versionId: gated.data.versionId,
    });
    expect(approved.ok).toBe(true);

    resolved = await instructions.resolveInstructions({ projectId });
    expect(resolved.instructions.map((i) => i.title)).toContain("No exclusivity wording");

    // Revision mints an immutable new version; the old one stays readable.
    const revised = await instructions.reviseInstruction(user, {
      instructionId: created.data.instructionId,
      body: "Write plainly. Cite a claim for every superlative, or cut it.",
      changeReason: "Tightened after a draft slipped an uncited superlative through.",
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.data.version).toBe(2);

    resolved = await instructions.resolveInstructions({ projectId });
    const active = resolved.instructions.find((i) => i.title === "Plain voice")!;
    expect(active.version).toBe(2);
    expect(active.body).toContain("Cite a claim");

    const versions = await sql`
      select count(*)::int as n from knowledge_instruction_versions
      where instruction_id = ${created.data.instructionId}
    `;
    expect(Number(versions[0]!.n)).toBe(2);
  });
});
