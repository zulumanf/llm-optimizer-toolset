/**
 * E2E fixture seed (spec 049). Drives the REAL services with the mock
 * provider — no hand-inserted UI state; if the pipeline can't produce it,
 * the UI shouldn't be tested against it. Run with DATABASE_URL pointing at
 * the dedicated e2e database, AUTH_MODE=dev, ALLOW_MOCK_PROVIDER=1.
 *
 * Writes ids and the audit token to tests/e2e/.seed-state.json.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { DEV_USER_ID } from "@/lib/auth";
import { seedTestActors } from "../tests/helpers/actors";
import { dispatchOnce } from "@/workers/core";

const ROOT = join(__dirname, "..");

const unwrap = <T,>(
  r: { ok: true; data: T } | { ok: false; error: { message: string } },
  what: string
): T => {
  if (!r.ok) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function drainJobs(): Promise<void> {
  let idleStreak = 0;
  for (let i = 0; i < 400 && idleStreak < 3; i += 1) {
    const outcome = await dispatchOnce("e2e-seed");
    if (outcome.status === "idle") {
      idleStreak += 1;
      await new Promise((r) => setTimeout(r, 150));
    } else {
      idleStreak = 0;
    }
  }
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!/llm_optimizer_e2e/.test(dbUrl)) {
    throw new Error("Refusing: DATABASE_URL must point at llm_optimizer_e2e.");
  }

  console.log("▸ resetting e2e schema…");
  await sql.unsafe("drop schema public cascade; create schema public;");
  execSync(`npx tsx scripts/migrate.ts up --db "${dbUrl}"`, { cwd: ROOT, stdio: "pipe" });
  await seedTestActors(sql);

  const [devUser] = await sql`
    select id, email, name, role from users where id = ${DEV_USER_ID}
  `;
  if (!devUser) throw new Error("dev user not provisioned by seedTestActors");
  const operator: CurrentUser = {
    id: devUser.id as string,
    email: devUser.email as string,
    name: devUser.name as string,
    role: devUser.role as CurrentUser["role"],
  };

  const projectSvc = await import("@/lib/projects/service");
  const companySvc = await import("@/lib/companies/service");
  const claimsSvc = await import("@/lib/claims/service");
  const setSvc = await import("@/lib/prompts/set-service");
  const promptSvc = await import("@/lib/prompts/prompt-service");
  const runSvc = await import("@/lib/runs/service");
  const tasksSvc = await import("@/lib/tasks/service");
  const plansSvc = await import("@/lib/plans/service");
  const attributionSvc = await import("@/lib/attribution/service");
  const exclusivitySvc = await import("@/lib/exclusivity/service");
  const prospectsSvc = await import("@/lib/prospects/service");

  // ---------------------------------------------------------------- client
  console.log("▸ seeding client project + scored run…");
  const subject = unwrap(
    await companySvc.upsertCompany(operator, { name: "Lumina", domain: "lumina.com" }),
    "subject"
  );
  unwrap(await companySvc.upsertCompany(operator, { name: "Acme" }), "acme");
  const rivera = unwrap(
    await companySvc.upsertCompany(operator, { name: "Rivera Team" }),
    "rivera"
  );
  const project = unwrap(
    await projectSvc.createProject(operator, { name: "Lumina Realty" }),
    "project"
  );
  unwrap(
    await claimsSvc.setSubjectCompany(operator, {
      projectId: project.id,
      companyId: subject.id,
    }),
    "subject company"
  );
  const set = unwrap(
    await setSvc.createPromptSet(operator, { projectId: project.id, name: "Core set" }),
    "prompt set"
  );
  for (const p of [
    { text: "best luxury team in manhattan?", category: "recommendation" as const },
    { text: "which team should sell my tribeca loft?", category: "recommendation" as const },
  ]) {
    unwrap(await promptSvc.addPrompt(operator, { setId: set.id, ...p }), "prompt");
  }
  unwrap(await setSvc.freezePromptSet(operator, { id: set.id }), "freeze");
  const [version] = await sql`
    select id from prompt_set_versions where prompt_set_id = ${set.id}
  `;
  const run = unwrap(
    await runSvc.startRun(operator, {
      projectId: project.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
      budgetUsd: 5,
      label: "e2e benchmark",
    }),
    "run"
  );
  await drainJobs();
  const [scored] = await sql`select count(*)::int as n from scores where run_id = ${run.id}`;
  if (Number(scored?.n) === 0) throw new Error("run did not score — seed is broken");

  // ------------------------------------------------------------------ tasks
  console.log("▸ seeding tasks…");
  const [response] = await sql`select id from responses where run_id = ${run.id} limit 1`;
  const evidence = [
    { kind: "response", refId: response?.id as string, note: "e2e seed evidence" },
  ];
  const suggested = unwrap(
    await tasksSvc.suggestTask(operator, {
      projectId: project.id,
      title: "E2E: publish neighborhood guide",
      evidence,
    }),
    "suggested task"
  );
  const overdue = unwrap(
    await tasksSvc.suggestTask(operator, {
      projectId: project.id,
      title: "E2E: fix entity record",
      evidence,
    }),
    "overdue task"
  );
  unwrap(await tasksSvc.approveTask(operator, { taskId: overdue.taskId }), "approve overdue");
  unwrap(
    await tasksSvc.updateTaskDetails(operator, { taskId: overdue.taskId, dueDate: "2026-07-01" }),
    "overdue due date"
  );

  // ------------------------------------------------------------------- plan
  console.log("▸ seeding plan…");
  await sql`
    insert into gap_findings (project_id, run_id, gap_type, finding, detail, severity,
      opportunity_score, detector_version, status)
    values
      (${project.id}, ${run.id}, 'entity', 'E2E entity gap', ${sql.json({
        unbrandedMentionRate: 0.05,
        topCompetitor: "Acme",
        topCompetitorMentionRate: 0.4,
      } as never)}, 0.9, 80, 'gap-detector-v1', 'open'),
      (${project.id}, ${run.id}, 'citation', 'E2E citation gap', ${sql.json({
        totalCitations: 100,
        ownCitations: 0,
      } as never)}, 0.7, 60, 'gap-detector-v1', 'open')
  `;
  const plan = unwrap(await plansSvc.composePlan(operator, { projectId: project.id }), "plan");
  unwrap(await plansSvc.approvePlan(operator, { planId: plan.id }), "approve plan");

  // ---------------------------------------------------------- intervention
  unwrap(
    await attributionSvc.createIntervention(operator, {
      projectId: project.id,
      title: "E2E: shipped brokerage page",
      shippedAt: new Date().toISOString().slice(0, 10),
      promptSetVersionId: version?.id as string,
      postOffsets: ["+2w"],
    }),
    "intervention"
  );

  // --------------------------------------------------------------- prospect
  console.log("▸ seeding prospect + published audit…");
  // Spec 052: draft generation fails closed without a configured legal
  // sender. Same seed the vitest suites use.
  const { setSenderIdentity } = await import("@/lib/outreach/sender-identity");
  const identity = await setSenderIdentity(operator, {
    senderName: "Dana Operator",
    companyName: "AVOS Agency LLC",
    postalAddress: "123 Grand St, Jersey City, NJ 07302",
    replyToEmail: "dana@avos.agency",
  });
  if (!identity.ok) throw new Error(identity.error.message);
  const market = unwrap(
    await exclusivitySvc.createMarket(operator, {
      name: "Manhattan",
      kind: "borough",
      aliases: [],
    }),
    "market"
  );
  const launch = unwrap(
    await prospectsSvc.createLaunch(operator, {
      name: "Manhattan luxury residential",
      marketId: market.marketId,
      priceSegment: "luxury",
      serviceCategory: "residential brokerage",
    }),
    "launch"
  );
  const prospect = unwrap(
    await prospectsSvc.createProspect(operator, {
      launchId: launch.launchId,
      businessName: "Rivera Team",
      prospectType: "team",
      companyId: rivera.id,
      teamLeader: "Ana Rivera",
    }),
    "prospect"
  );
  for (const signal of [
    {
      kind: "ranking" as const,
      label: "Ranked #9 Manhattan team by closed volume",
      valueNumber: 9,
      sourceUrl: "https://example.com/ranking",
    },
    {
      kind: "transaction_volume" as const,
      label: "$18.32M closed volume (sourced)",
      valueNumber: 18_320_000,
      sourceUrl: "https://example.com/volume",
    },
    {
      kind: "transaction_count" as const,
      label: "31 transaction sides (sourced)",
      valueNumber: 31,
      sourceUrl: "https://example.com/sides",
    },
  ]) {
    unwrap(
      await prospectsSvc.addAuthoritySignal(operator, {
        prospectId: prospect.prospectId,
        provenance: "publicly_sourced",
        ...signal,
      }),
      `signal ${signal.kind}`
    );
  }
  const { benchmarkId } = unwrap(
    await prospectsSvc.linkBenchmark(operator, {
      prospectId: prospect.prospectId,
      runId: run.id,
    }),
    "benchmark link"
  );
  unwrap(await prospectsSvc.generateFindings(operator, { benchmarkId }), "findings");
  const [candidate] = await sql`
    select id from prospect_findings
    where prospect_id = ${prospect.prospectId} order by created_at asc limit 1
  `;
  unwrap(
    await prospectsSvc.reviewFinding(operator, {
      findingId: candidate?.id as string,
      decision: "approved",
      makePrimary: true,
    }),
    "primary finding"
  );
  const audit = unwrap(
    await prospectsSvc.publishAudit(operator, { prospectId: prospect.prospectId }),
    "publish audit"
  );

  // Branded link (spec 076): publishAudit auto-mints it; the specs assert
  // both the branded page and the copy control's preference for it.
  const { auditLinkForProspect } = await import("@/lib/prospects/links");
  const branded = await auditLinkForProspect(prospect.prospectId);
  if (!branded) throw new Error("publish did not auto-mint a branded link");

  // ------------------------------------------------- refresh queue (spec 075)
  // A second prospect on its own prospect-kind market project: audit
  // published from a manual run, then a scheduled run prepares exactly one
  // pending refresh candidate for the queue page to render.
  console.log("▸ seeding audit refresh candidate…");
  const refreshSvc = await import("@/lib/prospects/refresh");
  const harbor = unwrap(
    await companySvc.upsertCompany(operator, { name: "Harbor Group" }),
    "harbor company"
  );
  const marketProject = unwrap(
    await projectSvc.createProject(operator, { name: "Prospect market: Manhattan" }),
    "market project"
  );
  await sql`update projects set kind = 'prospect' where id = ${marketProject.id}`;
  unwrap(
    await claimsSvc.setSubjectCompany(operator, {
      projectId: marketProject.id,
      companyId: harbor.id,
    }),
    "market subject"
  );
  const marketSet = unwrap(
    await setSvc.createPromptSet(operator, { projectId: marketProject.id, name: "Market set" }),
    "market set"
  );
  for (const text of [
    "best luxury team in manhattan?",
    "which team should sell my tribeca loft?",
  ]) {
    unwrap(
      await promptSvc.addPrompt(operator, {
        setId: marketSet.id,
        text,
        category: "recommendation",
      }),
      "market prompt"
    );
  }
  unwrap(await setSvc.freezePromptSet(operator, { id: marketSet.id }), "market freeze");
  const [marketVersion] = await sql`
    select id from prompt_set_versions where prompt_set_id = ${marketSet.id}
  `;
  const marketRun = unwrap(
    await runSvc.startRun(operator, {
      projectId: marketProject.id,
      promptSetVersionId: marketVersion?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
      budgetUsd: 5,
      label: "initial market benchmark",
    }),
    "market run"
  );
  await drainJobs();
  const harborProspect = unwrap(
    await prospectsSvc.createProspect(operator, {
      launchId: launch.launchId,
      businessName: "Harbor Group",
      prospectType: "team",
      companyId: harbor.id,
      teamLeader: "Sam Harbor",
    }),
    "harbor prospect"
  );
  const harborLink = unwrap(
    await prospectsSvc.linkBenchmark(operator, {
      prospectId: harborProspect.prospectId,
      runId: marketRun.id,
    }),
    "harbor benchmark"
  );
  unwrap(
    await prospectsSvc.generateFindings(operator, { benchmarkId: harborLink.benchmarkId }),
    "harbor findings"
  );
  const [harborFinding] = await sql`
    select id from prospect_findings
    where benchmark_id = ${harborLink.benchmarkId} and status = 'candidate'
    order by rank_score desc nulls last limit 1
  `;
  unwrap(
    await prospectsSvc.reviewFinding(operator, {
      findingId: harborFinding?.id as string,
      decision: "approved",
      makePrimary: true,
    }),
    "harbor primary finding"
  );
  unwrap(
    await prospectsSvc.publishAudit(operator, { prospectId: harborProspect.prospectId }),
    "harbor audit"
  );
  const weeklyRun = unwrap(
    await runSvc.startRun(
      null,
      {
        projectId: marketProject.id,
        promptSetVersionId: marketVersion?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
        budgetUsd: 5,
        label: "weekly baseline",
      },
      "scheduled"
    ),
    "weekly run"
  );
  await drainJobs();
  const prepared = await refreshSvc.prepareAuditRefreshCandidates({ runId: weeklyRun.id });
  if (prepared.prepared !== 1) {
    throw new Error(
      `refresh seed expected 1 prepared candidate, got ${JSON.stringify(prepared)}`
    );
  }
  const state = {
    clientProjectId: project.id,
    prospectId: prospect.prospectId,
    auditToken: audit.accessToken,
    refreshProspectName: "Harbor Group",
    auditSlug: branded.slug,
    auditKey: branded.key,
    suggestedTaskTitle: "E2E: publish neighborhood guide",
    overdueTaskTitle: "E2E: fix entity record",
  };
  writeFileSync(join(ROOT, "tests/e2e/.seed-state.json"), JSON.stringify(state, null, 2));
  console.log("▸ e2e seed complete");
  await sql.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
