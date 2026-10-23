import { describe, expect, it } from "vitest";
import type { NodeContext } from "@/lib/workflow/types";
import { resolveAgentContext } from "@/lib/automation/nodes/agent";
import { validateNodePaths } from "@/lib/automation/runtime";
import { clientSupportWorkflow } from "@/lib/automation/workflows/operations";

function ctx(
  config: Record<string, unknown>
): NodeContext {
  return {
    runId: "run-test",
    projectId: null,
    nodeKey: "triage",
    fanKey: "",
    attempt: 1,
    inputs: {
      knowledge: {
        claims: ["Report publishes Friday"],
      },
    },
    workflowInput: {
      payload: {
        senderEmail: "client@example.com",
        subject: "Report",
        body: "When is the report ready?",
      },
    },
    config,
    node: {} as NodeContext["node"],
    remainingCostMicroUsd: null,
  };
}

describe("multi-source agent context", () => {
  it("resolves named context sources independently", async () => {
    const result = await resolveAgentContext(
      ctx({
        contextPaths: {
          message: "payload",
          knowledge: "knowledge",
        },
      })
    );

    expect(result).toEqual({
      message: {
        senderEmail: "client@example.com",
        subject: "Report",
        body: "When is the report ready?",
      },
      knowledge: {
        claims: ["Report publishes Friday"],
      },
    });
  });

  it("preserves the existing single-context behavior", async () => {
    const result = await resolveAgentContext(
      ctx({
        contextPath: "payload",
      })
    );

    expect(result).toEqual({
      senderEmail: "client@example.com",
      subject: "Report",
      body: "When is the report ready?",
    });
  });

  it("refuses ambiguous single + multi context configuration", async () => {
    await expect(
      resolveAgentContext(
        ctx({
          contextPath: "payload",
          contextPaths: {
            knowledge: "knowledge",
          },
        })
      )
    ).rejects.toThrow(
      "contextPath or contextPaths"
    );
  });

  it("gives support triage both its message and approved knowledge", () => {
    const triage = clientSupportWorkflow.nodes.find(
      (node) => node.key === "triage"
    );

    expect(triage?.config?.contextPath).toBeUndefined();

    expect(triage?.config?.contextPaths).toEqual({
      message: "payload",
      knowledge: "knowledge",
    });
  });

  it("keeps the support workflow path-safe", () => {
    expect(
      validateNodePaths(clientSupportWorkflow)
    ).toEqual([]);
  });
});
