/**
 * Demo seed for the graph platform (spec 018 Part 33, spec 019).
 *
 * Usage: npm run seed:graph
 *
 * Produces a portfolio an operator can actually read: three clients in
 * different states, live and finished workflow runs, a fan-out with one dead
 * provider branch, a low-confidence classification, a verifier disagreement,
 * a human approval that is waiting, an expired claim, an open contradiction, a
 * content action, an attribution chain that stops at "correlated", a weekly
 * brief, and a client whose integration is broken.
 *
 * Idempotent by construction — every insert is keyed, so re-running refreshes
 * the demo rather than doubling it. Safe on a dev database; it refuses to run
 * against anything whose URL does not look local unless SEED_FORCE=1.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import { getEnv } from "@/lib/env";
import { bootstrapWorkflows } from "@/lib/workflow/templates";
import { startWorkflow, advanceWorkflow } from "@/lib/workflow/engine";
import { raiseException } from "@/lib/workflow/exceptions";
import { recordAction, recordRelationship, measureAction } from "@/lib/outcomes/graph";
import { computeClientHealth, recordHealthSnapshot } from "@/lib/control-tower/health";
import { computeCapacity, recordCapacitySnapshot } from "@/lib/control-tower/capacity";
import { claimNextJob, completeJob, failJob } from "@/db/jobs";
import { executeRun } from "@/lib/runs/execute";
import { parseResponse } from "@/lib/parsing/service";
import { computeScores } from "@/lib/scoring/compute";
import { createProject } from "@/lib/projects/service";
import { upsertCompany } from "@/lib/companies/service";
import { setSubjectCompany, proposeClaim, approveClaim } from "@/lib/claims/service";
import { addCompetitor } from "@/lib/competitors/service";
import { createPromptSet, freezePromptSet } from "@/lib/prompts/set-service";
import { addPrompt } from "@/lib/prompts/prompt-service";
import { updateBaselineSettings } from "@/lib/projects/baseline";
import type { CurrentUser } from "@/lib/auth";
import { log } from "@/lib/logger";

const OPERATOR_ID = "00000000-0000-4000-8000-000000000001";

const operator: CurrentUser = {
  id: OPERATOR_ID,
  email: "demo-seed@local",
  name: "Demo seed",
  role: "admin",
};

interface SeedClient {
  key: string;
  name: string;
  /** healthy: measured and moving · at_risk: broken · onboarding: never run */
  posture: "healthy" | "at_risk" | "onboarding";
}

const CLIENTS: SeedClient[] = [
  { key: "meridian", name: "Meridian Realty (demo)", posture: "healthy" },
  { key: "northwind", name: "Northwind Group (demo)", posture: "at_risk" },
  { key: "harborline", name: "Harborline Partners (demo)", posture: "onboarding" },
];

async function main(): Promise<void> {
  const url = getEnv().DATABASE_URL;
  if (!/localhost|127\.0\.0\.1/.test(url) && process.env.SEED_FORCE !== "1") {
    throw new Error(
      `Refusing to seed a non-local database (${url.replace(/:[^:@]+@/, ":***@")}). Set SEED_FORCE=1 if you really mean it.`
    );
  }
  // Demo runs use the mock provider so seeding never spends tokens. The
  // registry refuses mock without this opt-in (a production deploy must
  // never fall back to fabricated answers); a seed target is local-or-forced
  // by the guard above, so the opt-in is safe here.
  process.env.ALLOW_MOCK_PROVIDER = "1";

  await resetDemoData();

  console.log("▸ publishing workflow definitions and the agent registry…");
  const boot = await bootstrapWorkflows();
  console.log(`  ${boot.published.length} workflows, ${boot.agents} agents`);

  for (const client of CLIENTS) {
    console.log(`▸ ${client.name} (${client.posture})…`);
    const projectId = await seedProject(client);
    await seedKnowledge(projectId, client);
    if (client.posture !== "onboarding") {
      await seedMeasurement(projectId, client);
    }
    if (client.posture === "healthy") {
      await seedOutcomeChain(projectId);
    }
    if (client.posture === "at_risk") {
      await seedBrokenIntegration(projectId);
    }
    await seedHealth(projectId);
  }

  await seedCapacity();

  console.log("\n✓ Demo data ready. Open /control-tower.");
  await sql.end();
}

/**
 * Remove the previous demo rows so a re-run produces a clean portfolio rather
 * than a half-updated one.
 *
 * Scoped strictly to rows reachable from a project whose name ends in
 * "(demo)" — the operator's real clients are never touched. Deletes run in
 * foreign-key order inside one transaction: either the demo is fully reset or
 * nothing changed.
 */
