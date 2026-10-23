/**
 * Spec 147 — profile-correction domain nodes.
 *
 * `dom.fetch_public_profile` reads a public http(s) profile page through the
 * platform's one outbound-fetch policy (`safeFetch`: http(s) only, private and
 * link-local hosts refused, DNS-resolved addresses checked, every redirect hop
 * re-validated, size capped while streaming, bounded by a timeout). It needs
 * no connector: a third-party profile is not a WordPress site.
 *
 * Its output keeps the contract `dom.extract_canonical_claims` already reads
 * from `fetch_profile` — `{ ok, data: { url, reachable } }` — so canonical
 * extraction (Specs 145B–145E) is unchanged and still ingests the page itself
 * through `ingestSource(origin: "url_fetch")`. This node stores nothing; it is
 * the reachability gate. No `provider` is emitted, so the ingested artifact is
 * no longer labelled with an unrelated connector.
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  activeDestination,
  approvalForRunNode,
  claimRecheckRun,
  claimsInProject,
  closeCorrection,
  closeWithRecheckResult,
  insertRecheckResult,
  sourceArtifactInProject,
  correctionById,
  correctionForRun,
  destinationById,
  enqueueDraftDispatchJob,
  insertCorrectionRequest,
  insertRecheckRequest,
  loadCorrectionAuthority,
  lockCorrection,
  lockDraft,
  lockProfileDestination,
  markCorrectionSent,
  markDraftCreated,
  markDraftCreating,
  markDraftSent,
  nodeOutputsForRun,
  recordCorrectionDecision,
  setAwaitingSendConfirmation,
  setCorrectionRoute,
  setDraftStatus,
  type CorrectionRow,
  type DestinationRow,
  type DraftRow,
} from "@/db/profile-corrections";
import type { TransactionSql } from "@/db/client";
import { loadClientSubjectIdentity } from "@/lib/knowledge/entities/subject-identity";
import { ingestSource } from "@/lib/knowledge/sources/ingest";
import {
  classifyProfileRecheck as classifyRecheckItems,
  recheckResultHash,
} from "@/lib/profile-corrections/recheck";
import {
  correctionEmailHash,
  renderProfileCorrectionEmail,
  validateProfileCorrectionEmail,
  type CorrectionEmail,
} from "@/lib/profile-corrections/email";
import { draftConnection } from "@/lib/profile-corrections/gmail";
import { systemUser } from "@/lib/auth";
import { resolve } from "@/lib/automation/nodes/paths";
import { runModeFor } from "@/lib/automation/testmode";
import { ClassifiedError, type ErrorKind } from "@/lib/errors";
import { SOURCE_FETCH_TIMEOUT_MS, SOURCE_MAX_BYTES } from "@/lib/knowledge/constants";
import {
  approvalBindingError,
  externalApprovalBindingError,
  sendConfirmationBindingError,
} from "@/lib/profile-corrections/approval-binding";
import {
  contentApprovalError,
  routableDestinationSchema,
  routeCorrectionInTx,
} from "@/lib/profile-corrections/routing";
import {
  PROFILE_CORRECTION_CLOSE,
  PROFILE_CORRECTION_REQUEST_VERSION,
  PROFILE_CORRECTION_STATUS,
  PROFILE_DRAFT_STATUS,
  PROFILE_RECHECK_DAYS,
  PROFILE_RECHECK_WINDOW,
  RECHECK_PAGE_STATE,
  profileRecheckRunKey,
  type RecheckPageState,
} from "@/lib/profile-corrections/constants";
import {
  buildProfileCorrectionRequest,
  profileCorrectionRequestHash,
  profileCorrectionRequestSchema,
  referencedApprovedClaimIds,
  validateProfileCorrectionRequest,
  type CorrectionAuthority,
  type CorrectionContext,
} from "@/lib/profile-corrections/request";
import { safeFetch } from "@/lib/security/safe-fetch";
import type { NodeContext, NodeHandler, NodeResult } from "@/lib/workflow/types";

/** The processing status canonical extraction sets once it has run (spec 145B). */
const CLAIMS_PROPOSED_STATUS = "claims_proposed";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 1000;

/** Why the fetch produced no observed page (`ok: false`). */
export const PUBLIC_FETCH_REFUSAL = {
  noUrl: "no_url",
  policyRefused: "policy_refused",
} as const;

/**
 * Errors that mean "the page could not be reached" rather than "this target is
 * not allowed": network, DNS, redirect and timeout failures. A refusal by the
 * fetch policy (bad scheme, private host, size cap) is never "unreachable".
 */
const UNREACHABLE_ERROR_KINDS: readonly ErrorKind[] = ["timeout", "internal"];

export const fetchPublicProfile: NodeHandler = async (ctx): Promise<NodeResult> => {
  const mode = await runModeFor(ctx.runId);
  if (mode.mode === "test") {
    return {
      outcome: "safe_stop",
      reason: "a public profile fetch reaches a live third-party site; it does not run in test mode",
    };
  }

  const urlPath = typeof ctx.config.urlPath === "string" ? ctx.config.urlPath : "";
  const raw = urlPath.length > 0 ? await resolve(ctx, urlPath) : undefined;
  const url = typeof raw === "string" ? raw.trim() : "";
  if (url.length === 0) {
    // Never invent a URL (spec 145C): the run stops at canonical_extract.
    return {
      outcome: "succeeded",
      output: { ok: false, reason: PUBLIC_FETCH_REFUSAL.noUrl },
    };
  }

  try {
    const response = await safeFetch(url, {
      timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
      maxBytes: SOURCE_MAX_BYTES,
    });
    return {
      outcome: "succeeded",
      output: {
        ok: true,
        data: {
          url,
          finalUrl: response.finalUrl,
          status: response.status,
          reachable: response.ok,
        },
      },
    };
  } catch (err) {
    const classified =
      err instanceof ClassifiedError ? err : new ClassifiedError("internal", String(err));
    if (UNREACHABLE_ERROR_KINDS.includes(classified.kind)) {
      return {
        outcome: "succeeded",
        output: {
          ok: true,
          data: { url, finalUrl: null, status: null, reachable: false, error: classified.message },
        },
      };
    }
    return {
      outcome: "succeeded",
      output: {
        ok: false,
        reason: PUBLIC_FETCH_REFUSAL.policyRefused,
        error: classified.message,
        errorKind: classified.kind,
      },
    };
  }
};

