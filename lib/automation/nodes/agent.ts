/**
 * Agent nodes.
 *
 * Three rules hold for every agent in this file, and they are structural rather
 * than aspirational:
 *
 *  1. **An agent drafts and classifies; it never acts.** An agent output reaches
 *     the outside world only through an integration node that a human or an
 *     autonomy policy released.
 *  2. **Output is schema-validated or the node fails.** `runAgent` retries once
 *     and then raises. There is no "mostly parsed" path.
 *  3. **An agent sees only its run's client.** The prompt is built from the
 *     run's own scope, and `NodeContext` has no accessor for anything else — no
 *     credentials, no other tenant, no ambient database handle.
 *
 * Prompts live in `lib/automation/prompts.ts` (docs/13: never hardcode a prompt
 * in a feature module).
 */
import { z } from "zod";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { resolve } from "@/lib/automation/nodes/paths";
import { runModeFor } from "@/lib/automation/testmode";
import { AUTOMATION_PROMPTS, type AutomationAgentKey } from "@/lib/automation/prompts";
import { log } from "@/lib/logger";
import type { NodeHandler, NodeResult } from "@/lib/workflow/types";

// ---------------------------------------------------------------- schemas

/** Every agent output carries its own confidence and its own reasoning. */
const confidence = z.number().min(0).max(1);

const leadClassification = z.object({
  accountType: z.enum(["individual_agent", "team", "brokerage", "developer", "other", "unknown"]),
  market: z.string().default("unknown"),
  teamSize: z.enum(["1", "2-10", "11-50", "51-200", "200+", "unknown"]).default("unknown"),
  estimatedFit: z.enum(["strong", "moderate", "weak", "unknown"]),
  useCase: z.string().default(""),
  urgency: z.enum(["immediate", "this_quarter", "exploratory", "unknown"]),
  budgetSignal: z.enum(["explicit", "implied", "none", "unknown"]),
  authorityMaturity: z.enum(["established", "emerging", "minimal", "unknown"]),
  aiVisibilityNeed: z.enum(["high", "medium", "low", "unknown"]),
  qualificationScore: z.number().min(0).max(100),
  confidence,
  recommendedNextStep: z.string(),
  reasoning: z.string(),
});

const outreachDraft = z.object({
  subject: z.string().min(3),
  body: z.string().min(20),
  claims: z
    .array(
      z.object({
        statement: z.string(),
        kind: z.enum(["fact", "calculation", "observation", "question", "opinion"]),
        evidenceIds: z.array(z.string()).default([]),
        sourceUrl: z.string().optional(),
      })
    )
    .default([]),
  confidence,
  /** Anything the agent wanted to say but could not support. Surfaced, not dropped. */
  omittedForLackOfEvidence: z.array(z.string()).default([]),
});

/** Spec 077: the sense-check DESCRIBES problems, never rewrites — no field
 * in this shape can carry replacement copy. Exported for the service and
 * its tests. */
export const auditSenseCheck = z.object({
  concerns: z
    .array(
      z.object({
        severity: z.enum(["concern", "polish"]),
        // The model sometimes labels a concern with an area outside the
        // vocabulary (found live: "authority-signals") or omits it. A
        // mislabeled concern is still a concern — surfaced as "other",
        // never dropped, never a two-strike failure of the whole check
        // (the diagnose layer's unknown-kind rule, applied here).
        area: z
          .enum(["coherence", "overreach", "copy", "numbers", "fairness", "other"])
          .catch("other"),
        detail: z.string().min(1),
        quote: z.string().nullable().default(null),
      })
    )
    .default([]),
  overallReadsFair: z.boolean(),
  confidence,
  /** WHY the confidence is what it is (docs/12): named limiting factors. */
  confidenceNote: z.string().min(1),
});
export type AuditSenseCheckOutput = z.infer<typeof auditSenseCheck>;

/** Spec 129: the private report read from the recipient's point of view.
 * `verdict` is the only field the send gate acts on besides blocking
 * concerns and confidence; everything else is for the founder's eyes. */
