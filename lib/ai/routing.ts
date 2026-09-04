/**
 * Model routing (spec 055). One table answers "which model runs this task,
 * and why" — the decision that was previously a default parameter landing
 * on the most expensive model in the fleet (audit A2: 16 of 19 automation
 * agents ran frontier, including narrow summarize/extract work).
 *
 * Fail-closed: an unknown task THROWS. A new LLM task cannot ship without
 * an explicit, rationale-carrying route in a reviewable diff — routing is
 * policy, and policy changes belong in code review, not config.
 *
 * Tiers resolve to the existing model constants so a model bump stays a
 * one-line change; the llm_calls ledger and the classifier instrument
 * stamps record the RESOLVED model, so routing changes are visible in
 * provenance.
 */
import { AGENT_MODEL } from "@/lib/ai/agent";
import { CLASSIFIER_MODEL } from "@/lib/constants";
import { ClassifiedError } from "@/lib/errors";

export const ROUTING_VERSION = "model-routing-v1";

/** cheap = narrow, high-volume judgments; frontier = client-facing or
 * judgment-heavy work where a wrong answer costs more than the tokens
 * saved (audit A5's false-economy warning). */
export type ModelTier = "cheap" | "frontier";

export const TIER_MODELS: Record<ModelTier, string> = {
  cheap: CLASSIFIER_MODEL,
  frontier: AGENT_MODEL,
};

export interface TaskRoute {
  tier: ModelTier;
  rationale: string;
}

export const TASK_ROUTES = {
  // ------------------------------------------------- measurement pipeline
  mention_classification: {
    tier: "cheap",
    rationale: "Narrow per-response judgment at the platform's highest volume; gold-set gated (spec 050).",
  },
  mention_verification: {
    tier: "cheap",
    rationale: "Fresh-context check of a cheap judgment; disagreement routes to a human either way.",
  },
  accuracy_analysis: {
    tier: "frontier",
    rationale: "Findings drive client-facing corrections; a missed contradiction is a client-visible error.",
  },
  knowledge_claim_extraction: {
    tier: "cheap",
    rationale: "Narrow extraction into a proposed state — every claim passes human approval before use (audit A4).",
  },
  // -------------------------------------------------- content engine
  content_brief: {
    tier: "frontier",
    rationale: "The brief shapes everything downstream; a weak brief wastes a frontier draft.",
  },
  content_drafting: {
    tier: "frontier",
    rationale: "Client-facing prose quality is the product; the gates catch errors, not mediocrity.",
  },
  content_fact_verify: {
    tier: "frontier",
    rationale: "Gates publication (audit A5: never let a cheap verifier gate expensive client work).",
  },
  adversarial_review: {
    tier: "frontier",
    rationale: "A weak critic passes weak work; the whole value is judgment depth.",
  },
  artifact_verification: {
    tier: "frontier",
    rationale: "The verifier's verdict gates artifacts; a cheap gate on expensive work is the A5 false economy.",
  },
  // ------------------------------------------------ workspace assistant
  workspace_assistant: {
    tier: "frontier",
    rationale: "Open-ended tool-using dialogue over live operator questions; capped at 10 calls per turn.",
  },
  assistant_task: {
    tier: "frontier",
    rationale:
      "Delegated multi-step execution (spec 115): same open-ended tool use as the chat loop, unattended — hard step and cost budgets per task.",
  },
  // ---------------------------------- automation registry (one per prompt)
  classify_lead: {
    tier: "cheap",
    rationale: "Narrow, high-volume classification; unknown is a valid answer.",
  },
  draft_outreach: {
    tier: "frontier",
    rationale: "First outbound touch to a high-value prospect — outward-facing prose.",
  },
  audit_sense_check: {
    tier: "frontier",
    rationale:
      "Reads the whole prospect-facing audit for coherence and tone before it ships — the language-judgment case the cheap tier reliably misses (spec 077).",
  },
  classify_reply: {
    tier: "cheap",
    rationale: "Short-text intent classification; low-confidence routes to a human.",
  },
  report_prospect_review: {
    tier: "frontier",
    rationale:
      "Reads the whole private report as the recipient would before it is sent unattended — judgment about clarity and relevance for a non-technical reader (spec 129).",
  },
  extract_claims: {
    tier: "cheap",
    rationale: "Narrow extraction, human-approved downstream (audit A4 downgrade).",
  },
  verify_claims: {
    tier: "frontier",
    rationale: "The verifier gates what becomes an approvable claim; a cheap check corrupting evidence is the A5 false economy.",
  },
  build_content_brief: {
    tier: "frontier",
    rationale: "The brief shapes everything downstream; a weak brief wastes a frontier draft.",
  },
  draft_content: {
    tier: "frontier",
    rationale: "Client-facing prose quality is the product; the gates catch errors, not mediocrity.",
  },
  verify_content: {
    tier: "frontier",
    rationale: "Gates publication (audit A5: never let a cheap verifier gate expensive client work).",
  },
  adversarial_content_review: {
    tier: "frontier",
    rationale: "A weak critic passes weak work; the whole value is judgment depth.",
  },
  diagnose_visibility_gap: {
    tier: "frontier",
    rationale: "Open-ended diagnosis that can reach client conversations.",
  },
  prioritize_authority_actions: {
    tier: "cheap",
    rationale: "The ranking is deterministic — the agent only explains it (audit A4 downgrade).",
  },
  analyze_competitor_evidence: {
    tier: "frontier",
    rationale: "Competitive claims end up in client-facing material; nuance matters.",
  },
  summarize_meeting: {
    tier: "cheap",
    rationale: "Internal summarization of supplied text (audit A4 downgrade).",
  },
  draft_meeting_followup: {
    tier: "cheap",
    rationale: "Internal draft, human-edited before anything leaves (audit A4 downgrade).",
  },
  summarize_support_request: {
    tier: "cheap",
    rationale: "Narrow, internal triage.",
  },
  analyze_renewal_risk: {
    tier: "frontier",
    rationale: "Commercial judgment on mixed evidence; a missed risk is a lost client.",
  },
  detect_contradictions: {
    tier: "frontier",
    rationale: "A missed contradiction ships a wrong claim; recall matters more than tokens.",
  },
  generate_executive_narrative: {
    tier: "frontier",
    rationale: "The operator's gated decision surface; synthesis quality is the point.",
  },
  repurpose_content: {
    tier: "cheap",
    rationale: "Reformatting existing approved material; the source was already frontier-drafted (audit A4 downgrade).",
  },
} as const satisfies Record<string, TaskRoute>;

export type RoutedTask = keyof typeof TASK_ROUTES;

export function modelForTask(task: RoutedTask): string {
  const route = TASK_ROUTES[task];
  if (!route) {
    throw new ClassifiedError(
      "validation",
      `No model route exists for task "${String(task)}" — add it to TASK_ROUTES with a tier and rationale (spec 055). Routing is fail-closed by design.`
    );
  }
  return TIER_MODELS[route.tier];
}