// ------------------------------------------------- correction requests

/**
 * Every correction node pins the request version it was built for. A run on
 * an older graph version whose stored pin no longer matches the code stops
 * before doing any work (the same rule as Spec 146's guarded agent pin).
 */
function versionError(ctx: NodeContext): NodeResult | null {
  const pinned = ctx.config.requestVersion;
  if (pinned !== PROFILE_CORRECTION_REQUEST_VERSION) {
    return {
      outcome: "failed_terminal",
      error: `this node is pinned to correction request version "${String(pinned)}", but the current version is "${PROFILE_CORRECTION_REQUEST_VERSION}"; start a new run`,
    };
  }
  return null;
}

async function testModeRefusal(ctx: NodeContext, what: string): Promise<NodeResult | null> {
  const mode = await runModeFor(ctx.runId);
  return mode.mode === "test"
    ? { outcome: "safe_stop", reason: `${what} writes a client's correction record; it does not run in test mode` }
    : null;
}

function configPath(ctx: NodeContext, key: string): string {
  const value = ctx.config[key];
  return typeof value === "string" ? value : "";
}

/** The validated upstream outputs this run produced, resolved by config path. */
async function correctionContext(ctx: NodeContext, projectId: string): Promise<CorrectionContext> {
  const fetched = await resolve(ctx, configPath(ctx, "fetchPath"));
  const data =
    fetched !== null && typeof fetched === "object" && !Array.isArray(fetched)
      ? ((fetched as Record<string, unknown>).data as Record<string, unknown> | undefined)
      : undefined;
  return {
    projectId,
    workflowRunId: ctx.runId,
    profileUrl: data?.url,
    canonicalExtract: await resolve(ctx, configPath(ctx, "extractPath")),
    approvedFacts: await resolve(ctx, configPath(ctx, "approvedFactsPath")),
    compare: await resolve(ctx, configPath(ctx, "comparePath")),
  };
}

function sourceArtifactIdOf(context: CorrectionContext): string | null {
  const extract = context.canonicalExtract;
  if (extract === null || typeof extract !== "object") return null;
  const id = (extract as Record<string, unknown>).sourceArtifactId;
  return typeof id === "string" ? id : null;
}

async function authorityFor(context: CorrectionContext, request?: unknown): Promise<CorrectionAuthority> {
  return loadCorrectionAuthority(
    sql,
    referencedApprovedClaimIds(context.compare, request),
    sourceArtifactIdOf(context)
  );
}

function payloadId(ctx: NodeContext, key: string): string | null {
  const payload = ctx.workflowInput.payload;
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/** `dom.build_profile_correction` — the deterministic builder (spec 147 §5.4). */
export const buildProfileCorrection: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a correction request requires a client scope" };
  }
  const context = await correctionContext(ctx, ctx.projectId);
  const built = buildProfileCorrectionRequest(context, await authorityFor(context));
  if (!built.ok) {
    return {
      outcome: "safe_stop",
      reason: `no correction request was built: ${built.errors.join("; ")}`,
      output: { errors: built.errors },
    };
  }
  return {
    outcome: "succeeded",
    output: {
      requestVersion: PROFILE_CORRECTION_REQUEST_VERSION,
      request: built.request,
      requestSha256: built.requestSha256,
    },
  };
};

/**
 * `dom.verify_profile_correction` — the deterministic validator, then the
 * open-correction record. Nothing reaches the approval gate unless the
 * request is byte-identical to the deterministic build and the database still
 * agrees with every claim and evidence id it cites.
 */
export const verifyProfileCorrection: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a correction request requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "correction verification");
  if (refused) return refused;
  const projectId = ctx.projectId;

  const built = await resolve(ctx, configPath(ctx, "requestPath"));
  const candidate =
    built !== null && typeof built === "object" ? (built as Record<string, unknown>).request : undefined;
  const context = await correctionContext(ctx, projectId);
  const verdict = validateProfileCorrectionRequest(candidate, context, await authorityFor(context, candidate));
  if (!verdict.ok) {
    return {
      outcome: "safe_stop",
      reason: `the correction request failed deterministic validation: ${verdict.errors.join("; ")}`,
      output: { valid: false, errors: verdict.errors },
    };
  }
  const request = profileCorrectionRequestSchema.parse(candidate);
  const requestSha256 = profileCorrectionRequestHash(request);

  const user = await systemUser();
  const outcome = await sql.begin(async (tx) => {
    // A retried node finds its own row and continues; it never makes a second.
    const own = await correctionForRun(tx, ctx.runId, projectId);
    if (own) {
      return own.requestSha256 === requestSha256
        ? { created: own }
        : { conflict: `run ${ctx.runId} already recorded a different correction request` };
    }
    const result = await insertCorrectionRequest(tx, {
      projectId,
      workflowRunId: ctx.runId,
      checkRequestId: payloadId(ctx, "checkRequestId"),
      contextItemId: payloadId(ctx, "contextItemId"),
      profileUrl: request.profileUrl,
      requestVersion: request.version,
      request: request as unknown as Record<string, unknown>,
      requestSha256,
      beforeSourceArtifactId: request.beforeSourceArtifactId,
      beforeSha256: request.beforeSha256,
      evidencePacketId: request.evidencePacketId,
      itemCount: request.items.length,
      maxSeverity: request.maxSeverity,
      createdBy: user.id,
    });
    if ("created" in result) {
      await writeAudit(tx, {
        userId: user.id,
        action: `profile_correction.${PROFILE_CORRECTION_STATUS.awaitingApproval}`,
        entity: "profile_correction_request",
        entityId: result.created.id,
        projectId,
        detail: { workflowRunId: ctx.runId, requestSha256, items: request.items.length },
      });
    }
    return result;
  });

  if ("conflict" in outcome) {
    return { outcome: "failed_terminal", error: outcome.conflict };
  }
  if ("existing" in outcome) {
    const existing = outcome.existing;
    return {
      outcome: "safe_stop",
      reason: `an open correction request already exists for this profile (request ${existing.id}, run ${existing.workflowRunId}, status ${existing.status}); no second request is created`,
      output: {
        valid: true,
        duplicateOf: { correctionRequestId: existing.id, workflowRunId: existing.workflowRunId, status: existing.status },
      },
    };
  }
  return {
    outcome: "succeeded",
    output: {
      valid: true,
      correctionRequestId: outcome.created.id,
      requestVersion: request.version,
      requestSha256,
      request,
    },
  };
};

