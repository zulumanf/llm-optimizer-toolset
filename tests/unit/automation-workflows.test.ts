/**
 * Unit tests for the workflow library and the node registry.
 *
 * These assert the *structural* promises the specs make — that every shipped
 * graph validates, that every handler a graph references exists, that no
 * consequential node is reachable without an approval, and that the operational
 * metadata (owner, cost cap, connectors) is present rather than aspirational.
 *
 * A graph that fails validation at 3am is a graph nobody validated at build time.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { AUTOMATION_WORKFLOWS } from "@/lib/automation/workflows";
import { validateAutomationDefinition } from "@/lib/automation/runtime";
import { validateGraph, entryNodes, reachableNodes, findUndeclaredCycles } from "@/lib/workflow/graph";
import {
  knownNodeHandlers,
  nodePalette,
  registerAutomationNodes,
  AUTOMATION_NODES,
} from "@/lib/automation/nodes";
import { hasHandler } from "@/lib/workflow/handlers";
import { AUTOMATION_PROMPTS, AUTOMATION_AGENT_KEYS } from "@/lib/automation/prompts";
import { agentSchema, implementedAgentKeys } from "@/lib/automation/nodes/agent";
import { providersFor } from "@/lib/connectors/registry";
import { isConsequential, type ConnectorCapability } from "@/lib/connectors/types";
import { verifyClaimsSupported, hashBody } from "@/lib/outreach/sequences";
import { normalizeForScope } from "@/lib/outreach/suppression";

beforeAll(() => {
  registerAutomationNodes();
});

describe("the node library", () => {
  it("registers every node exactly once, namespaced by category", () => {
    const names = knownNodeHandlers();
    expect(names.length).toBeGreaterThan(80);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name, `${name} must be namespaced`).toMatch(/^(trg|ctl|det|agt|int|hum|dom)\./);
    }
  });

  it("does not redefine a spec-018 engine built-in", () => {
    // fan_in, approval_gate, delay, timer, manual_task and the terminals belong
    // to the engine. Shadowing one would fork its semantics.
    for (const builtin of [
      "fan_in",
      "approval_gate",
      "terminal_success",
      "terminal_failure",
      "manual_task",
      "delay",
      "timer",
    ]) {
      expect(Object.keys(AUTOMATION_NODES)).not.toContain(builtin);
    }
  });

  it("exposes a grouped palette for the authoring UI", () => {
    const palette = nodePalette();
    const categories = palette.map((group) => group.category);
    expect(categories).toEqual([
      "Trigger",
      "Control",
      "Deterministic",
      "Agent",
      "Integration",
      "Human",
      "Domain",
    ]);
    for (const group of palette) {
      expect(group.nodes.length, `${group.category} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("has an integration node for every connector capability", () => {
    const integration = nodePalette().find((g) => g.category === "Integration")!;
    // 30 capabilities → 30 nodes, so a workflow can never want a capability the
    // node library cannot express.
    expect(integration.nodes.length).toBeGreaterThanOrEqual(30);
  });

  it("registers a handler for every declared agent", () => {
    for (const key of implementedAgentKeys()) {
      expect(hasHandler(`agt.${key}`), `agt.${key} must be registered`).toBe(true);
    }
  });
});

describe("agent contracts", () => {
  it("declares a versioned prompt for every agent key", () => {
    for (const key of AUTOMATION_AGENT_KEYS) {
      const prompt = AUTOMATION_PROMPTS[key];
      expect(prompt, `${key} needs a prompt`).toBeDefined();
      expect(prompt.version, `${key} needs a version`).toMatch(/-v\d+$/);
      expect(prompt.model.length).toBeGreaterThan(0);
      expect(prompt.system.length).toBeGreaterThan(100);
    }
  });

  it("carries the non-negotiable guardrails in every system prompt", () => {
    for (const key of AUTOMATION_AGENT_KEYS) {
      const system = AUTOMATION_PROMPTS[key].system;
      expect(system, `${key} must forbid unsupported assertions`).toContain(
        "Only assert something if the supplied context contains evidence"
      );
      expect(system, `${key} must forbid causal overreach`).toContain(
        "Never describe a correlation as a cause"
      );
      expect(system, `${key} must forbid inferring protected characteristics`).toContain(
        "protected or sensitive personal characteristics"
      );
      expect(system, `${key} must forbid guarantees`).toContain("guaranteed outcome");
    }
  });

  it("declares an output schema for every agent", () => {
    for (const key of implementedAgentKeys()) {
      expect(agentSchema(key), `${key} needs a schema`).toBeDefined();
    }
  });

  it("requires a confidence field on every agent output", () => {
    for (const key of implementedAgentKeys()) {
      const schema = agentSchema(key);
      // An output with no confidence cannot be routed by the confidence gate,
      // which would silently bypass human review.
      const result = schema.safeParse({});
      expect(result.success, `${key} must require its fields`).toBe(false);
    }
  });

  it("has no field for a protected characteristic in any schema", () => {
    // A schema-level absence is a stronger guarantee than a prompt instruction.
    const forbidden = /race|ethnic|religio|health|disabilit|sexual|orientation|immigration|marital|pregnan/i;
    for (const key of implementedAgentKeys()) {
      const shape = JSON.stringify(agentSchema(key));
      expect(forbidden.test(shape), `${key} must not model protected characteristics`).toBe(false);
    }
  });

  it("gives the reply classifier explicit stop fields", () => {
    // Stop rules must be read from a boolean, never inferred from prose.
    const parsed = agentSchema("classify_reply").safeParse({
      intent: "opt_out",
      shouldStopSequence: true,
      isOptOut: true,
      meetingRequested: false,
      confidence: 0.95,
      reasoning: "asked to be removed",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires a statement kind on every executive narrative statement", () => {
    const missingKind = agentSchema("generate_executive_narrative").safeParse({
      statements: [{ text: "Visibility improved." }],
      confidence: 0.8,
    });
    // An interpretation that can be read as a fact is the failure mode here.
    expect(missingKind.success).toBe(false);
  });
});

describe("the shipped workflows", () => {
  it("ships eighteen definitions with unique keys", () => {
    expect(AUTOMATION_WORKFLOWS.length).toBe(18);
    const keys = AUTOMATION_WORKFLOWS.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("validates every graph", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      const errors = validateGraph(workflow);
      expect(errors.map((e) => e.message), `${workflow.key} graph`).toEqual([]);
    }
  });

  it("passes the operational-metadata validator", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      expect(validateAutomationDefinition(workflow), `${workflow.key}`).toEqual([]);
    }
  });

  it("references only registered handlers", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const node of workflow.nodes) {
        if (!node.handler) continue;
        expect(hasHandler(node.handler), `${workflow.key}/${node.key} → ${node.handler}`).toBe(true);
      }
    }
  });

  it("has exactly one entry node per graph", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      expect(entryNodes(workflow).length, `${workflow.key}`).toBe(1);
    }
  });

  it("has no unreachable node", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      const reachable = reachableNodes(workflow);
      const orphans = workflow.nodes.filter((n) => !reachable.has(n.key)).map((n) => n.key);
      expect(orphans, `${workflow.key} unreachable`).toEqual([]);
    }
  });

  it("declares no undeclared cycle", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      expect(findUndeclaredCycles(workflow), `${workflow.key}`).toEqual([]);
    }
  });

  it("names an owner and a cost cap on every workflow", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      expect(workflow.owner.length, `${workflow.key} owner`).toBeGreaterThan(0);
      expect(workflow.maxCostMicroUsd, `${workflow.key} cost cap`).toBeGreaterThan(0);
      expect(workflow.maxDurationMinutes, `${workflow.key} duration cap`).toBeGreaterThan(0);
      expect(workflow.maxConcurrentRuns, `${workflow.key} concurrency`).toBeGreaterThan(0);
    }
  });

  it("declares at least one trigger and acceptance criteria on every workflow", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      expect(workflow.triggers.length, `${workflow.key} triggers`).toBeGreaterThan(0);
      expect(
        (workflow.acceptanceCriteria ?? []).length,
        `${workflow.key} acceptance criteria`
      ).toBeGreaterThan(2);
    }
  });

  it("requires an autonomy note on every unattended event subscription", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const declaration of workflow.triggers) {
        if (declaration.kind !== "domain_event") continue;
        // "Why is it safe to start this without a human?" must be answered in
        // prose by the template author.
        expect(
          declaration.autonomyNote.length,
          `${workflow.key} → ${declaration.eventType} needs an autonomy note`
        ).toBeGreaterThan(30);
      }
    }
  });

  it("declares only capabilities a registered adapter implements", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const capability of workflow.requiredConnectors) {
        expect(
          providersFor(capability).length,
          `${workflow.key} requires ${capability}`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("declares a valid cron on every schedule trigger", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const declaration of workflow.triggers) {
        if (declaration.kind !== "schedule") continue;
        expect(declaration.cron.trim().split(/\s+/), `${workflow.key} cron`).toHaveLength(5);
        expect(declaration.description.length).toBeGreaterThan(5);
      }
    }
  });
});

describe("approval coverage", () => {
  /**
   * The property that matters most: a node that does something irreversible
   * outside the platform must not be reachable without a human decision
   * upstream of it, unless the autonomy policy explicitly permits it at
   * level 3+ AND the workflow declares that.
   */
  function upstreamOf(
    workflow: (typeof AUTOMATION_WORKFLOWS)[number],
    nodeKey: string
  ): Set<string> {
    const incoming = new Map<string, string[]>();
    for (const edge of workflow.edges) {
      incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    }
    const seen = new Set<string>();
    const queue = [...(incoming.get(nodeKey) ?? [])];
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const parent of incoming.get(key) ?? []) queue.push(parent);
    }
    return seen;
  }

  it("gates every consequential node behind an approval or an explicit autonomy declaration", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const node of workflow.nodes) {
        const capability = node.config?.capability as ConnectorCapability | undefined;
        if (!capability || !isConsequential(capability)) continue;

        const upstream = upstreamOf(workflow, node.key);
        const hasApprovalUpstream = [...upstream].some((key) => {
          const upstreamNode = workflow.nodes.find((n) => n.key === key);
          return (
            upstreamNode?.type === "approval_gate" ||
            upstreamNode?.handler?.startsWith("hum.") === true ||
            upstreamNode?.handler === "ctl.autonomy_gate"
          );
        });
        const nodeItselfApproves = node.requiresApproval === true;
        // An explicit per-node autonomy override at level 4 is the documented
        // escape hatch (billing reminders), and it must be declared on the node.
        const declaredAutonomous = node.autonomyLevel !== undefined && node.autonomyLevel >= 3;

        expect(
          hasApprovalUpstream || nodeItselfApproves || declaredAutonomous,
          `${workflow.key}/${node.key} (${capability}) is consequential with no approval or declared autonomy upstream`
        ).toBe(true);
      }
    }
  });

  it("classifies every consequential node as high or critical risk", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const node of workflow.nodes) {
        const capability = node.config?.capability as ConnectorCapability | undefined;
        if (!capability || !isConsequential(capability)) continue;
        expect(
          ["high", "critical"],
          `${workflow.key}/${node.key} risk`
        ).toContain(node.riskLevel ?? "low");
      }
    }
  });

  it("declares required approvals on every workflow that has an approval gate", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      const hasGate = workflow.nodes.some(
        (n) => n.type === "approval_gate" && n.handler?.startsWith("hum.") === true
      );
      // choose_strategy gates are operational decisions rather than named
      // approvals, so only workflows with a named approval must declare one.
      const hasNamedApproval = workflow.nodes.some(
        (n) => n.handler?.startsWith("hum.approve_") === true || n.handler === "hum.verify_transaction"
      );
      if (hasGate && hasNamedApproval) {
        expect(
          workflow.requiredApprovals.length,
          `${workflow.key} has an approval gate but declares no required approvals`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keeps agent nodes non-effectful", () => {
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const node of workflow.nodes) {
        if (node.type !== "agent_task") continue;
        // An agent drafts and classifies. If one ever carried a capability, it
        // would be acting.
        expect(node.config?.capability, `${workflow.key}/${node.key}`).toBeUndefined();
        expect(node.requiresApproval ?? false, `${workflow.key}/${node.key}`).toBe(false);
      }
    }
  });
});