async function resetDemoData(): Promise<void> {
  const demoProjects = await sql`select id from projects where name like '%(demo)'`;
  if (demoProjects.length === 0) return;
  const ids = demoProjects.map((r) => r.id as string);
  console.log(`▸ clearing ${ids.length} previous demo client(s)…`);

  // Immutability triggers protect exactly the tables the demo writes to, which
  // is the point of them. Bypassing them is legitimate here and nowhere else:
  // this is a dev-only reset, scoped to rows the seed itself created, inside
  // one transaction, and the triggers go back on before it commits. The same
  // pattern is documented in migration 011.
  // Discovered rather than hard-coded, so a future migration that adds an
  // immutable table does not silently break the reset.
  const protectedTables = await sql`
    select c.relname as table_name, t.tgname as trigger_name
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
    where p.proname = 'forbid_mutation'
      and c.relname not in ('workflow_versions', 'workflow_nodes', 'workflow_edges',
                            'agent_versions')
  `;

  await sql.begin(async (tx) => {
    for (const row of protectedTables) {
      await tx.unsafe(`alter table ${row.tableName} disable trigger ${row.triggerName}`);
    }
    const runIds = (
      await tx`select id from workflow_runs where project_id = any(${ids})`
    ).map((r) => r.id as string);
    const legacyRunIds = (await tx`select id from runs where project_id = any(${ids})`).map(
      (r) => r.id as string
    );
    const assetIds = (
      await tx`select id from content_assets where project_id = any(${ids})`
    ).map((r) => r.id as string);
    const setIds = (await tx`select id from prompt_sets where project_id = any(${ids})`).map(
      (r) => r.id as string
    );

    if (runIds.length > 0) {
      await tx`delete from workflow_transitions where workflow_run_id = any(${runIds})`;
      await tx`delete from quality_gate_results where workflow_run_id = any(${runIds})`;
      await tx`delete from workflow_signals where workflow_run_id = any(${runIds})`;
      await tx`delete from workflow_approvals where workflow_run_id = any(${runIds})`;
      await tx`delete from workflow_exceptions where workflow_run_id = any(${runIds})`;
      await tx`delete from evidence_packets where workflow_run_id = any(${runIds})`;
      await tx`delete from node_runs where workflow_run_id = any(${runIds})`;
    }
    await tx`delete from workflow_exceptions where project_id = any(${ids})`;
    await tx`delete from evidence_packets where project_id = any(${ids})`;
    await tx`delete from workflow_runs where project_id = any(${ids})`;
    await tx`delete from outcome_relationships where project_id = any(${ids})`;
    await tx`delete from action_outcomes where project_id = any(${ids})`;
    await tx`delete from client_health_snapshots where project_id = any(${ids})`;
    await tx`delete from executive_briefs where project_id = any(${ids})`;
    await tx`delete from autonomy_policies where project_id = any(${ids})`;
    await tx`delete from claim_contradictions where project_id = any(${ids})`;
    await tx`delete from claim_versions where claim_id in (
      select id from claims where project_id = any(${ids}))`;
    await tx`delete from accuracy_findings where project_id = any(${ids})`;

    if (assetIds.length > 0) {
      await tx`delete from content_versions where asset_id = any(${assetIds})`;
      await tx`delete from content_assets where id = any(${assetIds})`;
    }
    await tx`delete from gap_findings where project_id = any(${ids})`;
    await tx`delete from tasks where project_id = any(${ids})`;
    await tx`delete from reports where project_id = any(${ids})`;
    await tx`delete from notifications where project_id = any(${ids})`;
    await tx`delete from cycle_runs where project_id = any(${ids})`;
    await tx`delete from claims where project_id = any(${ids})`;

    if (legacyRunIds.length > 0) {
      await tx`delete from intervention_runs where run_id = any(${legacyRunIds})`;
      await tx`delete from evidence_exports where run_id = any(${legacyRunIds})`;
      await tx`delete from audit_samples where run_id = any(${legacyRunIds})`;
      await tx`delete from brand_candidates where first_seen_run_id = any(${legacyRunIds})`;
      await tx`delete from response_parses where run_id = any(${legacyRunIds})`;
      await tx`delete from scores where run_id = any(${legacyRunIds})`;
      await tx`delete from evidence_artifacts where response_id in (
        select id from responses where run_id = any(${legacyRunIds}))`;
      await tx`delete from mentions where response_id in (
        select id from responses where run_id = any(${legacyRunIds}))`;
      await tx`delete from responses where run_id = any(${legacyRunIds})`;
    }
    await tx`delete from interventions where project_id = any(${ids})`;
    await tx`delete from competitors where project_id = any(${ids})`;
    await tx`update projects set baseline_prompt_set_id = null where id = any(${ids})`;
    await tx`delete from runs where project_id = any(${ids})`;
    if (setIds.length > 0) {
      await tx`delete from prompt_set_versions where prompt_set_id = any(${setIds})`;
      await tx`delete from prompts where prompt_set_id = any(${setIds})`;
      await tx`delete from prompt_sets where id = any(${setIds})`;
    }
    await tx`update projects set subject_company_id = null where id = any(${ids})`;
    await tx`delete from projects where id = any(${ids})`;
    await tx`delete from companies where name like '%(demo)%'`;
    // Queued ticks for runs that no longer exist would fail noisily on the
    // next drain; a reset should not leave the queue holding ghosts.
    await tx`
      delete from jobs
      where type = 'advance_workflow'
        and not exists (
          select 1 from workflow_runs w where w.id = (payload->>'runId')::uuid
        )
    `;

    for (const row of protectedTables) {
      await tx.unsafe(`alter table ${row.tableName} enable trigger ${row.triggerName}`);
    }
  });
}

