import { describe, expect, it } from "vitest";
import { agentSchema } from "@/lib/automation/nodes/agent";
import {
  calculateLeadQualification,
  LEAD_QUALIFICATION_SCORE_VERSION,
  LEAD_QUALIFICATION_WEIGHTS,
} from "@/lib/automation/nodes/deterministic";
import { inboundLeadWorkflow } from "@/lib/automation/workflows/revenue";

describe("lead qualification architecture", () => {
  it("keeps factual fields and numeric scoring out of the LLM contract", () => {
    const parsed = agentSchema("classify_lead").parse({
      estimatedFit: "strong",
      useCase: "AI visibility audit",
      urgency: "immediate",
      budgetSignal: "explicit",
      authorityMaturity: "established",
      aiVisibilityNeed: "high",
      confidence: 0.95,
      recommendedNextStep: "Schedule discovery",
      reasoning: "Explicit need, timing and budget.",

      // These are deliberately supplied to prove Zod strips them.
      qualificationScore: 99,
      market: "Jersey City",
      teamSize: "11-50",
      accountType: "team",
    }) as Record<string, unknown>;

    expect(parsed.qualificationScore).toBeUndefined();
    expect(parsed.market).toBeUndefined();
    expect(parsed.teamSize).toBeUndefined();
    expect(parsed.accountType).toBeUndefined();
  });

  it("scores a fully-qualified lead deterministically to 100", () => {
    const result = calculateLeadQualification({
      leadId: "lead-1",
      signals: {
        estimatedFit: "strong",
        aiVisibilityNeed: "high",
        budgetSignal: "explicit",
        urgency: "immediate",
        authorityMaturity: "established",
        confidence: 0.95,
      },
    });

    expect(result.score).toBe(100);
    expect(result.version).toBe(
      LEAD_QUALIFICATION_SCORE_VERSION
    );
    expect(result.confidence).toBe(0.95);
  });

  it("scores completely unknown evidence to zero rather than guessing", () => {
    const result = calculateLeadQualification({
      leadId: "lead-2",
      signals: {
        estimatedFit: "unknown",
        aiVisibilityNeed: "unknown",
        budgetSignal: "unknown",
        urgency: "unknown",
        authorityMaturity: "unknown",
        confidence: 0.2,
      },
    });

    expect(result.score).toBe(0);
  });

  it("makes the score explainable through weighted components", () => {
    const result = calculateLeadQualification({
      leadId: "lead-3",
      signals: {
        estimatedFit: "moderate",
        aiVisibilityNeed: "high",
        budgetSignal: "none",
        urgency: "unknown",
        authorityMaturity: "unknown",
        confidence: 0.8,
      },
    });

    expect(result.score).toBe(43);

    expect(
      Object.values(LEAD_QUALIFICATION_WEIGHTS).reduce(
        (sum, value) => sum + value,
        0
      )
    ).toBe(100);

    expect(
      result.components.estimatedFit.evidencePath
    ).toBe("classify.estimatedFit");

    expect(
      result.components.aiVisibilityNeed.evidencePath
    ).toBe("classify.aiVisibilityNeed");
  });

  it("gates production on the deterministic score rather than an LLM number", () => {
    const oldPriorityNode =
      inboundLeadWorkflow.nodes.find(
        (node) => node.key === "deterministic_score"
      );

    expect(oldPriorityNode).toBeUndefined();

    const classify =
      inboundLeadWorkflow.nodes.find(
        (node) => node.key === "classify"
      );

    expect(classify?.config?.contextPath).toBe(
      "normalize.normalized"
    );

    const score =
      inboundLeadWorkflow.nodes.find(
        (node) =>
          node.key === "qualification_score"
      );

    expect(score?.handler).toBe(
      "det.calculate_lead_qualification"
    );

    const qualified =
      inboundLeadWorkflow.nodes.find(
        (node) => node.key === "qualified"
      );

    expect(qualified?.config?.path).toBe(
      "qualification_score.score"
    );

    const publish =
      inboundLeadWorkflow.nodes.find(
        (node) =>
          node.key === "publish_qualified"
      );

    expect(publish?.config?.payloadPath).toBe(
      "qualification_score"
    );
  });
});
