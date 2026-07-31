/**
 * Versioned agent registry (spec 018 Part 9).
 *
 * Eight agents already existed as versioned prompt constants scattered across
 * feature modules (docs/13). This registry does not re-implement them — it
 * declares them in one place with their schemas, scopes, limits, and
 * prohibitions, so the platform can answer "what may this agent do, on what
 * data, at what cost?" without reading five files.
 *
 * `status` is deliberately explicit:
 *   - "implemented"  → a runner exists today; `module` names it.
 *   - "declared"     → the contract is fixed and the graph can reference it,
 *                      but no runner is wired yet. Never pretend otherwise.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { AGENT_MODEL } from "@/lib/ai/agent";
import { CLASSIFIER_MODEL } from "@/lib/constants";
import { registerAgentVersions } from "@/lib/workflow/agent-versions";

export type AgentStatus = "implemented" | "declared";

/** Which of the five connected products the agent serves. */
export type AgentDomain =
  | "visibility"
  | "reputation"
  | "authority"
  | "revenue"
  | "advisory"
  | "platform";

export interface AgentDefinition {
  key: string;
  name: string;
  mission: string;
  domain: AgentDomain;
  version: string;
  model: string;
  status: AgentStatus;
  /** Where the runner lives, for an implemented agent. */
  module?: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  allowedTools: string[];
  /** Data the agent may be shown. Anything not listed is withheld. */
  allowedDataScopes: string[];
  prohibitedActions: string[];
  evidenceRequirements: string[];
  minConfidence?: number;
  escalationConditions: string[];
  maxCostMicroUsd?: number;
  maxSeconds?: number;
  evaluationSuite?: string;
  // ---- context requirements (spec 022) ---------------------------------
  /**
   * The context-packet template this agent must be given. When set, the agent
   * receives a packet built to that template rather than whatever context a
   * caller assembled — which is the difference between a contract and a habit.
   */
  requiredPacketTemplate?: string;
  /** Hard ceiling on the context this agent may be handed. */
  maxContextTokens?: number;
  /** Claims worse than this are excluded from its packet and disclosed. */
  minFreshness?: "current" | "nearing_review" | "stale" | "unknown";
  /** Evidence classes the packet must contain for the task to be attempted. */
  requiredEvidenceClasses?: string[];
  /** Privacy classes this agent may ever see. `restricted` is never allowed. */
  allowedPrivacyClasses?: ("public" | "client_only" | "internal")[];
  /** Knowledge categories that must never reach this agent. */
  prohibitedKnowledgeCategories?: string[];
}

// Shared shapes ------------------------------------------------------------

const confidenceField = z.number().min(0).max(1);

const findingsOutput = z.object({
  findings: z.array(
    z.object({
      summary: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      evidenceIds: z.array(z.string()).default([]),
      confidence: confidenceField,
    })
  ),
});

export const VERIFICATION_DECISIONS = [
  "approved",
  "approved_with_minor_corrections",
  "rejected",
  "insufficient_evidence",
  "human_review_required",
] as const;

export const verifierOutputSchema = z.object({
  decision: z.enum(VERIFICATION_DECISIONS),
  errorsFound: z.array(z.string()).default([]),
  unsupportedClaims: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  severity: z.enum(["none", "low", "medium", "high", "critical"]).default("none"),
  requiredCorrection: z.string().default(""),
  confidence: confidenceField,
  humanReviewRecommended: z.boolean().default(false),
});
export type VerifierOutput = z.infer<typeof verifierOutputSchema>;

export const ADVERSARIAL_QUESTIONS = [
  "What might be false?",
  "What is overstated?",
  "What evidence is weak?",
  "What would a competitor challenge?",
  "What might mislead a client?",
  "What could create legal risk?",
  "What could create reputational risk?",
  "What could disclose confidential information?",
  "What could be interpreted as a guaranteed ranking?",
  "What attribution statement overclaims causality?",
] as const;

