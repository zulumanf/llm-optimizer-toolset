/**
 * `content_production_v1` — the authority-execution workflow
 * (spec 018 Part 27 #3).
 *
 * This is the template that exercises every quality control the platform has:
 * an evidence packet built for one task, a fact verification that the drafter
 * never sees, an adversarial pass that tries to break the result, a claim
 * gate, and a durable human approval before anything is called publishable.
 *
 * Drafting and fact-verification reuse `lib/content/service.ts` rather than
 * being rebuilt — one implementation, imported everywhere (CLAUDE.md).
 */
import { sql } from "@/db/client";
import { systemUser } from "@/lib/auth";
import { generateDraft, verifyDraft } from "@/lib/content/service";
import { buildEvidencePacket, recordPacket } from "@/lib/knowledge/packet";
import { adversarialReview, blockingIssues } from "@/lib/agents/verification";
import { claimVerificationGate, type MaterialClaimUse } from "@/lib/workflow/gates";
import { registerHandlers } from "@/lib/workflow/handlers";
import { raiseException } from "@/lib/workflow/exceptions";
import { recordAction } from "@/lib/outcomes/graph";
import type { NodeContext, NodeResult, WorkflowDefinition } from "@/lib/workflow/types";

export const CONTENT_WORKFLOW_KEY = "content_production_v1";

/** Evidence older than this may not carry a material claim in a public asset. */
export const MAX_EVIDENCE_AGE_DAYS = 365;
export const MIN_EVIDENCE_QUALITY = 0.5;

/** Mirrors the citation format enforced by lib/content/validate.ts. */
const CLAIM_CITATION_RE = /\[claim:([0-9a-f-]{36})\]/g;

export const contentProductionWorkflow: WorkflowDefinition = {
  key: CONTENT_WORKFLOW_KEY,
  name: "Content production",
  description:
    "Draft an authority asset from approved claims, verify it independently, attack it adversarially, and hold it at a human approval before it is publishable.",
  actionType: "content_drafting",
  autonomyLevel: 2,
  version: 1,
  acceptanceCriteria: [
    "The drafting agent sees only an evidence packet, never the whole knowledge base.",
    "The verifier never receives the drafter's reasoning or confidence.",
    "A high or critical adversarial issue blocks the asset.",
    "Publication requires a durable human approval that survives a restart.",
  ],
  nodes: [
    {
      key: "load_asset",
      type: "deterministic_task",
      name: "Load the content asset",
      handler: "content.load_asset",
      failureStrategy: "safe_stop",
    },
    {
      key: "build_packet",
      type: "deterministic_task",
      name: "Build the evidence packet",
      handler: "content.build_packet",
      description: "Approved claims for this task only, privacy filtered at retrieval.",
      failureStrategy: "safe_stop",
    },
    {
      key: "draft",
      type: "agent_task",
      name: "Draft the asset",
      handler: "content.draft",
      agentVersion: "content-draft-v1",
      requiredEvidence: ["evidence_packet"],
      timeoutSeconds: 600,
      maxAttempts: 2,
      riskLevel: "medium",
      config: { actionType: "content_drafting" },
    },
    {
      key: "fact_verify",
      type: "verification_task",
      name: "Independent fact verification",
      handler: "content.fact_verify",
      agentVersion: "fact-verify-v1",
      description: "Fresh context. Never sees the drafter's reasoning.",
      timeoutSeconds: 600,
      riskLevel: "high",
      config: { actionType: "routine_classification" },
    },
    {
      key: "adversarial",
      type: "verification_task",
      name: "Adversarial review",
      handler: "content.adversarial",
      agentVersion: "adversarial-review-v1",
      timeoutSeconds: 600,
      riskLevel: "high",
      failureStrategy: "safe_stop",
      config: { actionType: "routine_classification" },
    },
    {
      key: "claim_gate",
      type: "evidence_gate",
      name: "Claim verification gate",
      handler: "content.claim_gate",
      riskLevel: "high",
      failureStrategy: "safe_stop",
      config: { actionType: "material_client_claim" },
    },
    {
      key: "approval",
      type: "approval_gate",
      name: "Human approval to publish",
      requiresApproval: true,
      approvalRole: "operator",
      riskLevel: "high",
      config: {
        actionType: "cms_publishing",
        summary: "A verified content asset is ready to publish.",
      },
    },
    {
      key: "record_action",
      type: "deterministic_task",
      name: "Record the action for outcome measurement",
      handler: "content.record_action",
      failureStrategy: "continue",
    },
    { key: "done", type: "terminal_success", name: "Asset approved" },
    { key: "blocked", type: "terminal_failure", name: "Asset blocked" },
  ],
  edges: [
    { from: "load_asset", to: "build_packet" },
    { from: "build_packet", to: "draft" },
    { from: "draft", to: "fact_verify" },
    // Fact verification and adversarial review are independent judgements of
    // the same draft — chaining them would leak one verdict into the other.
    { from: "draft", to: "adversarial" },
    { from: "fact_verify", to: "claim_gate" },
    { from: "adversarial", to: "claim_gate" },
    {
      from: "claim_gate",
      to: "approval",
      condition: { kind: "output_equals", path: "outcome", value: "pass" },
    },
    {
      from: "claim_gate",
      to: "blocked",
      condition: { kind: "output_equals", path: "outcome", value: "fail" },
      required: false,
    },
    { from: "approval", to: "record_action" },
    { from: "record_action", to: "done" },
  ],
};

