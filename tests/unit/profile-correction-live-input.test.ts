/**
 * Spec 145C — a real profile.error_detected run enters the profile correction
 * workflow and fetches exactly `payload.profileUrl`, never an invented URL.
 *
 * Spec 147 slice 1 replaced the WordPress `cms.fetch_public_page` capability on
 * `fetch_profile` with the connector-free `dom.fetch_public_profile` (safeFetch).
 * The 145C invariants are retested against it here; the generic integration
 * `inputFields` mapping 145C added is still tested on an integration node.
 *
 * The run input is built the way `lib/events/bus.ts` builds it, and the entry
 * and fetch handlers are the workflow's own, so this exercises the live wiring
 * rather than a re-description of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeContext, NodeDefinition } from "@/lib/workflow/types";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  runModeFor: vi.fn(),
  executeCapability: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock("@/db/client", () => ({ sql: mocks.sql }));
vi.mock("@/lib/automation/testmode", () => ({
  runModeFor: mocks.runModeFor,
  recordWouldHaveHappened: vi.fn(),
}));
vi.mock("@/lib/connectors/execute", () => ({ executeCapability: mocks.executeCapability }));
vi.mock("@/lib/security/safe-fetch", () => ({ safeFetch: mocks.safeFetch }));

import { eventDefinition } from "@/lib/events/catalog";
import { integrationNodes } from "@/lib/automation/nodes/integration";
import { profileCorrectionNodes } from "@/lib/automation/nodes/profile-correction";
import { triggerNodes } from "@/lib/automation/nodes/human";
import {
  competitorIntelligenceWorkflow,
  profileCorrectionWorkflow,
} from "@/lib/automation/workflows/authority";
import { validateAutomationDefinition, validateNodePaths } from "@/lib/automation/runtime";
import type { AutomationWorkflowDefinition } from "@/lib/automation/types";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_URL = "https://www.zillow.com/profile/ana-perez";

function node(workflow: AutomationWorkflowDefinition, key: string): NodeDefinition {
  const found = workflow.nodes.find((n) => n.key === key);
  if (!found) throw new Error(`node ${key} missing`);
  return found;
}

/** The run input exactly as `lib/events/bus.ts` starts a domain-event run. */
function eventRunInput(rawPayload: Record<string, unknown>): Record<string, unknown> {
  const payload = eventDefinition("profile.error_detected")!.schema.parse(rawPayload);
  return {
    event: {
      id: "evt-1",
      type: "profile.error_detected",
      version: 1,
      correlationId: "corr-1",
      occurredAt: "2026-09-23T10:00:00.000Z",
    },
    payload,
  };
}

function ctxFor(
  nodeDef: NodeDefinition,
  workflowInput: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
  config: Record<string, unknown> = nodeDef.config ?? {}
): NodeContext {
  return {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    nodeKey: nodeDef.key,
    fanKey: "",
    attempt: 1,
    inputs,
    workflowInput,
    config,
    node: nodeDef,
    remainingCostMicroUsd: null,
  };
}

async function runEntry(workflowInput: Record<string, unknown>) {
  const entry = node(profileCorrectionWorkflow, "entry");
  return triggerNodes[entry.handler!]!(ctxFor(entry, workflowInput));
}

async function runFetch(
  workflowInput: Record<string, unknown>,
  inputs: Record<string, unknown>,
  config?: Record<string, unknown>
) {
  const fetchNode = node(profileCorrectionWorkflow, "fetch_profile");
  return profileCorrectionNodes[fetchNode.handler!]!(ctxFor(fetchNode, workflowInput, inputs, config));
}

/** A generic integration fetch node, for the 145C `inputFields` mapping. */
const INTEGRATION_FETCH: NodeDefinition = {
  key: "fetch_page",
  type: "integration_task",
  name: "Fetch a page",
  handler: "int.cms_fetch_public_page",
  config: { capability: "cms.fetch_public_page", inputFields: { url: "payload.profileUrl" } },
};

async function runIntegrationFetch(
  workflowInput: Record<string, unknown>,
  config: Record<string, unknown>
) {
  return integrationNodes[INTEGRATION_FETCH.handler!]!(
    ctxFor(INTEGRATION_FETCH, workflowInput, {}, config)
  );
}