/**
 * `dom.record_profile_correction_approval` — runs after the human gate. It
 * binds the decision to the exact request hash the human saw, re-proves the
 * request against the database (facts may have changed while it waited), and
 * only then marks it approved. Nothing external happens here or before it.
 */
export const recordProfileCorrectionApproval: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a correction request requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "correction approval");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const approvalNode = configPath(ctx, "approvalNode");

  const row = await correctionForRun(sql, ctx.runId, projectId);
  if (!row) return { outcome: "failed_terminal", error: "this run recorded no correction request" };
  if (row.status !== PROFILE_CORRECTION_STATUS.awaitingApproval) {
    return {
      outcome: "failed_terminal",
      error: `correction request ${row.id} is ${row.status}, not awaiting approval; the approval does not apply`,
    };
  }
  const approval = await approvalForRunNode(sql, ctx.runId, approvalNode);
  if (!approval || approval.decision !== "approved") {
    return { outcome: "failed_terminal", error: "no approved decision exists for this correction request" };
  }

  const binding = approvalBindingError(approval.detail, row.requestSha256);
  if (binding) return { outcome: "failed_terminal", error: binding };

  // Re-prove the stored request against this run's validated outputs and the
  // database as it is NOW. A fact unapproved or re-evidenced while the request
  // waited fails closed and frees the profile for a fresh check.
  const context = await correctionContext(ctx, projectId);
  const verdict = validateProfileCorrectionRequest(row.request, context, await authorityFor(context, row.request));
  if (!verdict.ok) {
    await sql.begin(async (tx) => {
      const closed = await closeCorrection(tx, row.id, {
        fromStatuses: [PROFILE_CORRECTION_STATUS.awaitingApproval],
        to: PROFILE_CORRECTION_STATUS.expired,
        closedBy: null,
        reason: `${PROFILE_CORRECTION_CLOSE.factsChanged}: ${verdict.errors.join("; ")}`.slice(0, MAX_REASON_LENGTH),
      });
      if (closed) {
        await writeAudit(tx, {
          userId: null,
          action: `profile_correction.${PROFILE_CORRECTION_STATUS.expired}`,
          entity: "profile_correction_request",
          entityId: row.id,
          projectId,
          detail: { errors: verdict.errors },
        });
      }
    });
    return {
      outcome: "failed_terminal",
      error: `the approved request no longer validates; it was closed as expired: ${verdict.errors.join("; ")}`,
    };
  }

  const moved = await sql.begin(async (tx) => {
    const ok = await recordCorrectionDecision(tx, row.id, {
      from: PROFILE_CORRECTION_STATUS.awaitingApproval,
      to: PROFILE_CORRECTION_STATUS.approved,
      approvalId: approval.id,
      decidedBy: approval.decidedBy,
      decidedAt: approval.decidedAt ?? new Date(),
      rationale: approval.rationale,
    });
    if (ok) {
      await writeAudit(tx, {
        userId: approval.decidedBy,
        action: `profile_correction.${PROFILE_CORRECTION_STATUS.approved}`,
        entity: "profile_correction_request",
        entityId: row.id,
        projectId,
        detail: { approvalId: approval.id, requestSha256: row.requestSha256 },
      });
    }
    return ok;
  });
  if (!moved) {
    return { outcome: "failed_terminal", error: `correction request ${row.id} changed state while being approved` };
  }
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId: row.id,
      status: PROFILE_CORRECTION_STATUS.approved,
      approvalId: approval.id,
      requestSha256: row.requestSha256,
    },
  };
};

// -------------------------------------------------------------- routing

/**
 * `dom.route_profile_correction` — after the approval is recorded, send the
 * request to its destination state (spec 147 §7.2). No destination is a valid
 * outcome: the request waits as `destination_required` and the run completes.
 */
export const routeProfileCorrection: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a correction request requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "correction routing");
  if (refused) return refused;
  const projectId = ctx.projectId;

  const own = await correctionForRun(sql, ctx.runId, projectId);
  if (!own) return { outcome: "failed_terminal", error: "this run recorded no correction request" };

  const result = await sql.begin(async (tx) => {
    await lockProfileDestination(tx, projectId, own.profileUrl);
    const row = await lockCorrection(tx, own.id, projectId);
    if (!row) return { ok: false as const, correctionRequestId: own.id, error: "the correction request is gone" };
    if (row.status !== PROFILE_CORRECTION_STATUS.approved) {
      return {
        ok: false as const,
        correctionRequestId: row.id,
        error: `correction request ${row.id} is ${row.status}, not approved; it cannot be routed`,
      };
    }
    return routeCorrectionInTx(tx, row, null);
  });

  if (!result.ok) return { outcome: "failed_terminal", error: result.error };
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId: result.correctionRequestId,
      status: result.status,
      destinationId: result.destinationId,
      destinationKind: result.destinationKind,
      externalApprovalEventId: result.eventId,
    },
  };
};

/**
 * `dom.load_external_submission` — the authorization workflow's first step:
 * the request must still be waiting for THIS publisher destination, which must
 * still be active. What it outputs is exactly what the human approves.
 */
export const loadExternalSubmission: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "an external submission requires a client scope" };
  }
  const correctionRequestId = payloadId(ctx, "correctionRequestId");
  const destinationId = payloadId(ctx, "destinationId");
  if (!correctionRequestId || !destinationId) {
    return { outcome: "failed_terminal", error: "the event names no correction request or destination" };
  }
  const row = await correctionById(sql, correctionRequestId);
  if (!row || row.projectId !== ctx.projectId) {
    return { outcome: "failed_terminal", error: "the correction request is not in this client's scope" };
  }
  const stale = externalSubmissionStateError(row, destinationId);
  if (stale) return { outcome: "failed_terminal", error: stale };
  const destination = await destinationById(sql, destinationId);
  if (!destination || destination.projectId !== ctx.projectId || destination.archivedAt !== null) {
    return { outcome: "failed_terminal", error: "the publisher destination is no longer active" };
  }
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId: row.id,
      requestVersion: row.requestVersion,
      requestSha256: row.requestSha256,
      request: row.request,
      destination: {
        id: destination.id,
        kind: destination.kind,
        recipientName: destination.recipientName,
        email: destination.email,
        basis: destination.basis,
        sourceUrl: destination.sourceUrl,
      },
    },
  };
};