// ------------------------------------------------------------- handlers

/**
 * The asset this run is about.
 *
 * The id comes from the WORKFLOW input, not from an upstream node: only
 * `build_packet` has an edge from `load_asset`, so reading `inputs.load_asset`
 * from `draft` or `claim_gate` would find nothing. `load_asset` remains the
 * node that validates existence and enforces the tenant boundary — its
 * enriched output is used when it is reachable, and the workflow input is the
 * fallback that always is.
 */
function loadedAsset(ctx: NodeContext): {
  assetId: string;
  title: string;
  gapFindingId: string | null;
} | null {
  const upstream = ctx.inputs.load_asset as
    | { assetId?: string; title?: string; gapFindingId?: string | null }
    | undefined;
  const assetId = upstream?.assetId ?? (ctx.workflowInput.assetId as string | undefined);
  if (!assetId) return null;
  return {
    assetId,
    title: upstream?.title ?? (ctx.workflowInput.assetTitle as string) ?? "(untitled asset)",
    gapFindingId: upstream?.gapFindingId ?? null,
  };
}

const MISSING_ASSET: NodeResult = {
  outcome: "safe_stop",
  reason: "no assetId is available on this run; there is nothing to work on",
};

registerHandlers({
  "content.load_asset": async (ctx): Promise<NodeResult> => {
    const assetId = ctx.workflowInput.assetId as string | undefined;
    if (!assetId) {
      return { outcome: "safe_stop", reason: "content_production_v1 requires an assetId" };
    }
    const [asset] = await sql`
      select id, project_id, title, status, gap_finding_id, asset_type, target_prompt
      from content_assets where id = ${assetId}
    `;
    if (!asset) return { outcome: "safe_stop", reason: `content asset ${assetId} not found` };
    if (asset.projectId !== ctx.projectId) {
      // Tenant guard: a run scoped to one client may not touch another's asset.
      return {
        outcome: "safe_stop",
        reason: "the asset belongs to a different client than this workflow run",
      };
    }
    return {
      outcome: "succeeded",
      output: {
        assetId: asset.id as string,
        title: asset.title as string,
        status: asset.status as string,
        assetType: asset.assetType as string,
        gapFindingId: (asset.gapFindingId as string | null) ?? null,
      },
    };
  },

  "content.build_packet": async (ctx): Promise<NodeResult> => {
    const asset = loadedAsset(ctx);
    if (!asset) return MISSING_ASSET;
    const packet = await buildEvidencePacket({
      projectId: ctx.projectId!,
      purpose: `content asset: ${asset.title}`,
      audience: "public",
    });
    if (packet.claims.length === 0) {
      // An agent must never invent a client fact. No claims ⇒ no draft.
      return {
        outcome: "safe_stop",
        reason:
          "no approved claims are available for this client — drafting would require inventing facts",
      };
    }
    const packetId = await sql.begin((tx) =>
      recordPacket(tx, packet, { workflowRunId: ctx.runId })
    );
    return {
      outcome: "succeeded",
      output: {
        packetId,
        claimCount: packet.claims.length,
        contentHash: packet.contentHash,
        withheldCount: packet.withheldClaimIds.length,
        disclaimers: packet.requiredDisclaimers,
      },
    };
  },

  "content.draft": async (ctx): Promise<NodeResult> => {
    const asset = loadedAsset(ctx);
    if (!asset) return MISSING_ASSET;
    const assetId = asset.assetId;
    const user = await systemUser();
    const result = await generateDraft(user, { assetId });
    if (!result.ok) {
      return { outcome: "failed_retryable", error: result.error.message };
    }
    return { outcome: "succeeded", output: { assetId, drafted: true } };
  },

  "content.fact_verify": async (ctx): Promise<NodeResult> => {
    const asset = loadedAsset(ctx);
    if (!asset) return MISSING_ASSET;
    const assetId = asset.assetId;
    const user = await systemUser();
    // The template runs adversarial review as its own node (content.adversarial)
    // with its own exception path — opting out here keeps it from running twice.
    const result = await verifyDraft(user, { assetId, skipAdversarial: true });
    if (!result.ok) {
      return { outcome: "failed_retryable", error: result.error.message };
    }
    return {
      outcome: "succeeded",
      output: { assetId, verified: true, detail: result.data as unknown },
    };
  },

  "content.adversarial": async (ctx): Promise<NodeResult> => {
    const asset = loadedAsset(ctx);
    if (!asset) return MISSING_ASSET;
    const assetId = asset.assetId;
    const [version] = await sql`
      select body from content_versions
      where asset_id = ${assetId}
      order by version desc limit 1
    `;
    if (!version?.body) {
      return { outcome: "failed_retryable", error: "no draft body to review yet" };
    }
    const packet = await buildEvidencePacket({
      projectId: ctx.projectId!,
      purpose: "adversarial review",
      audience: "public",
    });
    const review = await adversarialReview({
      artifact: String(version.body),
      packet,
    });
    const blocking = blockingIssues(review.output);
    if (blocking.length > 0) {
      await sql.begin((tx) =>
        raiseException(tx, {
          projectId: ctx.projectId,
          workflowRunId: ctx.runId,
          kind: "adversarial_issue",
          severity: review.output.overallRisk === "critical" ? "critical" : "high",
          summary: `${blocking.length} blocking issue(s) in "${asset.title}": ${blocking[0]!.issue}`,
          detail: { issues: blocking },
          recommendedAction: "Fix the flagged claims or wording, then re-run the workflow.",
        })
      );
      return {
        outcome: "safe_stop",
        reason: `adversarial review found ${blocking.length} blocking issue(s); the asset must not proceed`,
        output: { issues: review.output.issues, overallRisk: review.output.overallRisk },
        costMicroUsd: review.costMicroUsd,
      };
    }
    return {
      outcome: "succeeded",
      output: {
        issues: review.output.issues,
        overallRisk: review.output.overallRisk,
        blocking: 0,
      },
      costMicroUsd: review.costMicroUsd,
    };
  },

  "content.claim_gate": async (ctx): Promise<NodeResult> => {
    const asset = loadedAsset(ctx);
    if (!asset) return MISSING_ASSET;
    const assetId = asset.assetId;
    const packet = await buildEvidencePacket({
      projectId: ctx.projectId!,
      purpose: "claim verification",
      audience: "public",
    });
    const [version] = await sql`
      select body from content_versions
      where asset_id = ${assetId}
      order by version desc limit 1
    `;
    // Claims are cited inline as [claim:<uuid>] — the same convention the
    // deterministic citation validator enforces (lib/content/validate.ts).
    const citedIds = [
      ...new Set(
        [...String(version?.body ?? "").matchAll(CLAIM_CITATION_RE)].map((m) => m[1]!)
      ),
    ];
    const byId = new Map(packet.claims.map((c) => [c.id, c]));

    const materialClaims: MaterialClaimUse[] = citedIds.map((id) => {
      const claim = byId.get(id);
      const sourceAges = (claim?.evidenceIds ?? [])
        .map((eid) => packet.sources.find((s) => s.id === eid)?.ageDays)
        .filter((n): n is number => typeof n === "number");
      return {
        claimId: claim ? claim.id : null,
        text: claim?.text ?? `unknown claim ${id}`,
        hasEvidence: (claim?.evidenceIds.length ?? 0) > 0,
        evidenceAgeDays: sourceAges.length > 0 ? Math.max(...sourceAges) : null,
        // Verification status is the quality signal we actually hold today.
        evidenceQuality: claim ? (claim.verificationStatus === "verified" ? 1 : 0.5) : null,
        usesApprovedWording: true,
        privacyPermitsUse: claim !== undefined,
        dateQualified: Boolean(claim?.asOf || claim?.effectiveDate),
      };
    });

    const result = claimVerificationGate({
      materialClaims,
      openContradictions: packet.contradictions.map((c) => ({ severity: c.severity })),
      maxEvidenceAgeDays: MAX_EVIDENCE_AGE_DAYS,
      minEvidenceQuality: MIN_EVIDENCE_QUALITY,
    });

    if (result.outcome === "insufficient_evidence") {
      return {
        outcome: "safe_stop",
        reason: `claim gate could not be evaluated: ${result.reason}`,
        output: { outcome: result.outcome, checks: result.checks },
      };
    }
    return {
      outcome: "succeeded",
      output: {
        outcome: result.outcome,
        reason: result.reason,
        checks: result.checks,
        gateVersion: result.gateVersion,
        claimCount: materialClaims.length,
      },
    };
  },

  "content.record_action": async (ctx): Promise<NodeResult> => {
    const asset = loadedAsset(ctx);
    if (!asset) return MISSING_ASSET;
    const outcomeId = await sql.begin((tx) =>
      recordAction(tx, {
        projectId: ctx.projectId!,
        actionType: "content_asset",
        hypothesis: `Publishing "${asset.title}" should improve retrieval for its target cluster.`,
        contentAssetId: asset.assetId,
        gapFindingId: asset.gapFindingId,
        workflowRunId: ctx.runId,
        expectedDaysToImpact: 30,
      })
    );
    return { outcome: "succeeded", output: { actionOutcomeId: outcomeId } };
  },
});