export const adversarialOutputSchema = z.object({
  issues: z.array(
    z.object({
      question: z.string(),
      issue: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      suggestedFix: z.string().default(""),
      quote: z.string().default(""),
    })
  ),
  overallRisk: z.enum(["low", "medium", "high", "critical"]),
});
export type AdversarialOutput = z.infer<typeof adversarialOutputSchema>;

export const briefOutputSchema = z.object({
  headline: z.string(),
  statements: z.array(
    z.object({
      text: z.string(),
      kind: z.enum([
        "fact",
        "calculation",
        "interpretation",
        "recommendation",
        "correlation",
        "causal",
        "unknown",
      ]),
      evidenceIds: z.array(z.string()).default([]),
      material: z.boolean().default(false),
      hasRationale: z.boolean().default(true),
    })
  ),
  nextPriorities: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
});
export type BriefOutput = z.infer<typeof briefOutputSchema>;

// The registry -------------------------------------------------------------

const NEVER_WRITE = [
  "write to any database table",
  "publish, send, or submit anything externally",
  "invent a client fact not present in its evidence packet",
];

export const AGENTS: AgentDefinition[] = [
  // ---- already implemented (declared here, not rebuilt) -------------------
  {
    key: "response_classification",
    name: "Response Classification Agent",
    mission:
      "Decide, for one captured response, which known companies were mentioned and how.",
    domain: "visibility",
    version: "mention-classifier-v2",
    model: CLASSIFIER_MODEL,
    status: "implemented",
    module: "lib/parsing/classify-llm.ts",
    inputSchema: z.object({
      responseText: z.string(),
      companies: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
    outputSchema: z.object({
      mentions: z.array(
        z.object({ companyId: z.string(), sentiment: z.string(), confidence: confidenceField })
      ),
    }),
    allowedTools: [],
    allowedDataScopes: ["captured_response", "project_company_list"],
    prohibitedActions: NEVER_WRITE,
    evidenceRequirements: ["the raw captured response"],
    minConfidence: 0.7,
    escalationConditions: ["confidence below the review threshold", "company id not in the provided list"],
    evaluationSuite: "parser-accuracy",
    requiredPacketTemplate: "response_classification",
    maxContextTokens: 3_000,
    minFreshness: "stale",
    allowedPrivacyClasses: ["public", "client_only"],
    // A classifier that can see sales figures will start using them to decide
    // whether a mention is favourable. It has no business with them.
    prohibitedKnowledgeCategories: ["transaction", "sales_volume", "strategy"],
  },
  {
    key: "independent_response_verifier",
    name: "Independent Response Verifier",
    mission:
      "Re-judge a low-confidence classification with fresh context, never seeing the classifier's reasoning.",
    domain: "visibility",
    version: "mention-verifier-v2",
    model: CLASSIFIER_MODEL,
    status: "implemented",
    module: "lib/parsing/classify-llm.ts",
    inputSchema: z.object({ responseText: z.string(), proposal: z.unknown() }),
    outputSchema: z.object({ agrees: z.boolean(), confidence: confidenceField }),
    allowedTools: [],
    allowedDataScopes: ["captured_response"],
    prohibitedActions: [...NEVER_WRITE, "receive the creator's reasoning or self-evaluation"],
    evidenceRequirements: ["the raw captured response"],
    escalationConditions: ["disagreement with the classifier"],
  },
  {
    key: "accuracy_monitor",
    name: "Reputation Accuracy Agent",
    mission:
      "Find statements in AI answers that contradict approved client claims, quoting verbatim.",
    domain: "reputation",
    version: "accuracy-monitor-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/accuracy/service.ts",
    inputSchema: z.object({ responseText: z.string(), claims: z.array(z.unknown()) }),
    outputSchema: findingsOutput,
    allowedTools: [],
    allowedDataScopes: ["captured_response", "approved_claims"],
    prohibitedActions: NEVER_WRITE,
    evidenceRequirements: ["a verbatim quote from the response", "the contradicted claim id"],
    escalationConditions: ["quote not found verbatim in the response"],
    requiredPacketTemplate: "claim_verification",
    maxContextTokens: 6_000,
    minFreshness: "unknown",
    allowedPrivacyClasses: ["public", "client_only", "internal"],
  },
  {
    key: "content_brief",
    name: "Content Brief Agent",
    mission: "Turn an evidence gap into a brief that names the claims the piece must carry.",
    domain: "authority",
    version: "content-brief-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/content/service.ts",
    inputSchema: z.object({ gap: z.unknown(), packet: z.unknown() }),
    outputSchema: z.object({ outline: z.array(z.string()), requiredClaimIds: z.array(z.string()) }),
    allowedTools: [],
    allowedDataScopes: ["evidence_packet", "gap_finding"],
    prohibitedActions: NEVER_WRITE,
    evidenceRequirements: ["an evidence packet"],
    escalationConditions: ["no approved claims available for the topic"],
    requiredPacketTemplate: "content_drafting",
    maxContextTokens: 8_000,
    minFreshness: "nearing_review",
    allowedPrivacyClasses: ["public"],
  },
  {
    key: "content_draft",
    name: "Content Drafting Agent",
    mission: "Draft the asset using only the claims in its packet.",
    domain: "authority",
    version: "content-draft-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/content/service.ts",
    inputSchema: z.object({ brief: z.unknown(), packet: z.unknown() }),
    outputSchema: z.object({ body: z.string(), citedClaimIds: z.array(z.string()) }),
    allowedTools: [],
    allowedDataScopes: ["evidence_packet", "content_brief"],
    prohibitedActions: NEVER_WRITE,
    evidenceRequirements: ["an evidence packet"],
    escalationConditions: ["a required claim has no approved wording"],
    requiredPacketTemplate: "content_drafting",
    maxContextTokens: 8_000,
    minFreshness: "nearing_review",
    // A public asset may carry nothing but public claims. This is the single
    // most consequential line in the registry.
    allowedPrivacyClasses: ["public"],
  },
  {
    key: "content_fact_verifier",
    name: "Content Fact Verifier",
    mission: "Check a draft's factual claims against the packet, with fresh context.",
    domain: "authority",
    version: "fact-verify-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/content/service.ts",
    inputSchema: z.object({ draft: z.string(), packet: z.unknown() }),
    outputSchema: verifierOutputSchema,
    allowedTools: [],
    allowedDataScopes: ["evidence_packet", "draft_text"],
    prohibitedActions: [...NEVER_WRITE, "receive the drafter's reasoning"],
    evidenceRequirements: ["an evidence packet"],
    escalationConditions: ["an unsupported claim", "a prohibited wording match"],
  },
  {
    key: "evidence_gap",
    name: "Evidence Gap Agent",
    mission: "Diagnose why the client was not retrieved for a prompt cluster.",
    domain: "authority",
    version: "gap-detect-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/gaps/detect.ts",
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: findingsOutput,
    allowedTools: [],
    allowedDataScopes: ["run_scores", "competitor_mentions", "captured_responses"],
    prohibitedActions: NEVER_WRITE,
    evidenceRequirements: ["a scored run"],
    escalationConditions: ["no competitor evidence available"],
  },

  // ---- new, wired by this spec -------------------------------------------
  {
    key: "adversarial_reviewer",
    name: "Adversarial Review Agent",
    mission:
      "Attack a consequential artifact: find what is false, overstated, weakly evidenced, legally risky, or causally overclaimed.",
    domain: "platform",
    version: "adversarial-review-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/agents/verification.ts",
    inputSchema: z.object({ artifact: z.string(), packet: z.unknown() }),
    outputSchema: adversarialOutputSchema,
    allowedTools: [],
    allowedDataScopes: ["artifact_text", "evidence_packet"],
    prohibitedActions: [...NEVER_WRITE, "receive the creator's reasoning or confidence"],
    evidenceRequirements: ["the artifact", "the evidence packet it was built from"],
    escalationConditions: ["any issue at high or critical severity"],
    maxCostMicroUsd: 2_000_000,
    maxSeconds: 180,
    evaluationSuite: "adversarial-review",
  },
  {
    key: "independent_artifact_verifier",
    name: "Independent Artifact Verifier",
    mission:
      "Verify any proposed artifact against its original evidence and rubric, with no knowledge of who made it or what they concluded.",
    domain: "platform",
    version: "artifact-verifier-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/agents/verification.ts",
    inputSchema: z.object({ artifact: z.string(), rubric: z.array(z.string()) }),
    outputSchema: verifierOutputSchema,
    allowedTools: [],
    allowedDataScopes: ["artifact_text", "original_evidence", "verification_rubric", "approved_claims"],
    prohibitedActions: [
      ...NEVER_WRITE,
      "receive the creator's hidden reasoning",
      "receive the creator's preferred conclusion",
      "be told the artifact is believed correct",
      "receive the creator's self-evaluation",
    ],
    evidenceRequirements: ["the original evidence the artifact was built from"],
    escalationConditions: ["decision is rejected or insufficient_evidence"],
    maxCostMicroUsd: 2_000_000,
    maxSeconds: 180,
    evaluationSuite: "artifact-verification",
  },
  {
    key: "weekly_executive_brief",
    name: "Weekly Executive Brief Agent",
    mission:
      "Summarise a week of material changes for one client, labelling every statement as fact, calculation, interpretation, recommendation, correlation, causal, or unknown.",
    domain: "advisory",
    version: "weekly-brief-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/reports/executive.ts",
    inputSchema: z.object({ deltas: z.unknown(), packet: z.unknown() }),
    outputSchema: briefOutputSchema,
    allowedTools: [],
    allowedDataScopes: ["computed_deltas", "evidence_packet", "open_exceptions"],
    prohibitedActions: [
      ...NEVER_WRITE,
      "state a causal relationship",
      "receive raw client PII",
    ],
    evidenceRequirements: ["pre-computed metric deltas with sample sizes"],
    escalationConditions: ["the data period is incomplete", "a causal statement is proposed"],
    maxCostMicroUsd: 3_000_000,
    maxSeconds: 240,
    evaluationSuite: "executive-brief",
    requiredPacketTemplate: "executive_report",
    maxContextTokens: 10_000,
    minFreshness: "nearing_review",
    allowedPrivacyClasses: ["public", "client_only"],
  },

  {
    key: "claim_extraction",
    name: "Claim Extraction Agent",
    mission:
      "Propose candidate claims from an ingested source, quoting the document verbatim for every one.",
    domain: "reputation",
    version: "claim-extraction-v1",
    model: AGENT_MODEL,
    status: "implemented",
    module: "lib/knowledge/extraction/claims.ts",
    inputSchema: z.object({ sourceArtifactId: z.string(), maxClaims: z.number().optional() }),
    outputSchema: z.object({ claims: z.array(z.unknown()) }),
    allowedTools: [],
    allowedDataScopes: ["extracted_document"],
    prohibitedActions: [
      ...NEVER_WRITE,
      "approve a claim",
      "assign its own materiality",
      "state a fact the document does not contain",
    ],
    evidenceRequirements: ["a verbatim quote from the source document"],
    escalationConditions: [
      "the quoted wording is not present in the document",
      "a high-risk claim is proposed",
    ],
    maxCostMicroUsd: 2_000_000,
    maxSeconds: 180,
    evaluationSuite: "claim-extraction",
    maxContextTokens: 20_000,
    // It reads one source and proposes; it never sees the client's other data.
    allowedPrivacyClasses: ["public", "client_only", "internal"],
  },

  // ---- contract fixed, runner not yet wired ------------------------------
  ...declaredOnly([
    ["prompt_strategy", "Prompt Strategy Agent", "visibility", "Propose prompt clusters for a client's category."],
    ["competitor_evidence", "Competitor Evidence Agent", "visibility", "Explain why a competitor was retrieved."],
    ["evidence_verification", "Evidence Verification Agent", "reputation", "Check that a claim's cited sources support it."],
    ["contradiction_detection", "Contradiction Detection Agent", "reputation", "Detect contradictions between claims and observations."],
    ["action_prioritization", "Action Prioritization Agent", "authority", "Explain the ranking a deterministic score produced."],
    ["content_research", "Content Research Agent", "authority", "Gather external context for a brief."],
    ["transaction_opportunity", "Transaction Opportunity Agent", "authority", "Spot content opportunities in transaction data."],
    ["ranking_readiness", "Ranking Readiness Agent", "authority", "Assess readiness for a ranking submission."],
    ["newsworthiness", "Newsworthiness Agent", "authority", "Judge whether a development is newsworthy."],
    ["journalist_matching", "Journalist Matching Agent", "authority", "Match a story to plausible journalists."],
    ["ai_referral_classification", "AI Referral Classification Agent", "revenue", "Classify a referral as AI-originated or not."],
    ["lead_attribution", "Lead Attribution Agent", "revenue", "Propose an attribution class for a lead, never above its evidence."],
    ["monthly_executive_report", "Monthly Executive Report Agent", "advisory", "Compose the monthly report from computed sections."],
    ["quarterly_executive_review", "Quarterly Executive Review Agent", "advisory", "Compose the quarterly business review."],
    ["renewal_risk", "Renewal Risk Agent", "advisory", "Explain a computed renewal-risk score."],
  ]),
];

function declaredOnly(
  rows: [string, string, AgentDomain, string][]
): AgentDefinition[] {
  return rows.map(([key, name, domain, mission]) => ({
    key,
    name,
    mission,
    domain,
    version: `${key.replace(/_/g, "-")}-v1`,
    model: AGENT_MODEL,
    status: "declared" as const,
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
    allowedTools: [],
    allowedDataScopes: ["evidence_packet"],
    prohibitedActions: NEVER_WRITE,
    evidenceRequirements: ["an evidence packet"],
    escalationConditions: ["insufficient evidence"],
  }));
}

// A graph may name any agent whose contract is fixed, implemented or not, so
// every version here is publishable. Registered at import time; the workflow
// bootstrap imports this module before it registers a definition.
registerAgentVersions(AGENTS.map((a) => a.version));

export function getAgent(key: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.key === key);
}

export function implementedAgents(): AgentDefinition[] {
  return AGENTS.filter((a) => a.status === "implemented");
}

/**
 * Mirror the in-code registry into the database so the UI, evaluations, and
 * audit joins have stable ids. Idempotent; safe to run at every boot.
 */
export async function syncAgentRegistry(): Promise<{ agents: number; versions: number }> {
  let versions = 0;
  for (const agent of AGENTS) {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into agent_definitions (key, name, mission, domain, status)
        values (${agent.key}, ${agent.name}, ${agent.mission}, ${agent.domain}, 'active')
        on conflict (key) do update set
          name = excluded.name, mission = excluded.mission, domain = excluded.domain
        returning id
      `;
      const agentId = row!.id as string;
      const inserted = await tx`
        insert into agent_versions (
          agent_id, version, model, input_schema, output_schema, allowed_tools,
          allowed_data_scopes, prohibited_actions, evidence_requirements,
          min_confidence, escalation_conditions, max_cost_micro_usd, max_seconds,
          evaluation_suite
        ) values (
          ${agentId}, ${agent.version}, ${agent.model},
          ${tx.json({ status: agent.status, module: agent.module ?? null } as never)},
          ${tx.json({ status: agent.status } as never)},
          ${agent.allowedTools}, ${agent.allowedDataScopes}, ${agent.prohibitedActions},
          ${agent.evidenceRequirements}, ${agent.minConfidence ?? null},
          ${agent.escalationConditions}, ${agent.maxCostMicroUsd ?? null},
          ${agent.maxSeconds ?? null}, ${agent.evaluationSuite ?? null}
        )
        on conflict (agent_id, version) do nothing
        returning id
      `;
      if (inserted.length > 0) versions += 1;
    });
  }
  return { agents: AGENTS.length, versions };
}