export const reportProspectReview = z.object({
  verdict: z.enum(["send", "fix"]),
  concerns: z
    .array(
      z.object({
        severity: z.enum(["blocking", "polish"]),
        area: z
          .enum(["clarity", "relevance", "jargon", "numbers", "tone", "structure", "missing", "other"])
          .catch("other"),
        detail: z.string().min(1),
        quote: z.string().nullable().default(null),
      })
    )
    .default([]),
  /** What a busy agent takes away in the first thirty seconds. */
  firstImpression: z.string().min(1),
  /** The one question this reader would reply with. */
  topQuestion: z.string().nullable().default(null),
  confidence,
  confidenceNote: z.string().min(1),
});
export type ReportProspectReviewOutput = z.infer<typeof reportProspectReview>;

const replyClassification = z.object({
  intent: z.enum([
    "interested",
    "not_interested",
    "referral",
    "question",
    "opt_out",
    "out_of_office",
    "wrong_person",
    "unclear",
  ]),
  /** Drives the stop rules. Explicit so nothing infers a stop from prose. */
  shouldStopSequence: z.boolean(),
  isOptOut: z.boolean(),
  meetingRequested: z.boolean(),
  suggestedResponse: z.string().default(""),
  confidence,
  reasoning: z.string(),
});

const claimExtraction = z.object({
  claims: z
    .array(
      z.object({
        statement: z.string(),
        subject: z.string().default(""),
        predicate: z.string().default(""),
        objectValue: z.string().default(""),
        verifiable: z.boolean(),
        sourceExcerpt: z.string().default(""),
      })
    )
    .default([]),
  confidence,
});

const claimVerification = z.object({
  verdicts: z
    .array(
      z.object({
        statement: z.string(),
        verdict: z.enum(["supported", "contradicted", "unsupported", "unverifiable"]),
        evidenceIds: z.array(z.string()).default([]),
        explanation: z.string(),
      })
    )
    .default([]),
  allSupported: z.boolean(),
  confidence,
});

const contentBrief = z.object({
  workingTitle: z.string(),
  audience: z.string(),
  searchIntent: z.string(),
  outline: z.array(z.object({ heading: z.string(), points: z.array(z.string()).default([]) })),
  claimsToSupport: z.array(z.string()).default([]),
  evidenceNeeded: z.array(z.string()).default([]),
  prohibitedClaims: z.array(z.string()).default([]),
  confidence,
});

const contentDraft = z.object({
  title: z.string(),
  body: z.string().min(100),
  claims: z
    .array(
      z.object({
        statement: z.string(),
        kind: z.enum(["fact", "calculation", "observation", "opinion"]),
        evidenceIds: z.array(z.string()).default([]),
      })
    )
    .default([]),
  wordCount: z.number().int().nonnegative(),
  confidence,
});

const adversarialReview = z.object({
  issues: z
    .array(
      z.object({
        severity: z.enum(["blocking", "major", "minor"]),
        category: z.enum([
          "unsupported_claim",
          "overclaim",
          "causality",
          "privacy",
          "compliance",
          "accuracy",
          "tone",
        ]),
        excerpt: z.string(),
        explanation: z.string(),
        suggestedFix: z.string().default(""),
      })
    )
    .default([]),
  publishable: z.boolean(),
  confidence,
});

const visibilityDiagnosis = z.object({
  primaryGap: z.string(),
  contributingFactors: z.array(z.string()).default([]),
  /** Each hypothesis is labelled, so nothing reads as established fact. */
  hypotheses: z
    .array(z.object({ statement: z.string(), evidenceStrength: z.enum(["strong", "moderate", "weak"]) }))
    .default([]),
  recommendedActions: z
    .array(
      z.object({
        action: z.string(),
        expectedEffect: z.string(),
        effort: z.enum(["low", "medium", "high"]),
        confidence,
      })
    )
    .default([]),
  confidence,
});

const prioritization = z.object({
  ranked: z
    .array(
      z.object({
        id: z.string(),
        rank: z.number().int().positive(),
        rationale: z.string(),
        expectedImpact: z.enum(["high", "medium", "low"]),
      })
    )
    .default([]),
  confidence,
});