function externalSubmissionStateError(row: CorrectionRow, destinationId: string): string | null {
  if (row.status !== PROFILE_CORRECTION_STATUS.awaitingExternalApproval) {
    return `correction request ${row.id} is ${row.status}, not awaiting external-submission approval`;
  }
  if (row.destinationId !== destinationId) {
    return `correction request ${row.id} is now routed to another destination`;
  }
  if (profileCorrectionRequestHash(row.request) !== row.requestSha256) {
    return "the stored request no longer hashes to its recorded hash";
  }
  return null;
}

/**
 * `dom.record_external_submission_approval` — binds the external-submission
 * decision to the request hash and the destination shown, and only then marks
 * the request ready to draft. Nothing is drafted or sent here.
 */
export const recordExternalSubmissionApproval: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "an external submission requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "external-submission approval");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const correctionRequestId = payloadId(ctx, "correctionRequestId");
  const destinationId = payloadId(ctx, "destinationId");
  if (!correctionRequestId || !destinationId) {
    return { outcome: "failed_terminal", error: "the event names no correction request or destination" };
  }
  const approval = await approvalForRunNode(sql, ctx.runId, configPath(ctx, "approvalNode"));
  if (!approval || approval.decision !== "approved") {
    return { outcome: "failed_terminal", error: "no approved external-submission decision exists" };
  }

  const result = await sql.begin(async (tx) => {
    const peek = await correctionById(tx, correctionRequestId);
    if (!peek || peek.projectId !== projectId) return "the correction request is not in this client's scope";
    await lockProfileDestination(tx, projectId, peek.profileUrl);
    const row = await lockCorrection(tx, correctionRequestId, projectId);
    if (!row) return "the correction request is gone";
    const stale = externalSubmissionStateError(row, destinationId);
    if (stale) return stale;
    const binding = externalApprovalBindingError(approval.detail, row.requestSha256, row.destinationId);
    if (binding) return binding;
    const active = await activeDestination(tx, projectId, row.profileUrl, { lock: true });
    if (!active || active.id !== destinationId) return "the publisher destination is no longer the active one";
    const moved = await setCorrectionRoute(tx, row.id, {
      from: PROFILE_CORRECTION_STATUS.awaitingExternalApproval,
      to: PROFILE_CORRECTION_STATUS.readyToDraft,
      destinationId,
    });
    if (!moved) return "the correction request changed state while being approved";
    await enqueueDraftDispatchJob(tx);
    await writeAudit(tx, {
      userId: approval.decidedBy,
      action: `profile_correction.${PROFILE_CORRECTION_STATUS.readyToDraft}`,
      entity: "profile_correction_request",
      entityId: row.id,
      projectId,
      detail: { externalApprovalId: approval.id, destinationId, requestSha256: row.requestSha256 },
    });
    return null;
  });
  if (result) return { outcome: "failed_terminal", error: result };
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId,
      status: PROFILE_CORRECTION_STATUS.readyToDraft,
      destinationId,
      externalApprovalId: approval.id,
    },
  };
};

// ------------------------------------------------------------- drafting

/** The original check run's node keys a request was built from. */
const ORIGINAL_RUN_NODES = {
  fetch: "fetch_profile",
  extract: "canonical_extract",
  approvedFacts: "approved_facts",
  compare: "compare",
} as const;

/**
 * Re-prove a stored request from its own check run's recorded outputs and the
 * database as it is now (spec 147 §7.4): facts unapproved or re-evidenced
 * since approval fail closed.
 */
async function revalidateStoredRequest(tx: TransactionSql, row: CorrectionRow): Promise<string[]> {
  const outputs = await nodeOutputsForRun(tx, row.workflowRunId, Object.values(ORIGINAL_RUN_NODES));
  const fetched = outputs[ORIGINAL_RUN_NODES.fetch] as { data?: { url?: unknown } } | undefined;
  const context: CorrectionContext = {
    projectId: row.projectId,
    workflowRunId: row.workflowRunId,
    profileUrl: fetched?.data?.url,
    canonicalExtract: outputs[ORIGINAL_RUN_NODES.extract],
    approvedFacts: outputs[ORIGINAL_RUN_NODES.approvedFacts],
    compare: outputs[ORIGINAL_RUN_NODES.compare],
  };
  const authority = await loadCorrectionAuthority(
    tx,
    referencedApprovedClaimIds(context.compare, row.request),
    sourceArtifactIdOf(context)
  );
  const verdict = validateProfileCorrectionRequest(row.request, context, authority);
  return verdict.ok ? [] : verdict.errors;
}

async function clientSubjectName(projectId: string): Promise<string> {
  const lookup = await loadClientSubjectIdentity(projectId);
  return lookup.status === "resolved" ? lookup.identity.name : "";
}

function gmailSearchHint(to: string, subject: string): string {
  return `in:drafts to:${to} subject:"${subject}"`;
}

/**
 * `dom.prepare_profile_correction_draft` — every precondition for ONE Gmail
 * draft, checked under the profile's lock: the attempt is the active one, the
 * request is still ready, its hash and approval still bind, the destination
 * is the active one, the facts still validate, Gmail can create the draft,
 * and the deterministic email validates. Only then is the attempt marked
 * `creating` with the exact email; its output is exactly what Gmail receives.
 */