// ------------------------------------------------------------------ client

/**
 * Everything goes through the real services rather than raw inserts, so the
 * seed exercises the same validation, freezing, and audit paths an operator
 * would. A seed that bypasses the services is a seed that can produce state
 * the application itself could never reach.
 */
async function seedProject(client: SeedClient): Promise<string> {
  const existingProject = await sql`select id from projects where name = ${client.name}`;
  if (existingProject.length > 0) return existingProject[0]!.id as string;

  const company = await upsertCompany(operator, {
    name: `${client.name} — subject`,
    aliases: [`${client.key}.example.com`],
    domain: `${client.key}.example.com`,
  });
  if (!company.ok) throw new Error(company.error.message);

  const project = await createProject(operator, { name: client.name });
  if (!project.ok) throw new Error(project.error.message);
  const projectId = project.data.id;

  const subject = await setSubjectCompany(operator, {
    projectId,
    companyId: company.data.id,
  });
  if (!subject.ok) throw new Error(subject.error.message);

  // A competitor, so share metrics and gap findings have something to compare.
  const rival = await upsertCompany(operator, {
    name: `${client.name} rival`,
    aliases: [],
    domain: `rival-${client.key}.example.com`,
  });
  if (!rival.ok) throw new Error(rival.error.message);
  const tracked = await addCompetitor(operator, {
    projectId,
    companyId: rival.data.id,
    tier: "primary",
  });
  if (!tracked.ok) throw new Error(tracked.error.message);

  const set = await createPromptSet(operator, {
    projectId,
    name: `${client.key} baseline`,
  });
  if (!set.ok) throw new Error(set.error.message);

  for (const text of [
    "Who are the best agents in the area?",
    "Which brokerage should a relocating family choose?",
    "Compare local brokerages for first-time buyers.",
    // The mock provider reads markers out of the prompt text; this one lands a
    // genuine low-confidence classification in the review queue.
    "MOCK_AMBIGUOUS Which firm handles waterfront listings?",
  ]) {
    const added = await addPrompt(operator, {
      setId: set.data.id,
      text,
      category: "recommendation",
    });
    if (!added.ok) throw new Error(added.error.message);
  }

  const frozen = await freezePromptSet(operator, { id: set.data.id });
  if (!frozen.ok) throw new Error(frozen.error.message);

  const configured = await updateBaselineSettings(operator, {
    projectId,
    baselinePromptSetId: set.data.id,
    providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
    budgetUsd: 5,
  });
  if (!configured.ok) throw new Error(configured.error.message);

  return projectId;
}

// --------------------------------------------------------------- knowledge

