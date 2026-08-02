/**
 * MCP tool registry (spec 033). Every tool is a thin delegation to an
 * existing service or db/ reader — no business logic lives here, and no
 * measurement code was changed to support it. Handlers are transport-free
 * so contract tests exercise them without the SDK; mcp/server.ts adapts
 * them onto stdio.
 */
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth";
import { assertMcpActor } from "@/lib/mcp/context";
import { ClassifiedError, classify } from "@/lib/errors";
import { listProjects, getProject } from "@/db/projects";
import { getSubjectCompany } from "@/db/companies";
import {
  listComparisonCompanies,
  latestScoresByCompany,
  listTopSources,
} from "@/db/competitors";
import { listPromptSets, listVersionSummaries } from "@/db/prompt-sets";
import { getRun, listRuns, listRunCells } from "@/db/runs";
import { currentMentionsForRun, pendingReviewCount } from "@/db/mentions";
import { authorityTrend, latestScoredRunId, selfTiles } from "@/db/dashboard";
import { listGapFindings } from "@/db/gaps";
import { listInterventions } from "@/db/interventions";
import { pendingApprovalsAcrossRuns } from "@/db/workflow";
import { startRun, estimateRunForVersion } from "@/lib/runs/service";
import { createIntervention, interventionView } from "@/lib/attribution/service";
import { findReplay, recordInvocation } from "@/lib/mcp/audit";
import { hashArgs } from "@/lib/mcp/hash";
import {
  citationSourcesSchema,
  createExperimentSchema,
  emptySchema,
  gapReportSchema,
  includeArchivedSchema,
  interventionIdSchema,
  projectIdSchema,
  recordLearningSchema,
  runIdSchema,
  runPromptSetSchema,
  searchLearningsSchema,
  type CreateExperimentInput,
  type RecordLearningInput,
  type RunPromptSetInput,
  type SearchLearningsInput,
} from "@/lib/mcp/schemas";
import { recordLearning, searchLearnings } from "@/lib/learnings/service";

/* ------------------------------------------------------------------ */
/* Registry types                                                      */
/* ------------------------------------------------------------------ */

export type ToolGroup = "observer" | "operator";

export interface McpToolDef {
  name: string;
  description: string;
  group: ToolGroup;
  /** Strict zod object — unknown keys are rejected at the boundary. */
  schema: z.ZodTypeAny;
  handler: (actor: CurrentUser, input: never) => Promise<unknown>;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { kind: string; message: string } };

/** Unwrap the services' ActionResult union into a thrown ClassifiedError. */
function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: { kind: string; message: string } }
): T {
  if (result.ok) return result.data;
  throw new ClassifiedError(
    result.error.kind as ConstructorParameters<typeof ClassifiedError>[0],
    result.error.message
  );
}

async function requireProject(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new ClassifiedError("not_found", "Project not found.");
  return project;
}

/* ------------------------------------------------------------------ */
/* Mutation plumbing: idempotency + append-only ledger (migration 039) */
/* ------------------------------------------------------------------ */

interface MutationOutcome {
  entityKind: string;
  entityId: string;
  data: unknown;
}

