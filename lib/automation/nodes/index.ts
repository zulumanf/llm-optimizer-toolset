/**
 * Node library registration.
 *
 * Importing this module registers every automation node into the spec-018
 * handler registry. Nothing here re-implements a built-in: `fan_in`,
 * `approval_gate`, `delay`, `timer`, `manual_task` and the terminals belong to
 * the engine and stay there.
 */
import { registerHandlers } from "@/lib/workflow/handlers";
import { controlNodes } from "@/lib/automation/nodes/control";
import { deterministicNodes } from "@/lib/automation/nodes/deterministic";
import { integrationNodes } from "@/lib/automation/nodes/integration";
import { agentNodes } from "@/lib/automation/nodes/agent";
import { humanNodes, triggerNodes } from "@/lib/automation/nodes/human";
import { domainNodes } from "@/lib/automation/nodes/domain";

/** Every automation node, by handler name. */
export const AUTOMATION_NODES = {
  ...triggerNodes,
  ...controlNodes,
  ...deterministicNodes,
  ...agentNodes,
  ...integrationNodes,
  ...humanNodes,
  ...domainNodes,
};

let registered = false;

export function registerAutomationNodes(): { count: number } {
  if (!registered) {
    registerHandlers(AUTOMATION_NODES);
    registered = true;
  }
  return { count: Object.keys(AUTOMATION_NODES).length };
}

/** Test seam: `resetHandlers()` clears the registry, so allow re-registration. */
export function forceRegisterAutomationNodes(): { count: number } {
  registerHandlers(AUTOMATION_NODES);
  registered = true;
  return { count: Object.keys(AUTOMATION_NODES).length };
}

/** The node palette the authoring UI renders. Grouped by category. */
export function nodePalette(): { category: string; nodes: string[] }[] {
  return [
    { category: "Trigger", nodes: Object.keys(triggerNodes) },
    { category: "Control", nodes: Object.keys(controlNodes) },
    { category: "Deterministic", nodes: Object.keys(deterministicNodes) },
    { category: "Agent", nodes: Object.keys(agentNodes) },
    { category: "Integration", nodes: Object.keys(integrationNodes) },
    { category: "Human", nodes: Object.keys(humanNodes) },
    { category: "Domain", nodes: Object.keys(domainNodes) },
  ];
}

export function knownNodeHandlers(): string[] {
  return Object.keys(AUTOMATION_NODES).sort();
}