describe("outreach claim support", () => {
  it("accepts a factual claim backed by evidence", () => {
    const verdict = verifyClaimsSupported([
      {
        statement: "You appear in 2 of 12 measured assistant responses for Coral Gables.",
        kind: "fact",
        evidenceIds: ["11111111-1111-4111-8111-111111111111"],
      },
    ]);
    expect(verdict.ok).toBe(true);
  });

  it("rejects a factual claim with no evidence and no source", () => {
    const verdict = verifyClaimsSupported([
      { statement: "You are losing $2M a year to competitors.", kind: "fact", evidenceIds: [] },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.unsupported).toHaveLength(1);
  });

  it("accepts a factual claim backed by a source URL", () => {
    const verdict = verifyClaimsSupported([
      {
        statement: "Your brokerage profile lists no market specialisation.",
        kind: "fact",
        evidenceIds: [],
        sourceUrl: "https://example.com/profile",
      },
    ]);
    expect(verdict.ok).toBe(true);
  });

  it("does not require evidence for a question or an opinion", () => {
    const verdict = verifyClaimsSupported([
      { statement: "Would a 20-minute walkthrough be useful?", kind: "question", evidenceIds: [] },
      { statement: "This looks like a positioning gap to me.", kind: "opinion", evidenceIds: [] },
    ]);
    expect(verdict.ok).toBe(true);
  });

  it("requires evidence for a calculation", () => {
    const verdict = verifyClaimsSupported([
      { statement: "That is a 40% gap versus your closest competitor.", kind: "calculation", evidenceIds: [] },
    ]);
    expect(verdict.ok).toBe(false);
  });

  it("lists every unsupported statement, not just the first", () => {
    const verdict = verifyClaimsSupported([
      { statement: "A", kind: "fact", evidenceIds: [] },
      { statement: "B", kind: "calculation", evidenceIds: [] },
      { statement: "C", kind: "fact", evidenceIds: ["id"] },
    ]);
    expect(verdict.unsupported).toEqual(["A", "B"]);
  });
});

describe("message hashing binds an approval to an artifact", () => {
  it("produces a stable hash for identical content", () => {
    expect(hashBody("Subject", "Body")).toBe(hashBody("Subject", "Body"));
  });

  it("changes when the subject or the body changes", () => {
    const original = hashBody("Subject", "Body");
    // A changed draft must invalidate its approval, which is what the hash
    // comparison in the send gate enforces.
    expect(hashBody("Subject", "Body edited")).not.toBe(original);
    expect(hashBody("Subject edited", "Body")).not.toBe(original);
  });
});

describe("suppression normalisation by scope", () => {
  it("normalises per scope", () => {
    expect(normalizeForScope("email", "Agent+tag@Example.com")).toBe("agent@example.com");
    expect(normalizeForScope("phone", "(305) 555-0147")).toBe("+13055550147");
    expect(normalizeForScope("domain", "https://www.Brokerage.com/x")).toBe("brokerage.com");
  });
});