async function executeMutation(opts: {
  tool: string;
  actor: CurrentUser;
  input: Record<string, unknown>;
  run: () => Promise<MutationOutcome>;
}): Promise<unknown> {
  const key = (opts.input.idempotency_key as string | undefined) ?? null;
  if (key) {
    const prior = await findReplay(opts.tool, key);
    if (prior) {
      return {
        idempotent_replay: true,
        entity_kind: prior.entityKind,
        entity_id: prior.entityId,
      };
    }
  }
  const argsHash = hashArgs(opts.input);
  try {
    const outcome = await opts.run();
    const recorded = await recordInvocation({
      tool: opts.tool,
      actorId: opts.actor.id,
      argsHash,
      idempotencyKey: key,
      outcome: "ok",
      entityKind: outcome.entityKind,
      entityId: outcome.entityId,
    });
    if (!recorded) {
      // Both racers executed; never pretend otherwise.
      throw new ClassifiedError(
        "conflict",
        `Idempotency key was used concurrently — two executions happened. Verify state for ${outcome.entityKind} ${outcome.entityId}.`
      );
    }
    return {
      idempotent_replay: false,
      entity_kind: outcome.entityKind,
      entity_id: outcome.entityId,
      ...(outcome.data as Record<string, unknown>),
    };
  } catch (err) {
    const classified = classify(err);
    if (classified.kind !== "conflict" || !classified.message.startsWith("Idempotency")) {
      await recordInvocation({
        tool: opts.tool,
        actorId: opts.actor.id,
        argsHash,
        idempotencyKey: key,
        outcome: "error",
        error: classified.message,
      });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Observer tools (read-only)                                          */
/* ------------------------------------------------------------------ */

const observerTools: McpToolDef[] = [
  {
    name: "list_projects",
    description:
      "List projects (client engagements) with prompt-set and run counts. Active only unless include_archived.",
    group: "observer",
    schema: includeArchivedSchema,
    handler: async (_actor, input: { include_archived: boolean }) =>
      listProjects({ includeArchived: input.include_archived }),
  },
  {
    name: "get_project",
    description:
      "One project with its subject company (the brand being measured) and tracked competitors.",
    group: "observer",
    schema: projectIdSchema,
    handler: async (_actor, input: { project_id: string }) => {
      const project = await requireProject(input.project_id);
      const [subject, companies] = await Promise.all([
        getSubjectCompany(input.project_id),
        listComparisonCompanies(input.project_id),
      ]);
      return { project, subject_company: subject, companies };
    },
  },
  {
    name: "list_prompt_sets",
    description:
      "Prompt sets for a project with their frozen versions. Runs always execute a frozen version, never live prompts.",
    group: "observer",
    schema: projectIdSchema,
    handler: async (_actor, input: { project_id: string }) => {
      await requireProject(input.project_id);
      const sets = await listPromptSets(input.project_id);
      return Promise.all(
        sets.map(async (set) => ({
          ...set,
          versions: await listVersionSummaries(set.id),
        }))
      );
    },
  },
  {
    name: "list_runs",
    description: "Benchmark runs for a project: status, providers, cost, timing.",
    group: "observer",
    schema: projectIdSchema,
    handler: async (_actor, input: { project_id: string }) => {
      await requireProject(input.project_id);
      return listRuns(input.project_id);
    },
  },
  {
    name: "get_run_status",
    description:
      "One run with cell counts (captured, failed, refusals) and the pending human-review count that gates scoring.",
    group: "observer",
    schema: runIdSchema,
    handler: async (_actor, input: { run_id: string }) => {
      const run = await getRun(input.run_id);
      if (!run) throw new ClassifiedError("not_found", "Run not found.");
      const [cells, pendingReview] = await Promise.all([
        listRunCells(input.run_id),
        pendingReviewCount(input.run_id),
      ]);
      return {
        run,
        cells: {
          total: cells.length,
          captured: cells.filter((c) => c.error === null).length,
          failed: cells.filter((c) => c.error !== null).length,
          refusals: cells.filter((c) => c.refusal).length,
        },
        pending_review: pendingReview,
      };
    },
  },
  {
    name: "get_prompt_results",
    description:
      "Current mention classifications for a run: per response and company — mentioned, recommended, list position, sentiment, cited URLs, parser version, confidence. Empty until the run is parsed.",
    group: "observer",
    schema: runIdSchema,
    handler: async (_actor, input: { run_id: string }) => {
      const run = await getRun(input.run_id);
      if (!run) throw new ClassifiedError("not_found", "Run not found.");
      return { run_status: run.status, mentions: await currentMentionsForRun(input.run_id) };
    },
  },
  {
    name: "get_visibility_summary",
    description:
      "The project dashboard's numbers: latest scored run, self-company metric tiles, and the authority-score trend across runs.",
    group: "observer",
    schema: projectIdSchema,
    handler: async (_actor, input: { project_id: string }) => {
      await requireProject(input.project_id);
      const [runId, tiles, trend] = await Promise.all([
        latestScoredRunId(input.project_id),
        selfTiles(input.project_id),
        authorityTrend(input.project_id),
      ]);
      return { latest_scored_run_id: runId, tiles, trend };
    },
  },
  {
    name: "compare_competitors",
    description:
      "Comparison matrix: every tracked company (self first) with its latest scored metrics (provider 'all', current scoring version only — cross-version comparison is forbidden).",
    group: "observer",
    schema: projectIdSchema,
    handler: async (_actor, input: { project_id: string }) => {
      await requireProject(input.project_id);
      const [companies, scores] = await Promise.all([
        listComparisonCompanies(input.project_id),
        latestScoresByCompany(input.project_id),
      ]);
      return companies.map((c) => ({
        company_id: c.companyId,
        company_name: c.companyName,
        is_self: c.isSelf,
        tier: c.tier,
        metrics: scores.get(c.companyId) ?? {},
      }));
    },
  },
  {
    name: "get_citation_sources",
    description:
      "Domains the answer engines actually cite for this project, with citation counts, source type (portal/news/social/…), and relationship (owned/competitor/third_party).",
    group: "observer",
    schema: citationSourcesSchema,
    handler: async (_actor, input: { project_id: string; limit: number }) => {
      await requireProject(input.project_id);
      return listTopSources(input.project_id, input.limit);
    },
  },
  {
    name: "get_gap_report",
    description:
      "Gap findings (gap-detector-v1: entity, branded recognition, recommendation, citation, category share, source target) with severity and opportunity score. Open findings first.",
    group: "observer",
    schema: gapReportSchema,
    handler: async (_actor, input: { project_id: string; run_id?: string }) => {
      await requireProject(input.project_id);
      return listGapFindings(input.project_id, input.run_id);
    },
  },
  {
    name: "list_experiments",
    description:
      "Interventions (experiments) for a project: what shipped, baseline strength, and how many baseline/post runs exist.",
    group: "observer",
    schema: projectIdSchema,
    handler: async (_actor, input: { project_id: string }) => {
      await requireProject(input.project_id);
      return listInterventions(input.project_id);
    },
  },
  {
    name: "get_experiment",
    description:
      "Before/after verdicts for one intervention, computed on read from stored scores — includes instrument-change and confounding-overlap flags.",
    group: "observer",
    schema: interventionIdSchema,
    handler: async (_actor, input: { intervention_id: string }) =>
      interventionView(input.intervention_id),
  },
  {
    name: "search_learnings",
    description:
      "Search durable, confidence-labeled learnings (spec 034) by text, project, or category. Project searches include cross-project learnings. Retired learnings are excluded unless include_retired.",
    group: "observer",
    schema: searchLearningsSchema,
    handler: async (_actor, input: SearchLearningsInput) =>
      searchLearnings({
        query: input.query,
        projectId: input.project_id,
        category: input.category,
        includeRetired: input.include_retired,
      }),
  },
  {
    name: "list_pending_approvals",
    description:
      "Every undecided workflow approval across all runs, ordered by urgency. Deciding them happens in the /approvals UI, never through MCP.",
    group: "observer",
    schema: emptySchema,
    handler: async () => pendingApprovalsAcrossRuns(),
  },
];

/* ------------------------------------------------------------------ */
/* Operator tools (mutating — dry-run, idempotency, ledger)            */
/* ------------------------------------------------------------------ */


const operatorTools: McpToolDef[] = [
  {
    name: "run_prompt_set",
    description:
      "Start a benchmark run of a frozen prompt-set version — the same gates as the UI (pinned models, pricing required, hard budget cap). dry_run returns the cost estimate without creating anything. Without an idempotency_key, replay protection is the caller's responsibility.",
    group: "operator",
    schema: runPromptSetSchema,
    handler: async (actor, input: RunPromptSetInput) => {
      const serviceInput = {
        projectId: input.project_id,
        promptSetVersionId: input.prompt_set_version_id,
        label: input.label,
        providers: input.providers,
        budgetUsd: input.budget_usd,
      };
      if (input.dry_run) {
        const estimate = unwrap(
          await estimateRunForVersion({
            promptSetVersionId: input.prompt_set_version_id,
            providers: input.providers,
          })
        );
        return { dry_run: true, estimate };
      }
      return executeMutation({
        tool: "run_prompt_set",
        actor,
        input,
        run: async () => {
          const run = unwrap(await startRun(actor, serviceInput, "manual"));
          return {
            entityKind: "run",
            entityId: run.id,
            data: { run_id: run.id, status: run.status },
          };
        },
      });
    },
  },
  {
    name: "create_experiment",
    description:
      "Register an intervention (experiment): links the strongest available baseline runs and schedules +2w/+6w/+12w retest runs of the same frozen prompt-set version. dry_run validates the input shape only (validated_only: true) — it does not check baselines.",
    group: "operator",
    schema: createExperimentSchema,
    handler: async (actor, input: CreateExperimentInput) => {
      if (input.dry_run) {
        return { dry_run: true, validated_only: true };
      }
      return executeMutation({
        tool: "create_experiment",
        actor,
        input,
        run: async () => {
          const created = unwrap(
            await createIntervention(actor, {
              projectId: input.project_id,
              title: input.title,
              description: input.description,
              shippedAt: input.shipped_at,
              urls: input.urls,
              promptSetVersionId: input.prompt_set_version_id,
              taskId: input.task_id,
              hypothesis: input.hypothesis,
            })
          );
          return {
            entityKind: "intervention",
            entityId: created.interventionId,
            data: {
              intervention_id: created.interventionId,
              baseline_run_ids: created.baselineRunIds,
              baseline_weak: created.baselineWeak,
              scheduled_offsets: created.scheduledOffsets,
            },
          };
        },
      });
    },
  },
  {
    name: "record_learning",
    description:
      "Record a durable learning with a confidence label. 'confirmed'/'strongly_supported' require measured source action outcomes — a learning that asserts evidence must point at it. dry_run validates only. Learnings are never auto-generated; calling this is an explicit operator act.",
    group: "operator",
    schema: recordLearningSchema,
    handler: async (actor, input: RecordLearningInput) => {
      if (input.dry_run) {
        return { dry_run: true, validated_only: true };
      }
      return executeMutation({
        tool: "record_learning",
        actor,
        input,
        run: async () => {
          const learning = unwrap(
            await recordLearning(actor, {
              projectId: input.project_id ?? null,
              category: input.category,
              statement: input.statement,
              rationale: input.rationale,
              confidenceLabel: input.confidence_label,
              sourceActionOutcomeIds: input.source_action_outcome_ids,
              evidenceNote: input.evidence_note,
            })
          );
          return {
            entityKind: "learning",
            entityId: learning.id,
            data: {
              learning_id: learning.id,
              confidence_label: learning.confidenceLabel,
            },
          };
        },
      });
    },
  },
];

export const MCP_TOOLS: McpToolDef[] = [...observerTools, ...operatorTools];

/* ------------------------------------------------------------------ */
/* Invocation                                                          */
/* ------------------------------------------------------------------ */

export async function invokeTool(
  actor: CurrentUser,
  name: string,
  rawInput: unknown
): Promise<ToolResult> {
  // Defense in depth: the server already refuses to start as a non-staff
  // identity; re-checking per invocation keeps the guarantee even if a
  // caller bypasses mcp/server.ts. Write authorization stays where it
  // lives — the services' assertCanWrite — MCP adds no role model.
  try {
    assertMcpActor(actor);
  } catch (err) {
    return {
      ok: false,
      error: { kind: "forbidden", message: (err as Error).message },
    };
  }
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, error: { kind: "validation", message: `Unknown tool: ${name}` } };
  }
  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") ?? "";
    return {
      ok: false,
      error: {
        kind: "validation",
        message: `${path ? `${path}: ` : ""}${first?.message ?? "Invalid input."}`,
      },
    };
  }
  try {
    const data = await (
      tool.handler as (a: CurrentUser, i: unknown) => Promise<unknown>
    )(actor, parsed.data);
    return { ok: true, data };
  } catch (err) {
    const classified = classify(err);
    // Classified messages are operator-safe; anything else stays generic.
    return { ok: false, error: { kind: classified.kind, message: classified.message } };
  }
}
