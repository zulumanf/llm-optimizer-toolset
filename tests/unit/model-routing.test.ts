/**
 * Spec 055: the routing table is the single authority on which model runs
 * which task. These tests pin the POLICY — changing a route means changing
 * this file in the same diff, which is the point: routing decisions are
 * reviewable, never incidental.
 */
import { describe, expect, it } from "vitest";
import {
  TASK_ROUTES,
  TIER_MODELS,
  modelForTask,
  type RoutedTask,
} from "@/lib/ai/routing";
import { costMicroUsd } from "@/lib/ai/pricing";
import { AGENT_MODEL } from "@/lib/ai/agent";
import { CLASSIFIER_MODEL } from "@/lib/constants";
import { AUTOMATION_AGENT_KEYS, AUTOMATION_PROMPTS } from "@/lib/automation/prompts";

describe("model routing (spec 055)", () => {
  it("every route resolves to a priced model — no route can silently break cost accounting", () => {
    for (const task of Object.keys(TASK_ROUTES) as RoutedTask[]) {
      const model = modelForTask(task);
      expect(() => costMicroUsd(model, 1000, 1000), `${task} → ${model}`).not.toThrow();
    }
  });

  it("tiers resolve to the pinned model constants", () => {
    expect(TIER_MODELS.cheap).toBe(CLASSIFIER_MODEL);
    expect(TIER_MODELS.frontier).toBe(AGENT_MODEL);
    expect(CLASSIFIER_MODEL).not.toBe(AGENT_MODEL);
  });

  it("an unknown task throws — routing is fail-closed", () => {
    expect(() => modelForTask("brand_new_task" as RoutedTask)).toThrow(/No model route/);
  });

  it("every automation prompt key has a route, and every prompt carries its routed model", () => {
    for (const key of AUTOMATION_AGENT_KEYS) {
      expect(TASK_ROUTES[key], `route missing for ${key}`).toBeDefined();
      expect(AUTOMATION_PROMPTS[key].model).toBe(modelForTask(key));
    }
  });

  it("pins the audit A4 downgrades to the cheap tier", () => {
    for (const task of [
      "summarize_meeting",
      "draft_meeting_followup",
      "repurpose_content",
      "extract_claims",
      "prioritize_authority_actions",
      "knowledge_claim_extraction",
    ] as const) {
      expect(TASK_ROUTES[task].tier, task).toBe("cheap");
    }
  });

  it("pins the measurement classifiers cheap and the client-facing gates frontier (audit A5)", () => {
    expect(TASK_ROUTES.mention_classification.tier).toBe("cheap");
    expect(TASK_ROUTES.mention_verification.tier).toBe("cheap");
    for (const task of [
      "content_drafting",
      "content_fact_verify",
      "adversarial_review",
      "artifact_verification",
      "verify_content",
      "adversarial_content_review",
      "accuracy_analysis",
      "detect_contradictions",
      "draft_outreach",
    ] as const) {
      expect(TASK_ROUTES[task].tier, task).toBe("frontier");
    }
  });

  it("every route carries a non-trivial rationale — policy without a why is a default", () => {
    for (const [task, route] of Object.entries(TASK_ROUTES)) {
      expect(route.rationale.length, task).toBeGreaterThan(20);
    }
  });
});