export const prepareProfileCorrectionDraft: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a correction draft requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "correction drafting");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const correctionRequestId = payloadId(ctx, "correctionRequestId");
  const destinationId = payloadId(ctx, "destinationId");
  const draftAttemptId = payloadId(ctx, "draftAttemptId");
  if (!correctionRequestId || !destinationId || !draftAttemptId) {
    return { outcome: "failed_terminal", error: "the event names no correction request, destination or draft attempt" };
  }
  const peek = await correctionById(sql, correctionRequestId);
  if (!peek || peek.projectId !== projectId) {
    return { outcome: "failed_terminal", error: "the correction request is not in this client's scope" };
  }
  const subjectName = await clientSubjectName(projectId);
  const gmail = await draftConnection(projectId);

  type Prepared = { ok: true; email: CorrectionEmail } | { ok: false; terminal: boolean; reason: string };
  const result: Prepared = await sql.begin(async (tx): Promise<Prepared> => {
    await lockProfileDestination(tx, projectId, peek.profileUrl);
    const row = await lockCorrection(tx, correctionRequestId, projectId);
    const draft = await lockDraft(tx, draftAttemptId, projectId);
    if (!row || !draft || draft.correctionRequestId !== row.id) {
      return { ok: false, terminal: true, reason: "the draft attempt does not belong to this correction request" };
    }
    if (draft.status !== PROFILE_DRAFT_STATUS.pending) {
      return { ok: false, terminal: true, reason: `draft attempt ${draft.id} is ${draft.status}, not pending` };
    }
    const failAttempt = async (reason: string): Promise<Prepared> => {
      await setDraftStatus(tx, draft.id, { from: [PROFILE_DRAFT_STATUS.pending], to: PROFILE_DRAFT_STATUS.failed, reason });
      return { ok: false, terminal: false, reason };
    };
    if (row.status !== PROFILE_CORRECTION_STATUS.readyToDraft) {
      return failAttempt(`the correction request is ${row.status}, not ready to draft`);
    }
    if (row.destinationId !== destinationId || draft.destinationId !== destinationId) {
      return failAttempt("the correction request is now routed to another destination");
    }
    if (draft.requestSha256 !== row.requestSha256) return failAttempt("the request hash changed since this attempt started");
    const notApproved = await contentApprovalError(tx, row);
    if (notApproved) return failAttempt(notApproved);

    const active = await activeDestination(tx, projectId, row.profileUrl, { lock: true });
    const destination = active ? routableDestinationSchema.safeParse(active) : null;
    if (!active || active.id !== destinationId || !destination?.success) {
      return failAttempt("the destination is no longer the active, routable destination for this profile");
    }

    const stale = await revalidateStoredRequest(tx, row);
    if (stale.length > 0) {
      const reason = `${PROFILE_CORRECTION_CLOSE.factsChanged}: ${stale.join("; ")}`.slice(0, MAX_REASON_LENGTH);
      await closeCorrection(tx, row.id, {
        fromStatuses: [PROFILE_CORRECTION_STATUS.readyToDraft],
        to: PROFILE_CORRECTION_STATUS.expired,
        closedBy: null,
        reason,
      });
      await writeAudit(tx, {
        userId: null,
        action: `profile_correction.${PROFILE_CORRECTION_STATUS.expired}`,
        entity: "profile_correction_request",
        entityId: row.id,
        projectId,
        detail: { errors: stale, draftAttemptId: draft.id },
      });
      return failAttempt(reason);
    }

    if (!gmail.ok) return failAttempt(gmail.reason);

    const input = {
      request: profileCorrectionRequestSchema.parse(row.request),
      requestSha256: row.requestSha256,
      destination: {
        id: active.id,
        kind: destination.data.kind,
        recipientName: active.recipientName,
        email: active.email,
      },
      subjectName,
    };
    const rendered = renderProfileCorrectionEmail(input);
    if (!rendered.ok) return failAttempt(`the email could not be rendered: ${rendered.errors.join("; ")}`);
    const valid = validateProfileCorrectionEmail(rendered.email, input);
    if (!valid.ok) return failAttempt(`the email did not validate: ${valid.errors.join("; ")}`);

    const marked = await markDraftCreating(tx, draft.id, {
      workflowRunId: ctx.runId,
      emailVersion: rendered.email.templateVersion,
      email: rendered.email as unknown as Record<string, unknown>,
      emailSha256: correctionEmailHash(rendered.email),
      fromAddress: gmail.fromAddress,
      connectionId: gmail.connectionId,
    });
    if (!marked) return { ok: false, terminal: true, reason: "the draft attempt changed state while being prepared" };
    return { ok: true, email: rendered.email };
  });

  if (!result.ok) {
    return result.terminal
      ? { outcome: "failed_terminal", error: result.reason }
      : { outcome: "safe_stop", reason: `no Gmail draft was created: ${result.reason}`, output: { prepared: false, reason: result.reason } };
  }
  // Exactly the capability input: the Gmail adapter adds From from the connection.
  return {
    outcome: "succeeded",
    output: { to: result.email.to, subject: result.email.subject, body: result.email.body },
  };
};

/**
 * `dom.record_profile_correction_draft` — records the Gmail draft ids and
 * moves the request to `awaiting_send_confirmation`. A draft created for a
 * request that moved on meanwhile is recorded as `orphaned` (with its ids, so
 * an operator can delete it) and never confirmed.
 */
