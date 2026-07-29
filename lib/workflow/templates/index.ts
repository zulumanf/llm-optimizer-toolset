/**
 * Workflow template registry (spec 018 Part 27).
 *
 * Importing this module registers every template's node handlers as a side
 * effect. The worker and any server action that starts a workflow must import
 * it first — `bootstrapWorkflows()` is the single call that does both jobs.
 */
import { registerDefinition } from "@/lib/workflow/engine";
import { syncAgentRegistry } from "@/lib/agents/registry";
import { log } from "@/lib/logger";
import type { WorkflowDefinition } from "@/lib/workflow/types";

import { benchmarkWorkflow, BENCHMARK_WORKFLOW_KEY } from "@/lib/workflow/templates/benchmark";
import {
  contentProductionWorkflow,
  CONTENT_WORKFLOW_KEY,
} from "@/lib/workflow/templates/content-production";
import {
  weeklyBriefWorkflow,
  WEEKLY_BRIEF_WORKFLOW_KEY,
} from "@/lib/workflow/templates/weekly-brief";

export { BENCHMARK_WORKFLOW_KEY, CONTENT_WORKFLOW_KEY, WEEKLY_BRIEF_WORKFLOW_KEY };

export const WORKFLOW_TEMPLATES: WorkflowDefinition[] = [
  benchmarkWorkflow,
  contentProductionWorkflow,
  weeklyBriefWorkflow,
];

/**
 * Publish every template and mirror the agent registry. Idempotent: an
 * unchanged graph re-registers to the same version, so this is safe to call on
 * every worker boot and in every test setup.
 */
export async function bootstrapWorkflows(): Promise<{
  published: { key: string; version: number; created: boolean }[];
  agents: number;
}> {
  const published: { key: string; version: number; created: boolean }[] = [];
  for (const template of WORKFLOW_TEMPLATES) {
    const result = await registerDefinition(template);
    published.push({ key: template.key, version: result.version, created: result.created });
  }
  const agents = await syncAgentRegistry();
  log("info", "workflow.bootstrap", {
    templates: published.length,
    newVersions: published.filter((p) => p.created).length,
    agents: agents.agents,
  });
  return { published, agents: agents.agents };
}