const competitorAnalysis = z.object({
  findings: z
    .array(
      z.object({
        competitor: z.string(),
        change: z.string(),
        /** The four-way epistemic label the spec requires. */
        kind: z.enum(["verified_change", "interpretation", "hypothesis", "unknown"]),
        materiality: z.enum(["material", "notable", "noise"]),
        evidenceUrl: z.string().default(""),
      })
    )
    .default([]),
  confidence,
});

const meetingSummary = z.object({
  decisions: z.array(z.object({ summary: z.string(), owner: z.string().default("") })).default([]),
  actionItems: z
    .array(
      z.object({
        summary: z.string(),
        owner: z.string().default(""),
        dueDate: z.string().default(""),
      })
    )
    .default([]),
  unresolvedQuestions: z.array(z.string()).default([]),
  relationshipNotes: z.array(z.string()).default([]),
  /** True when the notes contain anything that should not be auto-sent. */
  containsSensitiveContent: z.boolean(),
  confidence,
});

const followupDraft = z.object({
  subject: z.string(),
  body: z.string(),
  confidence,
  requiresHumanReview: z.boolean(),
  reviewReason: z.string().default(""),
});

const supportClassification = z.object({
  category: z.enum([
    "report_timing",
    "workflow_status",
    "approval_request",
    "access_instructions",
    "metric_definition",
    "integration_status",
    "strategic_advice",
    "pricing",
    "complaint",
    "legal",
    "privacy",
    "attribution_dispute",
    "scope_change",
    "other",
  ]),
  urgency: z.enum(["low", "normal", "high", "critical"]),
  autoResponseAllowed: z.boolean(),
  suggestedResponse: z.string().default(""),
  escalationReason: z.string().default(""),
  confidence,
});

const renewalRisk = z.object({
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  signals: z.array(z.object({ signal: z.string(), direction: z.enum(["positive", "negative"]) })).default([]),
  recommendedActions: z.array(z.string()).default([]),
  confidence,
});

const contradictionDetection = z.object({
  contradictions: z
    .array(
      z.object({
        statementA: z.string(),
        statementB: z.string(),
        severity: z.enum(["low", "medium", "high", "critical"]),
        explanation: z.string(),
      })
    )
    .default([]),
  confidence,
});

const executiveNarrative = z.object({
  statements: z
    .array(
      z.object({
        text: z.string(),
        /** Statement kind is mandatory — an interpretation must not read as a fact. */
        kind: z.enum([
          "fact",
          "calculation",
          "interpretation",
          "recommendation",
          "correlation",
          "causal",
          "unknown",
        ]),
        supportingMetric: z.string().default(""),
      })
    )
    .default([]),
  confidence,
});

const repurposedAsset = z.object({
  format: z.string(),
  content: z.string(),
  claimsUsed: z.array(z.string()).default([]),
  confidence,
});

/** The agent catalogue: key → schema. Prompts live in prompts.ts. */
const clientReview = z.object({
  pass: z.boolean(),
  issues: z.array(
    z.object({
      kind: z.enum(["unsupported_claim", "causal_overclaim", "contradiction", "technical_language", "salesy"]).catch("unsupported_claim"),
      quote: z.string().max(400),
      why: z.string().max(600),
    })
  ),
});

const AGENT_SCHEMAS = {
  classify_lead: leadClassification,
  draft_outreach: outreachDraft,
  audit_sense_check: auditSenseCheck,
  classify_reply: replyClassification,
  extract_claims: claimExtraction,
  verify_claims: claimVerification,
  build_content_brief: contentBrief,
  draft_content: contentDraft,
  verify_content: claimVerification,
  adversarial_content_review: adversarialReview,
  diagnose_visibility_gap: visibilityDiagnosis,
  prioritize_authority_actions: prioritization,
  analyze_competitor_evidence: competitorAnalysis,
  summarize_meeting: meetingSummary,
  draft_meeting_followup: followupDraft,
  summarize_support_request: supportClassification,
  analyze_renewal_risk: renewalRisk,
  detect_contradictions: contradictionDetection,
  generate_executive_narrative: executiveNarrative,
  repurpose_content: repurposedAsset,
  report_prospect_review: reportProspectReview,
  // Spec 132 constrained reviewers: advisory issues over a supplied fact pack.
  client_communication_review: clientReview,
  client_evidence_review: clientReview,
} as const satisfies Record<AutomationAgentKey, z.ZodTypeAny>;

