/**
 * Spec 162 (G7) — the workflow-engine send node never sends prospect email.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeContext } from "@/lib/workflow/types";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  runModeFor: vi.fn(),
  recordWouldHaveHappened: vi.fn(),
  executeCapability: vi.fn(),
  isProspectRecipient: vi.fn(),
  assertSendAllowed: vi.fn(),
  resolveAutonomy: vi.fn(),
}));

vi.mock("@/db/client", () => ({ sql: mocks.sql }));
vi.mock("@/lib/automation/testmode", () => ({
  runModeFor: mocks.runModeFor,
  recordWouldHaveHappened: mocks.recordWouldHaveHappened,
}));
vi.mock("@/lib/connectors/execute", () => ({ executeCapability: mocks.executeCapability }));
vi.mock("@/db/prospect-recipients", () => ({ isProspectRecipient: mocks.isProspectRecipient }));
vi.mock("@/lib/outreach/suppression", () => ({ assertSendAllowed: mocks.assertSendAllowed }));
vi.mock("@/lib/workflow/autonomy", () => ({ resolveAutonomy: mocks.resolveAutonomy }));

import { integrationNodes } from "@/lib/automation/nodes/integration";

const send = integrationNodes["int.email_send_approved_message"]!;

function ctx(actionType: string | undefined, to = "Lead@Example.com"): NodeContext {
  return {
    runId: "33333333-3333-4333-8333-333333333333",
    projectId: "11111111-1111-4111-8111-111111111111",
    nodeKey: "send",
    fanKey: "",
    attempt: 1,
    inputs: {},
    workflowInput: {},
    config: {
      ...(actionType === undefined ? {} : { actionType }),
      params: { to, subject: "Hello there", body: "Body", approvalId: "a-1" },
    },
    node: { autonomyLevel: 4 } as NodeContext["node"],
    remainingCostMicroUsd: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runModeFor.mockResolvedValue({
    mode: "live",
    fixtures: { connectorResponses: {}, agentResponses: {} },
    allowCrmWrites: false,
  });
  mocks.isProspectRecipient.mockResolvedValue(false);
  mocks.resolveAutonomy.mockResolvedValue({ level: 4 });
  mocks.assertSendAllowed.mockResolvedValue({ allowed: true, failedCheck: null, reason: "", checks: [] });
  mocks.executeCapability.mockResolvedValue({ ok: true, data: { messageId: "m-1" }, provider: "gmail" });
});

describe("spec 162: workflow send node and prospect recipients", () => {
  it("refuses a prospect_first_outreach action without reaching the gate or the connector", async () => {
    const result = await send(ctx("prospect_first_outreach"));
    expect(result.outcome).toBe("safe_stop");
    expect(result.output).toMatchObject({ sent: false, failedCheck: "prospect_send_path" });
    expect(mocks.executeCapability).not.toHaveBeenCalled();
    expect(mocks.assertSendAllowed).not.toHaveBeenCalled();
    expect(mocks.recordWouldHaveHappened).toHaveBeenCalledTimes(1);
  });

  it("refuses any action type when the recipient is a prospect, at autonomy level 4", async () => {
    mocks.isProspectRecipient.mockResolvedValue(true);
    const result = await send(ctx("meeting_followup_send"));
    expect(result.outcome).toBe("safe_stop");
    expect(result.output).toMatchObject({ failedCheck: "prospect_send_path" });
    expect(mocks.isProspectRecipient).toHaveBeenCalledWith("Lead@Example.com");
    expect(mocks.executeCapability).not.toHaveBeenCalled();
    expect(mocks.recordWouldHaveHappened).toHaveBeenCalledTimes(1);
  });

  it("sends a non-prospect message once the send gate allows it", async () => {
    const result = await send(ctx("meeting_followup_send"));
    expect(result.outcome).toBe("succeeded");
    expect(mocks.assertSendAllowed).toHaveBeenCalledTimes(1);
    expect(mocks.executeCapability).toHaveBeenCalledTimes(1);
  });

  it("stops when the send gate refuses (e.g. no approval)", async () => {
    mocks.assertSendAllowed.mockResolvedValue({
      allowed: false,
      failedCheck: "approval",
      reason: "requires a recorded approval",
      checks: [],
    });
    const result = await send(ctx("meeting_followup_send"));
    expect(result.outcome).toBe("safe_stop");
    expect(mocks.executeCapability).not.toHaveBeenCalled();
  });
});
