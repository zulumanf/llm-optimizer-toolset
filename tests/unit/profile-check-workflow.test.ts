/**
 * Spec 147 slice 1 — the profile-correction graph after the public-fetch and
 * queue changes: the frozen front half is byte-for-byte what Specs 145B–146
 * shipped, the fetch needs no connector, a released check starts the
 * workflow, and no paid model or send path is reachable.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { profileCorrectionWorkflow } from "@/lib/automation/workflows/authority";
import { validateAutomationDefinition, validateNodePaths } from "@/lib/automation/runtime";
import { registerAutomationNodes } from "@/lib/automation/nodes";
import { hasHandler } from "@/lib/workflow/handlers";
import { inferenceTargetForTask, type RoutedTask } from "@/lib/ai/routing";
import { automationAgentVersion } from "@/lib/automation/prompts";
import {
  PROFILE_CHECK_IDEMPOTENCY_TEMPLATE,
  PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  PROFILE_CHECK_REQUESTED_EVENT,
} from "@/lib/profile-corrections/constants";
import { PROFILE_INFERENCE_WORKFLOW_KEYS } from "@/lib/profile-corrections/dispatch";

beforeAll(() => {
  registerAutomationNodes();
});

function node(key: string) {
  const found = profileCorrectionWorkflow.nodes.find((n) => n.key === key);
  if (!found) throw new Error(`node ${key} missing`);
  return found;
}

describe("profile correction workflow (spec 147 slice 1)", () => {
  it("fetches through dom.fetch_public_profile from the event payload", () => {
    const fetchProfile = node("fetch_profile");
    expect(fetchProfile.handler).toBe("dom.fetch_public_profile");
    expect(fetchProfile.type).toBe("deterministic_task");
    expect(fetchProfile.config).toMatchObject({ urlPath: "payload.profileUrl" });
    expect(fetchProfile.config?.capability).toBeUndefined();
    expect(hasHandler("dom.fetch_public_profile")).toBe(true);
  });

  it("keeps the frozen front half exactly as shipped (specs 145B–146)", () => {
    const pick = (key: string) => {
      const n = node(key);
      return { handler: n.handler, type: n.type, agentVersion: n.agentVersion, config: n.config };
    };
    expect(pick("entry")).toMatchObject({ handler: "trg.domain_event" });
    expect(pick("canonical_extract")).toMatchObject({
      handler: "dom.extract_canonical_claims",
      config: { contextPath: "fetch_profile" },
    });
    expect(node("canonical_extract").config).toEqual({
      actionType: node("canonical_extract").config?.actionType,
      contextPath: "fetch_profile",
    });
    expect(node("approved_facts").handler).toBe("dom.build_evidence_packet");
    expect(node("approved_facts").config).toMatchObject({ purpose: "profile_correction", audience: "public" });
    expect(pick("compare")).toMatchObject({
      handler: "agt.detect_contradictions",
      type: "verification_task",
      agentVersion: automationAgentVersion("detect_contradictions"),
      config: {
        contextPaths: { observedClaims: "canonical_extract.claims", approvedFacts: "approved_facts" },
      },
    });
    expect(node("compare").agentVersion).toBe("detect-contradictions-v2");
    expect(node("has_error").config).toMatchObject({
      path: "compare.contradictions.0.severity",
      comparator: "truthy",
    });
    expect(node("severity").config).toMatchObject({ valuePath: "compare.confidence" });

    const edges = profileCorrectionWorkflow.edges.map((e) => `${e.from}->${e.to}`);
    for (const e of [
      "entry->fetch_profile",
      "fetch_profile->canonical_extract",
      "canonical_extract->approved_facts",
      "approved_facts->compare",
      "compare->has_error",
      "has_error->no_error",
      "has_error->severity",
      "no_error->done",
    ]) {
      expect(edges).toContain(e);
    }
  });

  it("reaches no paid model, connector fetch, draft or send", () => {
    const handlers = profileCorrectionWorkflow.nodes.map((n) => n.handler ?? "");
    for (const forbidden of [
      "agt.draft_outreach",
      "agt.verify_claims",
      "int.cms_fetch_public_page",
      "int.email_create_draft",
      "int.email_send_approved_message",
      "det.schedule_remeasurement",
    ]) {
      expect(handlers).not.toContain(forbidden);
    }
    const agentTasks = handlers.filter((h) => h.startsWith("agt."));
    expect(agentTasks).toEqual(["agt.detect_contradictions"]);
    for (const h of agentTasks) {
      const target = inferenceTargetForTask(h.slice("agt.".length) as RoutedTask);
      expect(target).toMatchObject({ backend: "ollama", execution: "local" });
    }
  });

  it("holds a found contradiction visibly instead of drafting it", () => {
    const pending = node("correction_pending");
    expect(pending.handler).toBe("ctl.safe_stop");
    expect(String(pending.config?.reason)).toContain("nothing is drafted or sent");
    const edges = profileCorrectionWorkflow.edges.map((e) => `${e.from}->${e.to}`);
    expect(edges).toContain("severity->correction_pending");
  });

  it("requires no connector and bounds parked runs per project", () => {
    expect(profileCorrectionWorkflow.requiredConnectors).toEqual([]);
    expect(profileCorrectionWorkflow.maxConcurrentRuns).toBe(PROFILE_CHECK_MAX_PROFILES_PER_PROJECT);
  });

  it("starts from a released profile check, per check request and tenant", () => {
    const trigger = profileCorrectionWorkflow.triggers.find(
      (t) => t.kind === "domain_event" && t.eventType === PROFILE_CHECK_REQUESTED_EVENT
    );
    expect(trigger).toMatchObject({ idempotencyTemplate: PROFILE_CHECK_IDEMPOTENCY_TEMPLATE });
    expect(PROFILE_CHECK_IDEMPOTENCY_TEMPLATE).toContain("{{event.projectId}}");
    expect(PROFILE_CHECK_IDEMPOTENCY_TEMPLATE).toContain("{{payload.checkRequestId}}");
    // The pre-existing triggers are unchanged (spec 145C).
    expect(profileCorrectionWorkflow.triggers.find((t) => t.kind === "domain_event")).toMatchObject({
      eventType: "profile.error_detected",
      idempotencyTemplate: "profile:{{payload.profileUrl}}",
    });
    expect(PROFILE_INFERENCE_WORKFLOW_KEYS).toContain(profileCorrectionWorkflow.key);
  });

  it("validates the definition and every path", () => {
    expect(validateAutomationDefinition(profileCorrectionWorkflow)).toEqual([]);
    expect(validateNodePaths(profileCorrectionWorkflow)).toEqual([]);
  });

  it("reports a fetch urlPath that is not readable from an ancestor", () => {
    const broken = {
      ...profileCorrectionWorkflow,
      nodes: profileCorrectionWorkflow.nodes.map((n) =>
        n.key === "fetch_profile" ? { ...n, config: { ...n.config, urlPath: "compare.profileUrl" } } : n
      ),
    };
    expect(validateNodePaths(broken).some((e) => e.includes("urlPath"))).toBe(true);
  });
});