export const recordProfileCorrectionDraft: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a correction draft requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "correction drafting");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const correctionRequestId = payloadId(ctx, "correctionRequestId");
  const draftAttemptId = payloadId(ctx, "draftAttemptId");
  if (!correctionRequestId || !draftAttemptId) {
    return { outcome: "failed_terminal", error: "the event names no correction request or draft attempt" };
  }
  const submitted = await resolve(ctx, configPath(ctx, "submitPath"));
  const s = (submitted ?? {}) as { ok?: unknown; data?: { draftId?: unknown; messageId?: unknown; threadId?: unknown } };
  const gmailDraftId = typeof s.data?.draftId === "string" ? s.data.draftId : "";
  if (s.ok !== true || gmailDraftId.length === 0) {
    return { outcome: "failed_terminal", error: "Gmail reported no draft id; nothing was recorded" };
  }
  const gmailMessageId = typeof s.data?.messageId === "string" ? s.data.messageId : null;
  const gmailThreadId = typeof s.data?.threadId === "string" ? s.data.threadId : null;

  const peek = await correctionById(sql, correctionRequestId);
  if (!peek || peek.projectId !== projectId) {
    return { outcome: "failed_terminal", error: "the correction request is not in this client's scope" };
  }
  type Recorded =
    | { ok: true; row: CorrectionRow; draft: DraftRow; destination: DestinationRow }
    | { ok: false; reason: string };
  const result = await sql.begin(async (tx): Promise<Recorded> => {
    await lockProfileDestination(tx, projectId, peek.profileUrl);
    const row = await lockCorrection(tx, correctionRequestId, projectId);
    const draft = await lockDraft(tx, draftAttemptId, projectId);
    if (!row || !draft || draft.correctionRequestId !== row.id || draft.status !== PROFILE_DRAFT_STATUS.creating) {
      return { ok: false, reason: "the draft attempt is not the one being created for this request" };
    }
    const active = await activeDestination(tx, projectId, row.profileUrl, { lock: true });
    const moved =
      row.status !== PROFILE_CORRECTION_STATUS.readyToDraft ||
      row.destinationId !== draft.destinationId ||
      !active ||
      active.id !== draft.destinationId;
    if (moved) {
      const reason = `the request moved on while Gmail draft ${gmailDraftId} was being created; delete that draft in Gmail`;
      await markDraftCreated(tx, draft.id, {
        status: PROFILE_DRAFT_STATUS.orphaned,
        gmailDraftId,
        gmailMessageId,
        gmailThreadId,
        reason,
      });
      return { ok: false, reason };
    }
    await markDraftCreated(tx, draft.id, {
      status: PROFILE_DRAFT_STATUS.created,
      gmailDraftId,
      gmailMessageId,
      gmailThreadId,
    });
    const advanced = await setAwaitingSendConfirmation(tx, row.id, draft.id);
    if (!advanced) return { ok: false, reason: "the correction request changed state while the draft was recorded" };
    await writeAudit(tx, {
      userId: null,
      action: `profile_correction.${PROFILE_CORRECTION_STATUS.awaitingSendConfirmation}`,
      entity: "profile_correction_request",
      entityId: row.id,
      projectId,
      detail: { draftAttemptId: draft.id, gmailDraftId, destinationId: draft.destinationId },
    });
    const fresh = (await lockDraft(tx, draft.id, projectId))!;
    return { ok: true, row, draft: fresh, destination: active };
  });
  if (!result.ok) return { outcome: "failed_terminal", error: result.reason };

  const email = result.draft.email!;
  const request = profileCorrectionRequestSchema.parse(result.row.request);
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId: result.row.id,
      requestVersion: result.row.requestVersion,
      requestSha256: result.row.requestSha256,
      destinationId: result.destination.id,
      destination: {
        kind: result.destination.kind,
        recipientName: result.destination.recipientName,
        email: result.destination.email,
      },
      draftAttemptId: result.draft.id,
      gmailDraftId,
      gmailMessageId,
      gmailThreadId,
      from: result.draft.fromAddress,
      to: email.to,
      subject: email.subject,
      body: email.body,
      gmailSearch: gmailSearchHint(email.to, email.subject),
      evidenceIds: request.evidenceIds,
      sent: false,
    },
  };
};

/**
 * `dom.record_profile_correction_sent` — after a human confirms they sent
 * exactly this draft. Binds the confirmation to the request, hash,
 * destination and Gmail draft; marks the request sent once; and queues
 * exactly one recheck 14 days later. Repeating it is a no-op.
 */
export const recordProfileCorrectionSent: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a correction requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "send confirmation");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const correctionRequestId = payloadId(ctx, "correctionRequestId");
  const draftAttemptId = payloadId(ctx, "draftAttemptId");
  if (!correctionRequestId || !draftAttemptId) {
    return { outcome: "failed_terminal", error: "the event names no correction request or draft attempt" };
  }
  const approval = await approvalForRunNode(sql, ctx.runId, configPath(ctx, "approvalNode"));
  if (!approval || approval.decision !== "approved") {
    return { outcome: "failed_terminal", error: "no human confirmed that this draft was sent" };
  }
  const peek = await correctionById(sql, correctionRequestId);
  if (!peek || peek.projectId !== projectId) {
    return { outcome: "failed_terminal", error: "the correction request is not in this client's scope" };
  }

  type Sent =
    | { ok: true; alreadySent: boolean; sentAt: Date; recheckDueAt: Date; recheckQueued: boolean }
    | { ok: false; reason: string };
  const result = await sql.begin(async (tx): Promise<Sent> => {
    await lockProfileDestination(tx, projectId, peek.profileUrl);
    const row = await lockCorrection(tx, correctionRequestId, projectId);
    const draft = await lockDraft(tx, draftAttemptId, projectId);
    if (!row || !draft || draft.correctionRequestId !== row.id) {
      return { ok: false, reason: "the draft attempt does not belong to this correction request" };
    }
    const binding = sendConfirmationBindingError(approval.detail, {
      correctionRequestId: row.id,
      requestSha256: row.requestSha256,
      destinationId: draft.destinationId,
      draftAttemptId: draft.id,
      gmailDraftId: draft.gmailDraftId,
    });
    if (binding) return { ok: false, reason: binding };

    if (row.status === PROFILE_CORRECTION_STATUS.sent && row.sentDraftId === draft.id && row.sentAt && row.recheckDueAt) {
      return { ok: true, alreadySent: true, sentAt: row.sentAt, recheckDueAt: row.recheckDueAt, recheckQueued: false };
    }
    if (row.status !== PROFILE_CORRECTION_STATUS.awaitingSendConfirmation || row.activeDraftId !== draft.id) {
      return { ok: false, reason: `the correction request is ${row.status}; this draft is not awaiting confirmation` };
    }
    if (draft.status !== PROFILE_DRAFT_STATUS.created) {
      return { ok: false, reason: `draft attempt ${draft.id} is ${draft.status}, not created` };
    }
    if (profileCorrectionRequestHash(row.request) !== row.requestSha256 || draft.requestSha256 !== row.requestSha256) {
      return { ok: false, reason: "the request no longer matches the hash the draft was made from" };
    }
    const active = await activeDestination(tx, projectId, row.profileUrl, { lock: true });
    if (!active || active.id !== draft.destinationId || row.destinationId !== draft.destinationId) {
      return { ok: false, reason: "the destination this draft was addressed to is no longer the active one" };
    }

    const sent = await markCorrectionSent(tx, row.id, {
      draftId: draft.id,
      confirmedBy: approval.decidedBy,
      approvalId: approval.id,
      recheckDays: PROFILE_RECHECK_DAYS,
    });
    if (!sent) return { ok: false, reason: "the correction request changed state while being confirmed" };
    await markDraftSent(tx, draft.id, { confirmedBy: approval.decidedBy, approvalId: approval.id });
    const recheckQueued = await insertRecheckRequest(tx, {
      projectId,
      correctionRequestId: row.id,
      contextItemId: row.contextItemId,
      profileUrl: row.profileUrl,
      notBefore: sent.recheckDueAt,
      windowKey: PROFILE_RECHECK_WINDOW,
      runIdempotencyKey: profileRecheckRunKey(row.id),
      requestedBy: approval.decidedBy,
    });
    await writeAudit(tx, {
      userId: approval.decidedBy,
      action: `profile_correction.${PROFILE_CORRECTION_STATUS.sent}`,
      entity: "profile_correction_request",
      entityId: row.id,
      projectId,
      detail: {
        draftAttemptId: draft.id,
        gmailDraftId: draft.gmailDraftId,
        destinationId: draft.destinationId,
        confirmationApprovalId: approval.id,
        recheckDueAt: sent.recheckDueAt.toISOString(),
      },
    });
    return { ok: true, alreadySent: false, ...sent, recheckQueued };
  });

  if (!result.ok) return { outcome: "failed_terminal", error: result.reason };
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId,
      status: PROFILE_CORRECTION_STATUS.sent,
      sentAt: result.sentAt.toISOString(),
      recheckDueAt: result.recheckDueAt.toISOString(),
      alreadySent: result.alreadySent,
      recheckQueued: result.recheckQueued,
    },
  };
};

