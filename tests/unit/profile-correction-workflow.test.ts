/**
 * Spec 145B — the profile correction workflow uses canonical extraction and
 * hands detect_contradictions observed and approved facts as separate contexts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { NodeContext } from "@/lib/workflow/types";
import { profileCorrectionWorkflow } from "@/lib/automation/workflows/authority";
import { clientOnboardingWorkflow } from "@/lib/automation/workflows/delivery";
import { validateAutomationDefinition } from "@/lib/automation/runtime";
import { resolveAgentContext } from "@/lib/automation/nodes/agent";
import { knownNodeHandlers, registerAutomationNodes } from "@/lib/automation/nodes";
import { hasHandler } from "@/lib/workflow/handlers";

beforeAll(() => {
  registerAutomationNodes();
});

function node(key: string) {
  const found = profileCorrectionWorkflow.nodes.find((n) => n.key === key);
  if (!found) throw new Error(`node ${key} missing`);
  return found;
}

describe("profile correction workflow (spec 145B)", () => {
  it("no longer invokes the weak extract_claims agent", () => {
    const handlers = profileCorrectionWorkflow.nodes.map((n) => n.handler);
    expect(handlers).not.toContain("agt.extract_claims");
  });

  it("extracts through the registered canonical domain node", () => {
    const extract = node("canonical_extract");
    expect(extract.handler).toBe("dom.extract_canonical_claims");
    expect(extract.config?.contextPath).toBe("fetch_profile");
    expect(knownNodeHandlers()).toContain("dom.extract_canonical_claims");
    expect(knownNodeHandlers()).not.toContain("claim_extraction");
  });

  it("gives detect_contradictions observed claims and approved facts separately", () => {
    const compare = node("compare");
    expect(compare.handler).toBe("agt.detect_contradictions");
    expect(compare.config?.contextPath).toBeUndefined();
    expect(compare.config?.contextPaths).toEqual({
      observedClaims: "canonical_extract.claims",
      approvedFacts: "approved_facts",
    });
  });

  it("resolves the two compare contexts independently", async () => {
    const observed = [{ claimId: "c1", normalizedWording: "Ana Perez is affiliated with Compass." }];
    const approved = { claims: [{ id: "a1", text: "Ana Perez is affiliated with Douglas Elliman." }] };
    const ctx: NodeContext = {
      runId: "run-test",
      projectId: null,
      nodeKey: "compare",
      fanKey: "",
      attempt: 1,
      inputs: {
        approved_facts: approved,
        canonical_extract: { sourceArtifactId: "sa1", claims: observed },
      },
      workflowInput: {},
      config: node("compare").config ?? {},
      node: node("compare"),
      remainingCostMicroUsd: null,
    };
    expect(await resolveAgentContext(ctx)).toEqual({
      observedClaims: observed,
      approvedFacts: approved,
    });
  });

  it("orders fetch → canonical extraction → approved facts → compare", () => {
    const edges = profileCorrectionWorkflow.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toContain("fetch_profile->canonical_extract");
    expect(edges).toContain("canonical_extract->approved_facts");
    expect(edges).toContain("approved_facts->compare");
  });

  it("validates with no missing edges or path errors", () => {
    expect(validateAutomationDefinition(profileCorrectionWorkflow)).toEqual([]);
  });

  it("leaves the generic extract_claims agent available and onboarding unchanged", () => {
    expect(hasHandler("agt.extract_claims")).toBe(true);
    const onboardingExtract = clientOnboardingWorkflow.nodes.find(
      (n) => n.key === "extract_facts"
    );
    expect(onboardingExtract?.handler).toBe("agt.extract_claims");
  });
});