async function seedKnowledge(projectId: string, client: SeedClient): Promise<void> {
  const claims = [
    {
      key: "transactions_2025",
      text: "Closed 118 residential transactions in 2025.",
      privacy: "public",
      status: "approved",
      reviewDate: "2027-01-01",
      allowed: ["closed 118 residential transactions in 2025"],
      prohibited: ["#1 brokerage", "best in the region"],
    },
    {
      key: "founded_year",
      text: "Founded in 2011.",
      privacy: "public",
      status: "approved",
      // Deliberately in the past — the packet must flag it as stale.
      reviewDate: "2026-01-01",
      allowed: [],
      prohibited: [],
    },
    {
      key: "internal_margin",
      text: "Gross margin is 61%.",
      privacy: "restricted",
      status: "approved",
      reviewDate: "2027-01-01",
      allowed: [],
      prohibited: [],
    },
  ];

  for (const claim of claims) {
    const existing = await sql`
      select id from claims where project_id = ${projectId} and key = ${claim.key}
    `;
    if (existing.length > 0) continue;

    const proposed = await proposeClaim(operator, {
      projectId,
      key: claim.key,
      canonicalText: claim.text,
      asOf: "2026-01-31",
      evidence: [
        {
          url: `https://${client.key}.example.com/about`,
          note: `Source for ${claim.key}`,
        },
      ],
    });
    if (!proposed.ok) throw new Error(proposed.error.message);
    const approved = await approveClaim(operator, { claimId: proposed.data.id });
    if (!approved.ok) throw new Error(approved.error.message);

    // Graph-shaped fields spec 018 added on top of spec 008's claim service.
    await sql`
      update claims set
        normalized_predicate = ${claim.key},
        category = 'performance',
        effective_date = '2025-01-01',
        review_date = ${claim.reviewDate},
        verification_status = 'verified',
        confidence = 0.95,
        privacy_status = ${claim.privacy},
        allowed_wording = ${claim.allowed},
        prohibited_wording = ${claim.prohibited}
      where id = ${proposed.data.id}
    `;
  }

  // One open contradiction, so the claim gate has something real to refuse.
  const [target] = await sql`
    select id from claims where project_id = ${projectId} and key = 'transactions_2025'
  `;
  if (target) {
    const open = await sql`
      select id from claim_contradictions
      where claim_id = ${target.id} and status = 'open'
    `;
    if (open.length === 0) {
      await sql`
        insert into claim_contradictions (
          project_id, claim_id, external_source, severity, description, detected_by
        ) values (
          ${projectId}, ${target.id}, 'Public MLS summary', 'high',
          'A public MLS summary reports 94 transactions for 2025, not 118. The figure must not be used until this is resolved.',
          'deterministic'
        )
      `;
    }
  }
}

// ------------------------------------------------------------- measurement

async function seedMeasurement(projectId: string, client: SeedClient): Promise<void> {
  // The at-risk client is configured to require sign-off on every measurement,
  // which gives the demo a real approval sitting in the queue — one you can
  // decide in the UI and watch the paused run resume.
  if (client.posture === "at_risk") {
    await sql`
      insert into autonomy_policies (project_id, action_type, autonomy_level, reason, created_by)
      values (${projectId}, 'benchmark_execution', 2,
        'Client contract requires sign-off before each measurement is accepted.', ${OPERATOR_ID})
      on conflict do nothing
    `;
  }

  const run = await startWorkflow({
    definitionKey: "benchmark_v1",
    projectId,
    idempotencyKey: `seed-benchmark-${client.key}`,
    trigger: "scheduled",
    startedBy: OPERATOR_ID,
  });
  await drain();
  const [state] = await sql`select state from workflow_runs where id = ${run.id}`;
  console.log(`  benchmark workflow → ${state?.state}`);

  // A content asset waiting on a human, plus its approval-gated workflow.
  const [asset] = await sql`
    insert into content_assets (project_id, asset_type, title, status, created_by)
    values (${projectId}, 'comparison_page',
      ${`Comparing brokerages for relocating families — ${client.name}`},
      'verified', ${OPERATOR_ID})
    on conflict do nothing
    returning id
  `;
  // The content workflow is deliberately NOT started here: its drafting node
  // calls a live model, and a seed script that quietly spends tokens is a
  // seed script nobody can run twice. The asset above still lands in the
  // action-required queue as a content approval, and the workflow's shape is
  // visible on /workflows. Start it for real with:
  //   startWorkflowAction({ definitionKey: "content_production_v1", ... })

  // A weekly brief for the healthy client.
  if (client.posture === "healthy") {
    const today = new Date();
    const start = new Date(today.getTime() - 7 * 86_400_000);
    await startWorkflow({
      definitionKey: "weekly_brief_v1",
      projectId,
      input: {
        periodStart: start.toISOString().slice(0, 10),
        periodEnd: today.toISOString().slice(0, 10),
      },
      idempotencyKey: `seed-brief-${client.key}`,
      startedBy: OPERATOR_ID,
    });
    await drain();
  }

  // A verifier disagreement — the kind of exception a human must settle.
  await sql.begin((tx) =>
    raiseException(tx, {
      projectId,
      kind: "verifier_disagreement",
      severity: "medium",
      summary:
        "The classifier and the independent verifier disagree on whether the subject was recommended in two responses.",
      recommendedAction: "Read both responses and record the correct classification.",
    })
  );
}