// ---------------------------------------------------------------- recheck

/**
 * `dom.load_profile_correction_recheck` — the recheck's first step: the sent,
 * immutable correction this run belongs to. Its tenant, status, profile URL,
 * hash, version, before-page artifact and approved claims must all still
 * resolve; the run is bound to the correction once.
 */
export const loadProfileCorrectionRecheck: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a recheck requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "a correction recheck");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const correctionRequestId = payloadId(ctx, "correctionRequestId");
  const checkRequestId = payloadId(ctx, "checkRequestId");
  const payload = (ctx.workflowInput.payload ?? {}) as Record<string, unknown>;
  if (!correctionRequestId) return { outcome: "failed_terminal", error: "the event names no correction request" };

  const row = await correctionById(sql, correctionRequestId);
  if (!row || row.projectId !== projectId) {
    return { outcome: "failed_terminal", error: "the correction request is not in this client's scope" };
  }
  if (row.status !== PROFILE_CORRECTION_STATUS.sent) {
    return { outcome: "failed_terminal", error: `correction request ${row.id} is ${row.status}, not sent` };
  }
  if (payload.profileUrl !== row.profileUrl) {
    return { outcome: "failed_terminal", error: "the recheck names a different profile URL from the sent correction" };
  }
  if (row.requestVersion !== PROFILE_CORRECTION_REQUEST_VERSION) {
    return { outcome: "failed_terminal", error: `correction request ${row.id} is version ${row.requestVersion}` };
  }
  if (profileCorrectionRequestHash(row.request) !== row.requestSha256) {
    return { outcome: "failed_terminal", error: "the stored request no longer hashes to its recorded hash" };
  }
  const before = await sourceArtifactInProject(sql, projectId, row.beforeSourceArtifactId);
  if (!before || before.sha256 !== row.beforeSha256) {
    return { outcome: "failed_terminal", error: "the before-page evidence no longer resolves" };
  }
  const request = profileCorrectionRequestSchema.parse(row.request);
  const claimIds = request.items.map((i) => i.approvedClaimId);
  const present = await claimsInProject(sql, projectId, claimIds);
  if (claimIds.some((id) => !present.has(id))) {
    return { outcome: "failed_terminal", error: "an approved claim the correction cites no longer resolves" };
  }
  const bound = await sql.begin((tx) => claimRecheckRun(tx, row.id, ctx.runId));
  if (!bound) {
    return { outcome: "failed_terminal", error: `correction request ${row.id} is already being rechecked by another run` };
  }
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId: row.id,
      checkRequestId,
      profileUrl: row.profileUrl,
      requestVersion: row.requestVersion,
      requestSha256: row.requestSha256,
      request,
      beforeSourceArtifactId: row.beforeSourceArtifactId,
      beforeSha256: row.beforeSha256,
    },
  };
};

/**
 * `dom.precheck_profile_recheck` — how the re-fetched page relates to the
 * before-page evidence, using the existing source-artifact store (content
 * hash per project). Only `changed` proceeds to the model.
 */
export const precheckProfileRecheck: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a recheck requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "a correction recheck");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const loaded = (await resolve(ctx, configPath(ctx, "requestPath"))) as
    | { profileUrl?: string; beforeSourceArtifactId?: string }
    | undefined;
  const fetched = (await resolve(ctx, configPath(ctx, "fetchPath"))) as
    | { ok?: boolean; reason?: string; data?: { url?: string; reachable?: boolean; status?: number | null } }
    | undefined;
  if (!loaded?.profileUrl || !loaded.beforeSourceArtifactId) {
    return { outcome: "failed_terminal", error: "the recheck has no loaded correction" };
  }
  if (!fetched || fetched.ok !== true) {
    // A refused or URL-less fetch is not "unreachable": it is a failure.
    return { outcome: "failed_terminal", error: `the profile fetch was refused: ${fetched?.reason ?? "no fetch output"}` };
  }
  const httpStatus = typeof fetched.data?.status === "number" ? fetched.data.status : null;
  if (fetched.data?.reachable !== true) {
    return {
      outcome: "succeeded",
      output: { result: RECHECK_PAGE_STATE.unreachable, proceedToCompare: false, httpStatus, afterSourceArtifactId: null },
    };
  }

  const ingested = await ingestSource(await systemUser(), {
    projectId,
    url: loaded.profileUrl,
    origin: "url_fetch",
    sourceType: "website",
    privacy: "public",
    workflowRunId: ctx.runId,
  });
  if (!ingested.ok) {
    return { outcome: "failed_terminal", error: `the re-fetched page could not be stored: ${ingested.error.message}` };
  }
  const artifact = ingested.data;
  let result: RecheckPageState = RECHECK_PAGE_STATE.changed;
  if (artifact.duplicate) {
    if (artifact.sourceArtifactId === loaded.beforeSourceArtifactId) {
      result = RECHECK_PAGE_STATE.unchanged;
    } else {
      const known = await sourceArtifactInProject(sql, projectId, artifact.sourceArtifactId);
      // canonical_extract would refuse to re-extract it: no safe determination.
      if (known?.processingStatus === CLAIMS_PROPOSED_STATUS) result = RECHECK_PAGE_STATE.previouslySeen;
    }
  }
  return {
    outcome: "succeeded",
    output: {
      result,
      proceedToCompare: result === RECHECK_PAGE_STATE.changed,
      httpStatus,
      afterSourceArtifactId: artifact.sourceArtifactId,
      afterSha256: artifact.sha256,
    },
  };
};