function capabilityInput(): unknown {
  expect(mocks.executeCapability).toHaveBeenCalledTimes(1);
  return mocks.executeCapability.mock.calls[0]![0].input;
}

beforeEach(() => {
  vi.clearAllMocks();
  // No other node in the run has succeeded: path resolution's last fallback is empty.
  mocks.sql.mockResolvedValue([]);
  mocks.runModeFor.mockResolvedValue({
    mode: "live",
    fixtures: { connectorResponses: {}, agentResponses: {} },
    allowCrmWrites: false,
  });
  mocks.executeCapability.mockResolvedValue({
    ok: true,
    provider: "wordpress",
    data: { url: PROFILE_URL, status: 200, reachable: true, excerpt: "<html>" },
    rowsRead: 1,
    rowsWritten: 0,
  });
  mocks.safeFetch.mockResolvedValue({
    status: 200,
    statusText: "OK",
    ok: true,
    headers: new Headers(),
    bytes: Buffer.from("<html>"),
    finalUrl: PROFILE_URL,
  });
});

describe("profile correction live input (spec 145C)", () => {
  it("enters through the domain-event entry point", async () => {
    expect(node(profileCorrectionWorkflow, "entry").handler).toBe("trg.domain_event");
    const result = await runEntry(
      eventRunInput({ profileType: "zillow", profileUrl: PROFILE_URL, severity: "high" })
    );
    expect(result.outcome).toBe("succeeded");
    expect(result.output).toMatchObject({
      kind: "domain_event",
      eventId: "evt-1",
      eventType: "profile.error_detected",
      correlationId: "corr-1",
      payload: { profileUrl: PROFILE_URL },
    });
  });

  it("fetches exactly payload.profileUrl from a real event payload, with no connector", async () => {
    const input = eventRunInput({
      profileType: "zillow",
      profileUrl: PROFILE_URL,
      findingId: "finding-9",
      severity: "high",
    });
    const entry = await runEntry(input);
    const result = await runFetch(input, { entry: entry.output });

    expect(result.outcome).toBe("succeeded");
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
    // Only the URL is used; nothing else from the payload is forwarded.
    expect(mocks.safeFetch.mock.calls[0]![0]).toBe(PROFILE_URL);
    expect(mocks.executeCapability).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ ok: true, data: { url: PROFILE_URL, reachable: true } });
  });

  it("omits the fetch rather than inventing a URL when profileUrl is missing", async () => {
    const input = { event: { id: "evt-2" }, payload: { profileType: "zillow" } };
    const result = await runFetch(input, {});
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.executeCapability).not.toHaveBeenCalled();
    expect(result.outcome).toBe("succeeded");
    // canonical_extract safe-stops on ok: false (spec 145B), as it did before.
    expect(result.output).toEqual({ ok: false, reason: "no_url" });
  });

  it("keeps params as defaults under inputFields (generic integration nodes)", async () => {
    await runIntegrationFetch(eventRunInput({ profileType: "zillow", profileUrl: PROFILE_URL }), {
      capability: "cms.fetch_public_page",
      params: { url: "https://fallback.example.com", locale: "en" },
      inputFields: { url: "payload.profileUrl" },
    });
    expect(capabilityInput()).toEqual({ url: PROFILE_URL, locale: "en" });
  });

  it("hands an integration node exactly { url } through inputFields", async () => {
    await runIntegrationFetch(
      eventRunInput({ profileType: "zillow", profileUrl: PROFILE_URL, findingId: "f-1" }),
      INTEGRATION_FETCH.config ?? {}
    );
    expect(capabilityInput()).toEqual({ url: PROFILE_URL });
  });

  it.each([
    ["inputPath and inputFields together", { inputPath: "payload", inputFields: { url: "payload.profileUrl" } }],
    ["an array", { inputFields: ["payload.profileUrl"] }],
    ["a non-string path", { inputFields: { url: 42 } }],
    ["an empty path", { inputFields: { url: "" } }],
  ])("fails terminally on %s without calling the connector", async (_label, config) => {
    const result = await runIntegrationFetch(
      eventRunInput({ profileType: "zillow", profileUrl: PROFILE_URL }),
      { capability: "cms.fetch_public_page", ...config }
    );
    expect(result.outcome).toBe("failed_terminal");
    expect(mocks.executeCapability).not.toHaveBeenCalled();
  });

  it("leaves inputPath integration nodes unchanged", async () => {
    const fetchSource = node(competitorIntelligenceWorkflow, "fetch_source");
    expect(fetchSource.config?.inputPath).toBe("competitor_fan");
    expect(fetchSource.config?.inputFields).toBeUndefined();
    const upstream = { id: "co-1", url: "https://competitor.example.com", name: "Rival" };
    await integrationNodes[fetchSource.handler!]!(
      ctxFor(fetchSource, {}, { competitor_fan: upstream })
    );
    expect(capabilityInput()).toEqual(upstream);
  });

  it("still overlays inputPath data on params", async () => {
    const fetchSource = node(competitorIntelligenceWorkflow, "fetch_source");
    await integrationNodes[fetchSource.handler!]!(
      ctxFor(
        fetchSource,
        {},
        { competitor_fan: { url: "https://upstream.example.com" } },
        { ...fetchSource.config, params: { url: "https://default.example.com", locale: "en" } }
      )
    );
    expect(capabilityInput()).toEqual({ url: "https://upstream.example.com", locale: "en" });
  });

  it("configures fetch_profile to read only payload.profileUrl (spec 147: no connector)", () => {
    const fetchProfile = node(profileCorrectionWorkflow, "fetch_profile");
    expect(fetchProfile.handler).toBe("dom.fetch_public_profile");
    const config = fetchProfile.config ?? {};
    expect(config.inputPath).toBeUndefined();
    expect(config.inputFields).toBeUndefined();
    expect(config.urlPath).toBe("payload.profileUrl");
  });

  it("validates the workflow", () => {
    expect(validateAutomationDefinition(profileCorrectionWorkflow)).toEqual([]);
  });

  describe("inputFields path validation", () => {
    function withFetchConfig(config: Record<string, unknown>): AutomationWorkflowDefinition {
      return {
        ...profileCorrectionWorkflow,
        nodes: profileCorrectionWorkflow.nodes.map((n) =>
          n.key === "fetch_profile" ? { ...n, config: { ...n.config, ...config } } : n
        ),
      };
    }

    it("reports a root that is not an ancestor", () => {
      const errors = validateNodePaths(
        withFetchConfig({ inputFields: { url: "compare.contradictions" } })
      );
      expect(errors.some((e) => e.includes("inputFields.url") && e.includes("not an ancestor"))).toBe(true);
    });

    it("reports a malformed map and an empty path", () => {
      expect(
        validateNodePaths(withFetchConfig({ inputFields: ["payload.profileUrl"] })).some((e) =>
          e.includes("inputFields must be an object")
        )
      ).toBe(true);
      expect(
        validateNodePaths(withFetchConfig({ inputFields: { url: "" } })).some((e) =>
          e.includes("inputFields.url must be a non-empty dotted path")
        )
      ).toBe(true);
    });

    it("reports inputPath combined with inputFields", () => {
      expect(
        validateNodePaths(
          withFetchConfig({ inputPath: "payload", inputFields: { url: "payload.profileUrl" } })
        ).some((e) => e.includes("inputPath or inputFields, not both"))
      ).toBe(true);
    });

    it("accepts a run-input root", () => {
      expect(validateNodePaths(profileCorrectionWorkflow)).toEqual([]);
    });
  });

  describe("scheduled profile_scan", () => {
    it("keeps the schedule trigger declared as before", () => {
      const schedule = profileCorrectionWorkflow.triggers.find((t) => t.kind === "schedule");
      expect(schedule).toMatchObject({
        kind: "schedule",
        key: "profile_scan",
        cron: "0 5 * * 2",
        timezone: "America/New_York",
        missedRunPolicy: "run_once",
      });
      const event = profileCorrectionWorkflow.triggers.find((t) => t.kind === "domain_event");
      expect(event).toMatchObject({
        eventType: "profile.error_detected",
        idempotencyTemplate: "profile:{{payload.profileUrl}}",
      });
    });

    it("stops a scheduled run at entry with the mismatch, without calling a connector", async () => {
      const result = await runEntry({ trigger: { kind: "schedule", key: "profile_scan" } });
      expect(result.outcome).toBe("failed_terminal");
      expect(result.error).toContain('declares a domain_event entry point but the run was started by "schedule"');
      expect(mocks.executeCapability).not.toHaveBeenCalled();
    });
  });
});