export type AgentOutputFor<K extends AutomationAgentKey> = z.infer<(typeof AGENT_SCHEMAS)[K]>;

export function agentSchema(key: AutomationAgentKey): z.ZodTypeAny {
  return AGENT_SCHEMAS[key];
}

export function implementedAgentKeys(): AutomationAgentKey[] {
  return Object.keys(AGENT_SCHEMAS) as AutomationAgentKey[];
}

// ------------------------------------------------------------------ runner

/**
 * Injectable caller, so tests exercise agent nodes without a network or a token.
 * Production leaves it unset and `runAgent` uses the real provider.
 */
let injectedCaller: AgentCaller | undefined;

export function setAgentCallerForTests(caller: AgentCaller | undefined): void {
  injectedCaller = caller;
}

/**
 * Build one agent node. The node reads its context from upstream outputs, calls
 * the pinned model with a versioned prompt, validates, and returns the output
 * plus its confidence — which a downstream `ctl.confidence_gate` can route on.
 */
export function agentNode(key: AutomationAgentKey): NodeHandler {
  return async (ctx): Promise<NodeResult> => {
    const prompt = AUTOMATION_PROMPTS[key];
    const mode = await runModeFor(ctx.runId);

    // A test run uses its canned output. That keeps demos free and repeatable,
    // and it is why the E2E scenarios cost nothing to run.
    const canned = mode.fixtures.agentResponses[key] ?? mode.fixtures.agentResponses[ctx.nodeKey];
    if (mode.mode === "test") {
      if (canned === undefined) {
        return {
          outcome: "failed_terminal",
          error: `Test run has no canned output for agent "${key}". Add one to the fixture.`,
        };
      }
      const parsed = AGENT_SCHEMAS[key].safeParse(canned);
      if (!parsed.success) {
        return {
          outcome: "failed_terminal",
          error: `Fixture for agent "${key}" does not match its schema: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        };
      }
      const output = parsed.data as { confidence?: number };
      return {
        outcome: "succeeded",
        output: { ...(parsed.data as Record<string, unknown>), fromFixture: true },
        confidence: output.confidence,
        costMicroUsd: 0,
      };
    }

    // The agent sees exactly what the template hands it, from this run's scope.
    const contextPath = ctx.config.contextPath === undefined ? null : String(ctx.config.contextPath);
    const contextData = contextPath ? await resolve(ctx, contextPath) : ctx.inputs;
    const extra = (ctx.config.params as Record<string, unknown> | undefined) ?? {};

    try {
      const result = await runAgent({
        agentVersion: prompt.version,
        system: prompt.system,
        user: `${prompt.userPreamble}\n\n${JSON.stringify(
          { context: contextData ?? {}, parameters: extra },
          null,
          2
        )}`,
        schema: AGENT_SCHEMAS[key] as z.ZodType<unknown, z.ZodTypeDef, unknown>,
        model: prompt.model,
        caller: injectedCaller,
      });

      const output = result.output as Record<string, unknown>;
      const observedConfidence =
        typeof output.confidence === "number" ? output.confidence : undefined;

      log("info", "automation.agent", {
        agent: prompt.version,
        node: ctx.nodeKey,
        attempts: result.attempts,
        costMicroUsd: result.costMicroUsd,
      });

      return {
        outcome: "succeeded",
        output: { ...output, agentVersion: prompt.version },
        confidence: observedConfidence,
        costMicroUsd: result.costMicroUsd,
      };
    } catch (err) {
      // A schema failure after a retry is terminal: an agent that cannot produce
      // its contract twice is not going to on the third attempt, and guessing at
      // what it meant is exactly what this platform must not do.
      return {
        outcome: "failed_terminal",
        error: err instanceof Error ? err.message : `agent ${key} failed`,
      };
    }
  };
}

export const agentNodes: Record<string, NodeHandler> = Object.fromEntries(
  implementedAgentKeys().map((key) => [`agt.${key}`, agentNode(key)])
);