/**
 * `dom.classify_profile_recheck` — the deterministic classification of every
 * original item, recorded once as an immutable, hashed result; the sent
 * correction's lifecycle moves to the result. Nothing external happens.
 */
export const classifyProfileRecheck: NodeHandler = async (ctx): Promise<NodeResult> => {
  const pinned = versionError(ctx);
  if (pinned) return pinned;
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a recheck requires a client scope" };
  }
  const refused = await testModeRefusal(ctx, "a correction recheck");
  if (refused) return refused;
  const projectId = ctx.projectId;
  const loaded = (await resolve(ctx, configPath(ctx, "requestPath"))) as
    | {
        correctionRequestId: string;
        checkRequestId: string | null;
        profileUrl: string;
        requestSha256: string;
        request: unknown;
        beforeSourceArtifactId: string;
      }
    | undefined;
  const precheck = (await resolve(ctx, configPath(ctx, "precheckPath"))) as
    | { result?: RecheckPageState; httpStatus?: number | null; afterSourceArtifactId?: string | null }
    | undefined;
  if (!loaded || !precheck?.result) {
    return { outcome: "failed_terminal", error: "the recheck has no loaded correction or page state" };
  }
  const request = profileCorrectionRequestSchema.safeParse(loaded.request);
  if (!request.success || profileCorrectionRequestHash(request.data) !== loaded.requestSha256) {
    return { outcome: "failed_terminal", error: "the loaded request does not match its hash" };
  }
  const changed = precheck.result === RECHECK_PAGE_STATE.changed;
  const extract = changed ? ((await resolve(ctx, configPath(ctx, "extractPath"))) as { claims?: unknown } | undefined) : undefined;
  const approvedFacts = changed ? await resolve(ctx, configPath(ctx, "approvedFactsPath")) : undefined;
  const compare = changed ? await resolve(ctx, configPath(ctx, "comparePath")) : undefined;
  if (changed && compare === undefined) {
    // The comparison never produced an answer: no result is recorded, so a
    // failure can never read as corrected.
    return { outcome: "failed_terminal", error: "the page changed but no comparison was recorded" };
  }

  const classification = classifyRecheckItems({
    request: request.data,
    pageState: precheck.result,
    compare,
    observedClaims: extract?.claims,
    approvedFacts,
  });
  const resultSha256 = recheckResultHash(classification);
  const packetId =
    changed && approvedFacts && typeof (approvedFacts as { packetId?: unknown }).packetId === "string"
      ? ((approvedFacts as { packetId: string }).packetId)
      : null;

  const outcome = await sql.begin(async (tx) => {
    const row = await lockCorrection(tx, loaded.correctionRequestId, projectId);
    if (!row) return { error: "the correction request is gone" } as const;
    if (row.recheckResultId) {
      return row.recheckRunId === ctx.runId
        ? ({ idempotent: true } as const)
        : ({ error: "this correction already has a recheck result from another run" } as const);
    }
    if (row.status !== PROFILE_CORRECTION_STATUS.sent || row.recheckRunId !== ctx.runId) {
      return { error: `correction request ${row.id} is ${row.status} and not bound to this recheck run` } as const;
    }
    const inserted = await insertRecheckResult(tx, {
      projectId,
      correctionRequestId: row.id,
      checkRequestId: loaded.checkRequestId,
      workflowRunId: ctx.runId,
      profileUrl: row.profileUrl,
      requestSha256: row.requestSha256,
      beforeSourceArtifactId: row.beforeSourceArtifactId,
      afterSourceArtifactId: precheck.afterSourceArtifactId ?? null,
      evidencePacketId: packetId,
      httpStatus: precheck.httpStatus ?? null,
      pageState: precheck.result!,
      result: classification.result,
      resultVersion: classification.version,
      resultDetail: classification as unknown as Record<string, unknown>,
      resultSha256,
    });
    if (!inserted.created && inserted.row.workflowRunId !== ctx.runId) {
      return { error: "this correction already has a recheck result from another run" } as const;
    }
    await closeWithRecheckResult(tx, row.id, { runId: ctx.runId, resultId: inserted.row.id, result: classification.result });
    await writeAudit(tx, {
      userId: null,
      action: `profile_correction.${classification.result}`,
      entity: "profile_correction_request",
      entityId: row.id,
      projectId,
      detail: { recheckResultId: inserted.row.id, pageState: precheck.result, resultSha256 },
    });
    return { resultId: inserted.row.id } as const;
  });
  if ("error" in outcome) return { outcome: "failed_terminal", error: outcome.error };
  return {
    outcome: "succeeded",
    output: {
      correctionRequestId: loaded.correctionRequestId,
      result: classification.result,
      pageState: classification.pageState,
      items: classification.items,
      newContradictions: classification.newContradictions,
      resultSha256,
      recheckResultId: "resultId" in outcome ? outcome.resultId : null,
    },
  };
};

export const profileCorrectionNodes: Record<string, NodeHandler> = {
  "dom.load_profile_correction_recheck": loadProfileCorrectionRecheck,
  "dom.precheck_profile_recheck": precheckProfileRecheck,
  "dom.classify_profile_recheck": classifyProfileRecheck,
  "dom.prepare_profile_correction_draft": prepareProfileCorrectionDraft,
  "dom.record_profile_correction_draft": recordProfileCorrectionDraft,
  "dom.record_profile_correction_sent": recordProfileCorrectionSent,
  "dom.route_profile_correction": routeProfileCorrection,
  "dom.load_external_submission": loadExternalSubmission,
  "dom.record_external_submission_approval": recordExternalSubmissionApproval,
  "dom.fetch_public_profile": fetchPublicProfile,
  "dom.build_profile_correction": buildProfileCorrection,
  "dom.verify_profile_correction": verifyProfileCorrection,
  "dom.record_profile_correction_approval": recordProfileCorrectionApproval,
};
