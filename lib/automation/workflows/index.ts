/**
 * The automation workflow registry.
 *
 * `bootstrapAutomation()` is the single call that makes the layer live: it
 * registers node handlers, publishes every workflow version, and installs the
 * declared triggers and event subscriptions. Idempotent — an unchanged graph
 * re-registers to the same version — so it is safe on every worker boot and in
 * every test setup.
 */
import { registerAutomationNodes } from "@/lib/automation/nodes";
import { registerWorkflow, registeredWorkflows } from "@/lib/automation/runtime";
import { registerTrigger } from "@/lib/triggers/service";
import { upsertSubscription } from "@/db/events";
import { sql } from "@/db/client";
import { log } from "@/lib/logger";
import type { AutomationWorkflowDefinition } from "@/lib/automation/types";

import { revenueWorkflows } from "@/lib/automation/workflows/revenue";
import { deliveryWorkflows } from "@/lib/automation/workflows/delivery";
import { authorityWorkflows } from "@/lib/automation/workflows/authority";
import { operationsWorkflows } from "@/lib/automation/workflows/operations";

export * from "@/lib/automation/workflows/revenue";
export * from "@/lib/automation/workflows/delivery";
export * from "@/lib/automation/workflows/authority";
export * from "@/lib/automation/workflows/operations";

export const AUTOMATION_WORKFLOWS: AutomationWorkflowDefinition[] = [
  ...revenueWorkflows,
  ...deliveryWorkflows,
  ...authorityWorkflows,
  ...operationsWorkflows,
];

export interface BootstrapResult {
  nodes: number;
  workflows: { key: string; version: number; created: boolean }[];
  triggers: number;
  subscriptions: number;
  errors: string[];
}

/**
 * Install the declared triggers and subscriptions for one workflow.
 *
 * Schedule triggers are created **disabled** at platform scope when the workflow
 * is client-scoped: a per-client schedule needs a client, and silently creating
 * a global one would fire a client workflow with no client. The configurator
 * enables them per client.
 */
async function installTriggers(
  definition: AutomationWorkflowDefinition,
  errors: string[]
): Promise<{ triggers: number; subscriptions: number }> {
  let triggers = 0;
  let subscriptions = 0;

  for (const declaration of definition.triggers) {
    try {
      if (declaration.kind === "schedule") {
        await registerTrigger({
          key: `${definition.key}:${declaration.key}`,
          kind: "schedule",
          workflowKey: definition.key,
          // Client-scoped workflows get a template trigger that an operator
          // clones per client; it stays disabled so it cannot fire unscoped.
          projectId: null,
          name: declaration.description,
          description: declaration.description,
          enabled: definition.clientScope === "platform_only",
          cron: declaration.cron,
          timezone: declaration.timezone ?? "UTC",
          missedRunPolicy: declaration.missedRunPolicy ?? "run_once",
        });
        triggers += 1;
      } else if (declaration.kind === "threshold") {
        await registerTrigger({
          key: `${definition.key}:${declaration.key}`,
          kind: "threshold",
          workflowKey: definition.key,
          projectId: null,
          name: declaration.description,
          description: declaration.description,
          enabled: definition.clientScope === "platform_only",
          metricKey: declaration.metricKey,
          comparison: declaration.comparison,
          thresholdValue: declaration.thresholdValue,
          lookbackDays: declaration.lookbackDays,
          minimumSample: declaration.minimumSample,
          cron: declaration.cron ?? "*/30 * * * *",
        });
        triggers += 1;
      } else if (declaration.kind === "domain_event") {
        await sql.begin((tx) =>
          upsertSubscription(tx, {
            eventType: declaration.eventType,
            workflowKey: definition.key,
            projectId: null,
            filter: declaration.filter ?? { kind: "always" },
            idempotencyTemplate:
              declaration.idempotencyTemplate ?? `${definition.key}:{{event.id}}`,
            autonomyNote: declaration.autonomyNote,
            acceptedVersions: [1],
            enabled: true,
            createdBy: null,
          })
        );
        subscriptions += 1;
      } else if (declaration.kind === "webhook") {
        await registerTrigger({
          key: `${definition.key}:${declaration.key}`,
          kind: "webhook",
          workflowKey: definition.key,
          projectId: null,
          name: declaration.description,
          description: declaration.description,
          // A webhook endpoint needs a secret before it can accept anything;
          // creating it enabled would accept unsigned traffic.
          enabled: false,
          config: { eventType: declaration.eventType, provider: declaration.provider },
        });
        triggers += 1;
      }
      // Manual triggers need no installation — they are a server action.
    } catch (err) {
      errors.push(
        `${definition.key} trigger "${declaration.kind}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { triggers, subscriptions };
}

export async function bootstrapAutomation(options?: {
  installTriggers?: boolean;
}): Promise<BootstrapResult> {
  const nodes = registerAutomationNodes();
  const workflows: BootstrapResult["workflows"] = [];
  const errors: string[] = [];
  let triggerCount = 0;
  let subscriptionCount = 0;

  for (const definition of AUTOMATION_WORKFLOWS) {
    try {
      const result = await registerWorkflow(definition);
      workflows.push({
        key: definition.key,
        version: result.version,
        created: result.created,
      });
      if (options?.installTriggers !== false) {
        const installed = await installTriggers(definition, errors);
        triggerCount += installed.triggers;
        subscriptionCount += installed.subscriptions;
      }
    } catch (err) {
      // One bad template must not stop the rest from publishing, but the failure
      // is collected and surfaced — never swallowed.
      errors.push(`${definition.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(errors.length > 0 ? "warn" : "info", "automation.bootstrap", {
    nodes: nodes.count,
    workflows: workflows.length,
    newVersions: workflows.filter((w) => w.created).length,
    triggers: triggerCount,
    subscriptions: subscriptionCount,
    errors: errors.length,
  });

  return {
    nodes: nodes.count,
    workflows,
    triggers: triggerCount,
    subscriptions: subscriptionCount,
    errors,
  };
}

/** Register definitions in memory without touching the database. For the UI. */
export function loadWorkflowRegistry(): AutomationWorkflowDefinition[] {
  registerAutomationNodes();
  return AUTOMATION_WORKFLOWS;
}

export { registeredWorkflows };
