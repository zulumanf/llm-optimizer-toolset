/**
 * Independent verification and adversarial QA (spec 018 Parts 10 and 11).
 *
 * The rule — *the creator of an artifact may not be its final verifier* — is
 * enforced here by **construction**, not by policy. `buildVerifierContext()`
 * assembles the verifier's payload from an allow-list, so a creator's
 * reasoning, preferred conclusion, confidence, or self-evaluation cannot leak
 * in even if a caller passes the whole creator output object.
 */
import { modelForTask } from "@/lib/ai/routing";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import {
  adversarialOutputSchema,
  verifierOutputSchema,
  ADVERSARIAL_QUESTIONS,
  type AdversarialOutput,
  type VerifierOutput,
} from "@/lib/agents/registry";
import { renderPacket, type EvidencePacket } from "@/lib/knowledge/packet";

export const VERIFIER_AGENT_VERSION = "artifact-verifier-v1";
export const ADVERSARIAL_AGENT_VERSION = "adversarial-review-v1";

/**
 * Fields a verifier must never receive. Named explicitly so the ban is
 * greppable and testable rather than implicit in a prompt.
 */
export const FORBIDDEN_VERIFIER_FIELDS = [
  "reasoning",
  "rationale",
  "chainOfThought",
  "thoughts",
  "confidence",
  "selfEvaluation",
  "selfAssessment",
  "believedCorrect",
  "creatorNotes",
  "preferredConclusion",
  "agentVersion",
] as const;

export interface VerifierContext {
  artifact: string;
  evidence: string;
  rubric: string[];
  approvedClaims: { id: string; text: string }[];
}

/**
 * Build the verifier payload by allow-list. Anything not named here is
 * dropped, including every field in FORBIDDEN_VERIFIER_FIELDS.
 */
export function buildVerifierContext(args: {
  artifact: string;
  packet: EvidencePacket | null;
  rubric: string[];
}): VerifierContext {
  return {
    artifact: args.artifact,
    evidence: args.packet ? renderPacket(args.packet) : "(no evidence packet supplied)",
    rubric: args.rubric,
    approvedClaims: (args.packet?.claims ?? []).map((c) => ({ id: c.id, text: c.text })),
  };
}

const VERIFIER_SYSTEM = `You are an independent verifier. You did not write the artifact below and you know nothing about who did or what they concluded.

Judge the artifact ONLY against the evidence and rubric provided. Specifically:
- Every factual statement must be supported by the supplied evidence. If it is not, it is unsupported — regardless of how plausible it sounds.
- Missing evidence is "insufficient_evidence", not "rejected". These are different findings and you must distinguish them.
- Do not improve the artifact. Do not rewrite it. Judge it.
- If a statement asserts causation where the evidence supports only correlation, that is an error.
- If you cannot judge a point from the evidence given, say so rather than assuming.

Return JSON only:
{"decision":"approved|approved_with_minor_corrections|rejected|insufficient_evidence|human_review_required","errorsFound":[],"unsupportedClaims":[],"missingEvidence":[],"contradictions":[],"severity":"none|low|medium|high|critical","requiredCorrection":"","confidence":0.0,"humanReviewRecommended":false}`;

export async function verifyArtifact(args: {
  context: VerifierContext;
  caller?: AgentCaller;
}): Promise<{ output: VerifierOutput; costMicroUsd: number }> {
  const user = [
    "## Rubric",
    ...args.context.rubric.map((r, i) => `${i + 1}. ${r}`),
    "",
    "## Evidence available",
    args.context.evidence,
    "",
    "## Artifact under review",
    args.context.artifact,
  ].join("\n");

  const run = await runAgent<VerifierOutput>({
    agentVersion: VERIFIER_AGENT_VERSION,
    model: modelForTask("artifact_verification"),
    system: VERIFIER_SYSTEM,
    user,
    schema: verifierOutputSchema,
    ...(args.caller ? { caller: args.caller } : {}),
  });
  return { output: run.output, costMicroUsd: run.costMicroUsd };
}

const ADVERSARIAL_SYSTEM = `You are an adversarial reviewer. Your job is to attack the artifact, not to appreciate it. Assume it will be read by a sceptical client, a competitor looking for a weakness, and eventually a lawyer.

Work through every question you are given and report only real problems — an invented objection wastes the operator's attention as surely as a missed one. Quote the exact text at fault.

Severity guide: "critical" = could mislead a client, disclose confidential information, create legal exposure, promise a ranking, or state causation the evidence cannot support. "high" = a materially overstated or weakly evidenced claim. Below that, use your judgement.

Return JSON only:
{"issues":[{"question":"","issue":"","severity":"low|medium|high|critical","suggestedFix":"","quote":""}],"overallRisk":"low|medium|high|critical"}`;

export async function adversarialReview(args: {
  artifact: string;
  packet: EvidencePacket | null;
  caller?: AgentCaller;
}): Promise<{ output: AdversarialOutput; costMicroUsd: number }> {
  const user = [
    "## Questions you must answer",
    ...ADVERSARIAL_QUESTIONS.map((q, i) => `${i + 1}. ${q}`),
    "",
    "## Evidence the artifact is allowed to rest on",
    args.packet ? renderPacket(args.packet) : "(no evidence packet supplied)",
    "",
    "## Artifact",
    args.artifact,
  ].join("\n");

  const run = await runAgent({
    agentVersion: ADVERSARIAL_AGENT_VERSION,
    model: modelForTask("adversarial_review"),
    system: ADVERSARIAL_SYSTEM,
    user,
    schema: adversarialOutputSchema,
    ...(args.caller ? { caller: args.caller } : {}),
  });
  return { output: run.output, costMicroUsd: run.costMicroUsd };
}

/** Issues that must block a consequential artifact from proceeding. */
export function blockingIssues(output: AdversarialOutput): AdversarialOutput["issues"] {
  return output.issues.filter((i) => i.severity === "high" || i.severity === "critical");
}

/**
 * Creator and verifier disagree when the creator was confident and the
 * verifier was not. Disagreement is an exception, never something the system
 * resolves for itself.
 */
export function isDisagreement(args: {
  creatorConfidence: number | null;
  verdict: VerifierOutput;
}): boolean {
  if (args.verdict.decision === "rejected") return true;
  if (args.verdict.decision === "human_review_required") return true;
  if (args.verdict.decision === "insufficient_evidence") return true;
  return (
    (args.creatorConfidence ?? 0) >= 0.9 &&
    args.verdict.decision === "approved_with_minor_corrections"
  );
}