async function seedBrokenIntegration(projectId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await raiseException(tx, {
      projectId,
      kind: "failed_integration",
      severity: "high",
      summary: "The CRM connection is rejecting our token (401). Lead ingestion has stopped.",
      recommendedAction: "Reauthorise the CRM connection, then backfill the missed window.",
    });
    await raiseException(tx, {
      projectId,
      kind: "renewal_risk",
      severity: "high",
      summary:
        "No published report in 60 days and two open high-severity exceptions — renewal conversation needed.",
      recommendedAction: "Book a review call and publish the outstanding monthly report.",
    });
    await raiseException(tx, {
      projectId,
      kind: "expired_claim",
      severity: "medium",
      summary: '"Founded in 2011" is past its review date and cannot be stated as current.',
      recommendedAction: "Re-verify the claim with the client and approve a new version.",
    });
  });
}

// ---------------------------------------------------------------- outcomes

async function seedOutcomeChain(projectId: string): Promise<void> {
  const existing = await sql`
    select id from action_outcomes where project_id = ${projectId} limit 1
  `;
  if (existing.length > 0) return;

  const [asset] = await sql`
    select id from content_assets where project_id = ${projectId} limit 1
  `;
  const actionId = await sql.begin((tx) =>
    recordAction(tx, {
      projectId,
      actionType: "content_asset",
      hypothesis:
        "A relocation comparison page should improve retrieval for the relocation prompt cluster.",
      contentAssetId: (asset?.id as string) ?? null,
      stateBefore: { recommendationRate: 0.18, citations: 1 },
      promptClusterKeys: ["relocation"],
      landingUrls: ["https://example.com/relocation-guide"],
      completedOn: new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10),
      expectedDaysToImpact: 30,
    })
  );

  await sql.begin((tx) =>
    measureAction(tx, {
      actionOutcomeId: actionId,
      before: { visibility: 0.18, citations: 1, traffic: 210, leads: 3 },
      after: { visibility: 0.31, citations: 4, traffic: 340, leads: 5 },
      materialityThreshold: 0.1,
      confounders: [],
      humanInterpretation:
        "Plausible but unproven: a competitor also went quiet during the window.",
    })
  );

  // The chain stops where the evidence stops. Note the requested label vs the
  // one that is actually written.
  await sql.begin(async (tx) => {
    await recordRelationship(tx, {
      projectId,
      fromKind: "action",
      fromId: actionId,
      toKind: "visibility_change",
      toId: actionId,
      relation: "preceded",
      requestedConfidence: "confirmed",
      basis: "Visibility rose 13pp in the 30-day window after publication.",
      createdByKind: "deterministic",
      hasMatchingIdentifier: false,
    });
    await recordRelationship(tx, {
      projectId,
      fromKind: "visibility_change",
      fromId: actionId,
      toKind: "lead",
      toId: randomUUID(),
      relation: "may_have_influenced",
      requestedConfidence: "correlated",
      basis: "Two leads arrived in the window; neither named an AI assistant as the source.",
      createdByKind: "agent",
    });
  });
}

// ------------------------------------------------------------------ health

async function seedHealth(projectId: string): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86_400_000);
  const snapshot = await computeClientHealth(projectId, {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  });
  await sql.begin((tx) => recordHealthSnapshot(tx, snapshot));
  console.log(
    `  health ${snapshot.overall === null ? "—" : snapshot.overall.toFixed(2)} (confidence ${(snapshot.confidence * 100).toFixed(0)}%, ${snapshot.missing.length} component(s) missing)`
  );
}

async function seedCapacity(): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86_400_000);
  const report = await computeCapacity({
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  });
  await sql.begin((tx) => recordCapacitySnapshot(tx, report));
  console.log(`▸ capacity: ${report.notes}`);
}

// -------------------------------------------------------------------- queue

/** Drain the job queue the way the worker does. */
async function drain(maxJobs = 400): Promise<void> {
  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimNextJob("seed-worker");
    if (!job) return;
    try {
      if (job.type === "advance_workflow") {
        await advanceWorkflow(job.payload.runId as string);
      } else if (job.type === "execute_run") {
        await executeRun(job.payload.runId as string);
      } else if (job.type === "parse_response") {
        await parseResponse(job.payload.responseId as string);
      } else if (job.type === "compute_scores") {
        await computeScores(job.payload.runId as string);
      }
      await completeJob(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      await failJob(job, message);
      log("warn", "seed.job.failed", { type: job.type, message });
    }
  }
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
