/**
 * Spec 147 — all SQL for profile checks: the confirmed-URL source, the
 * project preconditions, and the durable check queue the dispatcher drains.
 *
 * Tenant isolation lives in the WHERE clauses: every read of a project's
 * profile URLs filters on project_id AND joins the engagement on the same
 * project_id, so a context item can never be read across clients.
 */
import { sql, type TransactionSql } from "@/db/client";
import { LIVE_ENGAGEMENT_STAGES } from "@/lib/engagements/constants";
import {
  ACTIVE_DRAFT_STATUSES,
  INFERENCE_ACTIVE_RUN_STATES,
  OPEN_CORRECTION_STATUSES,
  LIVE_RUN_KEY_PREFIX,
  PROFILE_CORRECTION_APPROVAL_NODE,
  PROFILE_DRAFT_DISPATCH_JOB,
  PROFILE_DRAFT_DISPATCH_LOCK_KEY,
  PROFILE_RECONCILE_LOCK_KEY,
  STOPPED_RUN_STATES,
  PROFILE_CHECK_DISPATCH_JOB,
  PROFILE_CHECK_DISPATCH_LOCK_KEY,
  PROFILE_CHECK_KIND,
  PROFILE_CHECK_STATUS,
  PROFILE_CHECK_RELEASE_SKIP,
} from "@/lib/profile-corrections/constants";

type Tx = TransactionSql | typeof sql;

const CONFIRMED_ASSET_KIND = "asset";
const CLIENT_CONFIRMED = "client_confirmed";

export interface ConfirmedAssetRow {
  id: string;
  sourceRef: string | null;
  createdAt: Date;
}

/**
 * The authoritative profile-URL rows (spec 147 §2): client-confirmed asset
 * items of this project's LIVE engagement, oldest first so de-duplication
 * keeps a stable context item id.
 */
export async function confirmedProfileAssetRows(projectId: string): Promise<ConfirmedAssetRow[]> {
  const rows = await sql`
    select ci.id, ci.source_ref, ci.created_at
    from engagement_context_items ci
    join client_engagements e on e.id = ci.engagement_id
    where ci.project_id = ${projectId}
      and e.project_id = ${projectId}
      and e.stage = any(${[...LIVE_ENGAGEMENT_STAGES]}::text[])
      and ci.kind = ${CONFIRMED_ASSET_KIND}
      and ci.provenance = ${CLIENT_CONFIRMED}
    order by ci.created_at asc, ci.id asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    sourceRef: (row.sourceRef as string | null) ?? null,
    createdAt: row.createdAt as Date,
  }));
}

export interface ProfileCheckPreconditions {
  projectStatus: string | null;
  hasLiveEngagement: boolean;
  approvedClaims: number;
}

export async function profileCheckPreconditions(
  projectId: string
): Promise<ProfileCheckPreconditions> {
  const [row] = await sql`
    select
      (select status from projects where id = ${projectId}) as project_status,
      exists (
        select 1 from client_engagements
        where project_id = ${projectId}
          and stage = any(${[...LIVE_ENGAGEMENT_STAGES]}::text[])
      ) as has_live_engagement,
      (select count(*)::int from claims
        where project_id = ${projectId} and status = 'approved') as approved_claims
  `;
  return {
    projectStatus: (row?.projectStatus as string | null) ?? null,
    hasLiveEngagement: Boolean(row?.hasLiveEngagement),
    approvedClaims: Number(row?.approvedClaims ?? 0),
  };
}

export interface NewCheckRequest {
  id: string;
  projectId: string;
  contextItemId: string;
  profileUrl: string;
  origin: "operator" | "schedule";
  windowKey: string;
  runIdempotencyKey: string;
  requestedBy: string | null;
}

/**
 * Queue one check. Returns false when this (project, context item, window)
 * is already queued — the unique index is the duplicate guard.
 */
export async function insertCheckRequest(tx: Tx, input: NewCheckRequest): Promise<boolean> {
  const rows = await tx`
    insert into profile_check_requests (
      id, project_id, kind, context_item_id, profile_url, origin, window_key,
      run_idempotency_key, requested_by
    ) values (
      ${input.id}, ${input.projectId}, ${PROFILE_CHECK_KIND.check}, ${input.contextItemId},
      ${input.profileUrl}, ${input.origin}, ${input.windowKey},
      ${input.runIdempotencyKey}, ${input.requestedBy}
    )
    on conflict (project_id, context_item_id, window_key) where kind = 'check'
    do nothing
    returning id
  `;
  return rows.length > 0;
}

/** Enqueue the dispatcher job unless one is already waiting. */
export async function enqueueDispatchJob(tx: Tx, delaySeconds: number): Promise<boolean> {
  const rows = await tx`
    insert into jobs (type, payload, run_after)
    select ${PROFILE_CHECK_DISPATCH_JOB}, '{}'::jsonb,
      now() + make_interval(secs => ${delaySeconds})
    where not exists (
      select 1 from jobs where type = ${PROFILE_CHECK_DISPATCH_JOB} and status = 'queued'
    )
    returning id
  `;
  return rows.length > 0;
}

// ------------------------------------------------------------ dispatcher

/** Serialize dispatchers for the rest of this transaction. */
export async function lockDispatch(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(${PROFILE_CHECK_DISPATCH_LOCK_KEY})`;
}

/**
 * Released rows whose event never became a run (dead-lettered delivery, a
 * refused start) are closed as failed so they stop holding capacity.
 */
export async function failAbandonedReleases(
  tx: TransactionSql,
  timeoutMinutes: number
): Promise<{ id: string; projectId: string }[]> {
  const rows = await tx`
    update profile_check_requests q
    set status = ${PROFILE_CHECK_STATUS.failed},
        reason = ${PROFILE_CHECK_RELEASE_SKIP.releaseTimedOut}
    where q.status = ${PROFILE_CHECK_STATUS.released}
      and q.released_at < now() - make_interval(mins => ${timeoutMinutes})
      and not exists (
        select 1 from workflow_runs r where r.idempotency_key = q.run_idempotency_key
      )
    returning q.id, q.project_id
  `;
  return rows.map((r) => ({ id: r.id as string, projectId: r.projectId as string }));
}

/**
 * Inference-active profile work, globally: runs of the given workflows that
 * can still call a model, plus released rows not yet turned into a run.
 * Runs parked for approval and terminal runs hold no inference.
 */
export async function countInferenceActive(
  tx: Tx,
  workflowKeys: readonly string[]
): Promise<number> {
  const [row] = await tx`
    select
      (select count(*)::int
         from workflow_runs r
         join workflow_versions v on v.id = r.version_id
         join workflow_definitions d on d.id = v.definition_id
        where d.key = any(${[...workflowKeys]}::text[])
          and r.state = any(${[...INFERENCE_ACTIVE_RUN_STATES]}::text[]))
      +
      (select count(*)::int
         from profile_check_requests q
        where q.status = ${PROFILE_CHECK_STATUS.released}
          and not exists (
            select 1 from workflow_runs r where r.idempotency_key = q.run_idempotency_key
          )) as active
  `;
  return Number(row?.active ?? 0);
}

export interface DueCheckRequest {
  id: string;
  projectId: string;
  kind: "check" | "recheck";
  contextItemId: string | null;
  correctionRequestId: string | null;
  profileUrl: string;
  origin: string;
  windowKey: string;
  projectStatus: string | null;
}

/**
 * Oldest due queued work — checks and rechecks alike, sharing one capacity —
 * locked for this transaction. Nothing is due before its not_before.
 */
export async function claimDueChecks(tx: TransactionSql, limit: number): Promise<DueCheckRequest[]> {
  if (limit <= 0) return [];
  const rows = await tx`
    select q.id, q.project_id, q.kind, q.context_item_id, q.correction_request_id, q.profile_url,
      q.origin, q.window_key, p.status as project_status
    from profile_check_requests q
    left join projects p on p.id = q.project_id
    where q.status = ${PROFILE_CHECK_STATUS.queued}
      and q.not_before <= now()
    order by q.not_before asc, q.created_at asc, q.id asc
    limit ${limit}
    for update of q skip locked
  `;
  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.projectId as string,
    kind: r.kind as "check" | "recheck",
    contextItemId: (r.contextItemId as string | null) ?? null,
    correctionRequestId: (r.correctionRequestId as string | null) ?? null,
    profileUrl: r.profileUrl as string,
    origin: r.origin as string,
    windowKey: r.windowKey as string,
    projectStatus: (r.projectStatus as string | null) ?? null,
  }));
}

export async function markReleased(tx: TransactionSql, id: string, eventId: string): Promise<void> {
  await tx`
    update profile_check_requests
    set status = ${PROFILE_CHECK_STATUS.released}, released_at = now(), event_id = ${eventId}
    where id = ${id} and status = ${PROFILE_CHECK_STATUS.queued}
  `;
}

export async function markSkipped(tx: TransactionSql, id: string, reason: string): Promise<void> {
  await tx`
    update profile_check_requests
    set status = ${PROFILE_CHECK_STATUS.skipped}, reason = ${reason}
    where id = ${id} and status = ${PROFILE_CHECK_STATUS.queued}
  `;
}

export async function markFailed(tx: TransactionSql, id: string, reason: string): Promise<void> {
  await tx`
    update profile_check_requests
    set status = ${PROFILE_CHECK_STATUS.failed}, reason = ${reason}
    where id = ${id} and status = ${PROFILE_CHECK_STATUS.queued}
  `;
}

/** Is any check due now and still waiting? */
export async function hasDueQueuedChecks(tx: Tx): Promise<boolean> {
  const [row] = await tx`
    select exists (
      select 1 from profile_check_requests
      where status = ${PROFILE_CHECK_STATUS.queued}
        and not_before <= now()
    ) as due
  `;
  return Boolean(row?.due);
}

export interface CheckRequestRow {
  id: string;
  projectId: string;
  contextItemId: string | null;
  profileUrl: string;
  origin: string;
  windowKey: string;
  status: string;
  reason: string | null;
  runIdempotencyKey: string;
  eventId: string | null;
  createdAt: Date;
  releasedAt: Date | null;
}

/** A project's check requests, newest first (operator visibility). */
export async function listCheckRequests(projectId: string, limit = 100): Promise<CheckRequestRow[]> {
  const rows = await sql`
    select id, project_id, context_item_id, profile_url, origin, window_key, status,
      reason, run_idempotency_key, event_id, created_at, released_at
    from profile_check_requests
    where project_id = ${projectId}
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.projectId as string,
    contextItemId: (r.contextItemId as string | null) ?? null,
    profileUrl: r.profileUrl as string,
    origin: r.origin as string,
    windowKey: r.windowKey as string,
    status: r.status as string,
    reason: (r.reason as string | null) ?? null,
    runIdempotencyKey: r.runIdempotencyKey as string,
    eventId: (r.eventId as string | null) ?? null,
    createdAt: r.createdAt as Date,
    releasedAt: (r.releasedAt as Date | null) ?? null,
  }));
}

// ------------------------------------------------- correction requests

export interface AuthorityRows {
  claims: { id: string; projectId: string; status: string; evidenceIds: string[] }[];
  sourceArtifact: { id: string; projectId: string; sha256: string } | null;
}

/**
 * Current database state for the claims and before-page artifact a request
 * references — deliberately NOT filtered by project, so a cross-project id is
 * seen and refused rather than silently missing.
 */
export async function loadCorrectionAuthority(
  tx: Tx,
  claimIds: readonly string[],
  sourceArtifactId: string | null
): Promise<AuthorityRows> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = claimIds.filter((id) => uuid.test(id));
  const claimRows =
    ids.length === 0
      ? []
      : await tx`
          select id, project_id, status, evidence_ids
          from claims where id = any(${ids}::uuid[])
        `;
  const [artifact] =
    sourceArtifactId && uuid.test(sourceArtifactId)
      ? await tx`select id, project_id, sha256 from source_artifacts where id = ${sourceArtifactId}`
      : [];
  return {
    claims: claimRows.map((r) => ({
      id: r.id as string,
      projectId: r.projectId as string,
      status: r.status as string,
      evidenceIds: ((r.evidenceIds as string[] | null) ?? []).map(String),
    })),
    sourceArtifact: artifact
      ? {
          id: artifact.id as string,
          projectId: artifact.projectId as string,
          sha256: artifact.sha256 as string,
        }
      : null,
  };
}

export interface CorrectionRow {
  id: string;
  projectId: string;
  workflowRunId: string;
  checkRequestId: string | null;
  contextItemId: string | null;
  profileUrl: string;
  requestVersion: string;
  request: unknown;
  requestSha256: string;
  status: string;
  approvalId: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionRationale: string | null;
  closedReason: string | null;
  destinationId: string | null;
  routedAt: Date | null;
  activeDraftId: string | null;
  sentAt: Date | null;
  sentDraftId: string | null;
  recheckDueAt: Date | null;
  recheckRunId: string | null;
  recheckResultId: string | null;
  beforeSourceArtifactId: string;
  beforeSha256: string;
  createdAt: Date;
}

function toCorrection(r: Record<string, unknown>): CorrectionRow {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    workflowRunId: r.workflowRunId as string,
    checkRequestId: (r.checkRequestId as string | null) ?? null,
    contextItemId: (r.contextItemId as string | null) ?? null,
    profileUrl: r.profileUrl as string,
    requestVersion: r.requestVersion as string,
    request: r.request,
    requestSha256: r.requestSha256 as string,
    status: r.status as string,
    approvalId: (r.approvalId as string | null) ?? null,
    decidedBy: (r.decidedBy as string | null) ?? null,
    decidedAt: (r.decidedAt as Date | null) ?? null,
    decisionRationale: (r.decisionRationale as string | null) ?? null,
    closedReason: (r.closedReason as string | null) ?? null,
    destinationId: (r.destinationId as string | null) ?? null,
    routedAt: (r.routedAt as Date | null) ?? null,
    activeDraftId: (r.activeDraftId as string | null) ?? null,
    sentAt: (r.sentAt as Date | null) ?? null,
    sentDraftId: (r.sentDraftId as string | null) ?? null,
    recheckDueAt: (r.recheckDueAt as Date | null) ?? null,
    recheckRunId: (r.recheckRunId as string | null) ?? null,
    recheckResultId: (r.recheckResultId as string | null) ?? null,
    beforeSourceArtifactId: r.beforeSourceArtifactId as string,
    beforeSha256: r.beforeSha256 as string,
    createdAt: r.createdAt as Date,
  };
}

const CORRECTION_SELECT = `
  id, project_id, workflow_run_id, check_request_id, context_item_id, profile_url,
  request_version, request, request_sha256, status, approval_id, decided_by,
  decided_at, decision_rationale, closed_reason, destination_id, routed_at,
  active_draft_id, sent_at, sent_draft_id, recheck_due_at, recheck_run_id, recheck_result_id,
  before_source_artifact_id, before_sha256, created_at
`;

export interface NewCorrectionRequest {
  projectId: string;
  workflowRunId: string;
  checkRequestId: string | null;
  contextItemId: string | null;
  profileUrl: string;
  requestVersion: string;
  request: Record<string, unknown>;
  requestSha256: string;
  beforeSourceArtifactId: string;
  beforeSha256: string;
  evidencePacketId: string;
  itemCount: number;
  maxSeverity: string;
  createdBy: string | null;
}

/**
 * Insert a correction unless this profile already has an open one. The
 * partial unique index decides under concurrency: exactly one insert wins,
 * every other returns the winner as `existing`.
 */
export async function insertCorrectionRequest(
  tx: TransactionSql,
  input: NewCorrectionRequest
): Promise<{ created: CorrectionRow } | { existing: CorrectionRow }> {
  const inserted = await tx`
    insert into profile_correction_requests (
      project_id, workflow_run_id, check_request_id, context_item_id, profile_url,
      request_version, request, request_sha256, before_source_artifact_id, before_sha256,
      evidence_packet_id, item_count, max_severity, created_by
    ) values (
      ${input.projectId}, ${input.workflowRunId}, ${input.checkRequestId}, ${input.contextItemId},
      ${input.profileUrl}, ${input.requestVersion}, ${tx.json(input.request as never)},
      ${input.requestSha256}, ${input.beforeSourceArtifactId}, ${input.beforeSha256},
      ${input.evidencePacketId}, ${input.itemCount}, ${input.maxSeverity}, ${input.createdBy}
    )
    on conflict (project_id, profile_url)
      where status in ('awaiting_approval', 'approved', 'destination_required',
                       'awaiting_external_approval', 'ready_to_draft',
                       'awaiting_send_confirmation', 'sent')
    do nothing
    returning ${tx.unsafe(CORRECTION_SELECT)}
  `;
  if (inserted[0]) return { created: toCorrection(inserted[0]) };
  const existing = await findOpenCorrection(tx, input.projectId, input.profileUrl);
  if (!existing) {
    // The conflicting row closed between the insert and this read; the
    // caller retries rather than guessing.
    throw new Error("open correction conflict could not be resolved; retry");
  }
  return { existing };
}

export async function findOpenCorrection(
  tx: Tx,
  projectId: string,
  profileUrl: string
): Promise<CorrectionRow | null> {
  const [row] = await tx`
    select ${tx.unsafe(CORRECTION_SELECT)} from profile_correction_requests
    where project_id = ${projectId} and profile_url = ${profileUrl}
      and status = any(${[...OPEN_CORRECTION_STATUSES]}::text[])
  `;
  return row ? toCorrection(row) : null;
}

export async function correctionForRun(
  tx: Tx,
  runId: string,
  projectId: string
): Promise<CorrectionRow | null> {
  const [row] = await tx`
    select ${tx.unsafe(CORRECTION_SELECT)} from profile_correction_requests
    where workflow_run_id = ${runId} and project_id = ${projectId}
  `;
  return row ? toCorrection(row) : null;
}

export async function correctionById(tx: Tx, id: string): Promise<CorrectionRow | null> {
  const [row] = await tx`
    select ${tx.unsafe(CORRECTION_SELECT)} from profile_correction_requests where id = ${id}
  `;
  return row ? toCorrection(row) : null;
}

export async function listCorrectionRequests(projectId: string, limit = 100): Promise<CorrectionRow[]> {
  const rows = await sql`
    select ${sql.unsafe(CORRECTION_SELECT)} from profile_correction_requests
    where project_id = ${projectId}
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map(toCorrection);
}

export interface ApprovalRow {
  id: string;
  workflowRunId: string;
  projectId: string | null;
  nodeKey: string;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  rationale: string | null;
  detail: Record<string, unknown>;
}

/** The approval row of one node in one run (the correction approval gate). */
export async function approvalForRunNode(
  tx: Tx,
  runId: string,
  nodeKey: string
): Promise<ApprovalRow | null> {
  const [row] = await tx`
    select a.id, a.workflow_run_id, a.project_id, n.node_key, a.decision, a.decided_by,
      a.decided_at, a.rationale, a.detail
    from workflow_approvals a
    join node_runs n on n.id = a.node_run_id
    where a.workflow_run_id = ${runId} and n.node_key = ${nodeKey}
    order by a.requested_at desc
    limit 1
  `;
  return row ? toApproval(row) : null;
}

export async function approvalById(tx: Tx, approvalId: string): Promise<ApprovalRow | null> {
  const [row] = await tx`
    select a.id, a.workflow_run_id, a.project_id, n.node_key, a.decision, a.decided_by,
      a.decided_at, a.rationale, a.detail
    from workflow_approvals a
    join node_runs n on n.id = a.node_run_id
    where a.id = ${approvalId}
  `;
  return row ? toApproval(row) : null;
}

function toApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: row.id as string,
    workflowRunId: row.workflowRunId as string,
    projectId: (row.projectId as string | null) ?? null,
    nodeKey: row.nodeKey as string,
    decision: (row.decision as string | null) ?? null,
    decidedBy: (row.decidedBy as string | null) ?? null,
    decidedAt: (row.decidedAt as Date | null) ?? null,
    rationale: (row.rationale as string | null) ?? null,
    detail: (row.detail as Record<string, unknown>) ?? {},
  };
}

/** Guarded lifecycle move. Returns false when the row was not in `from`. */
export async function recordCorrectionDecision(
  tx: TransactionSql,
  id: string,
  args: {
    from: string;
    to: string;
    approvalId: string;
    decidedBy: string | null;
    decidedAt: Date;
    rationale: string | null;
  }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_requests
    set status = ${args.to}, approval_id = ${args.approvalId}, decided_by = ${args.decidedBy},
        decided_at = ${args.decidedAt}, decision_rationale = ${args.rationale}, updated_at = now()
    where id = ${id} and status = ${args.from}
    returning id
  `;
  return rows.length > 0;
}

export async function closeCorrection(
  tx: TransactionSql,
  id: string,
  args: { fromStatuses: readonly string[]; to: string; closedBy: string | null; reason: string }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_requests
    set status = ${args.to}, closed_by = ${args.closedBy}, closed_at = now(),
        closed_reason = ${args.reason}, updated_at = now()
    where id = ${id} and status = any(${[...args.fromStatuses]}::text[])
    returning id
  `;
  return rows.length > 0;
}

/** Open corrections for a project, keyed by profile URL (start/dispatch skip). */
export async function openCorrectionUrls(tx: Tx, projectId: string): Promise<Set<string>> {
  const rows = await tx`
    select profile_url from profile_correction_requests
    where project_id = ${projectId} and status = any(${[...OPEN_CORRECTION_STATUSES]}::text[])
  `;
  return new Set(rows.map((r) => r.profileUrl as string));
}

// ------------------------------------------------------------ destinations

export interface DestinationRow {
  id: string;
  projectId: string;
  profileUrl: string;
  kind: string;
  recipientName: string;
  email: string;
  basis: string;
  sourceUrl: string | null;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
  archivedBy: string | null;
  archiveReason: string | null;
}

function toDestination(r: Record<string, unknown>): DestinationRow {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    profileUrl: r.profileUrl as string,
    kind: r.kind as string,
    recipientName: r.recipientName as string,
    email: r.email as string,
    basis: r.basis as string,
    sourceUrl: (r.sourceUrl as string | null) ?? null,
    createdBy: r.createdBy as string,
    createdAt: r.createdAt as Date,
    archivedAt: (r.archivedAt as Date | null) ?? null,
    archivedBy: (r.archivedBy as string | null) ?? null,
    archiveReason: (r.archiveReason as string | null) ?? null,
  };
}

const DESTINATION_SELECT = `
  id, project_id, profile_url, kind, recipient_name, email, basis, source_url,
  created_by, created_at, archived_at, archived_by, archive_reason
`;

/** Serialize every destination write and reroute for one (project, profile). */
export async function lockProfileDestination(
  tx: TransactionSql,
  projectId: string,
  profileUrl: string
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`profile-destination:${projectId}:${profileUrl}`}, 0))`;
}

/** The ACTIVE destination for a profile, locked against concurrent archive. */
export async function activeDestination(
  tx: Tx,
  projectId: string,
  profileUrl: string,
  opts: { lock?: boolean } = {}
): Promise<DestinationRow | null> {
  const rows = opts.lock
    ? await tx`
        select ${tx.unsafe(DESTINATION_SELECT)} from profile_correction_destinations
        where project_id = ${projectId} and profile_url = ${profileUrl} and archived_at is null
        for update
      `
    : await tx`
        select ${tx.unsafe(DESTINATION_SELECT)} from profile_correction_destinations
        where project_id = ${projectId} and profile_url = ${profileUrl} and archived_at is null
      `;
  return rows[0] ? toDestination(rows[0]) : null;
}

export async function destinationById(tx: Tx, id: string): Promise<DestinationRow | null> {
  const [row] = await tx`
    select ${tx.unsafe(DESTINATION_SELECT)} from profile_correction_destinations where id = ${id}
  `;
  return row ? toDestination(row) : null;
}

export async function listDestinations(projectId: string, profileUrl?: string): Promise<DestinationRow[]> {
  const rows = profileUrl
    ? await sql`
        select ${sql.unsafe(DESTINATION_SELECT)} from profile_correction_destinations
        where project_id = ${projectId} and profile_url = ${profileUrl}
        order by created_at desc, id desc
      `
    : await sql`
        select ${sql.unsafe(DESTINATION_SELECT)} from profile_correction_destinations
        where project_id = ${projectId}
        order by profile_url, created_at desc, id desc
      `;
  return rows.map(toDestination);
}

export interface NewDestination {
  projectId: string;
  profileUrl: string;
  kind: string;
  recipientName: string;
  email: string;
  basis: string;
  sourceUrl: string | null;
  createdBy: string;
}

export async function insertDestination(tx: TransactionSql, input: NewDestination): Promise<DestinationRow> {
  const [row] = await tx`
    insert into profile_correction_destinations (
      project_id, profile_url, kind, recipient_name, email, basis, source_url, created_by
    ) values (
      ${input.projectId}, ${input.profileUrl}, ${input.kind}, ${input.recipientName},
      ${input.email}, ${input.basis}, ${input.sourceUrl}, ${input.createdBy}
    )
    returning ${tx.unsafe(DESTINATION_SELECT)}
  `;
  return toDestination(row!);
}

/** Archive an active destination. Returns false if it was already archived. */
export async function archiveDestinationRow(
  tx: TransactionSql,
  id: string,
  args: { projectId: string; archivedBy: string; reason: string }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_destinations
    set archived_at = now(), archived_by = ${args.archivedBy}, archive_reason = ${args.reason}
    where id = ${id} and project_id = ${args.projectId} and archived_at is null
    returning id
  `;
  return rows.length > 0;
}

/** Requests that follow this profile's destination, oldest first, locked. */
export async function reroutableCorrections(
  tx: TransactionSql,
  projectId: string,
  profileUrl: string,
  statuses: readonly string[]
): Promise<CorrectionRow[]> {
  const rows = await tx`
    select ${tx.unsafe(CORRECTION_SELECT)} from profile_correction_requests
    where project_id = ${projectId} and profile_url = ${profileUrl}
      and status = any(${[...statuses]}::text[])
    order by created_at asc, id asc
    for update
  `;
  return rows.map(toCorrection);
}

export async function lockCorrection(
  tx: TransactionSql,
  id: string,
  projectId: string
): Promise<CorrectionRow | null> {
  const [row] = await tx`
    select ${tx.unsafe(CORRECTION_SELECT)} from profile_correction_requests
    where id = ${id} and project_id = ${projectId}
    for update
  `;
  return row ? toCorrection(row) : null;
}

/** Guarded routing move: the row must still be in `from`. */
export async function setCorrectionRoute(
  tx: TransactionSql,
  id: string,
  args: { from: string; to: string; destinationId: string | null }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_requests
    set status = ${args.to}, destination_id = ${args.destinationId}, routed_at = now(), updated_at = now()
    where id = ${id} and status = ${args.from}
    returning id
  `;
  return rows.length > 0;
}

/**
 * The client's confirmed contact on the live engagement — offered to an
 * operator ONLY as a prefill for a client_editor destination, never used by
 * routing.
 */
export async function clientConfirmedContact(
  projectId: string
): Promise<{ name: string; email: string; contextItemId: string } | null> {
  const [row] = await sql`
    select ci.id, ci.value ->> 'contactEmail' as contact_email, e.primary_contact_name
    from engagement_context_items ci
    join client_engagements e on e.id = ci.engagement_id
    where ci.project_id = ${projectId}
      and e.project_id = ${projectId}
      and e.stage = any(${[...LIVE_ENGAGEMENT_STAGES]}::text[])
      and ci.kind = 'identity'
      and ci.provenance = ${CLIENT_CONFIRMED}
      and coalesce(ci.value ->> 'contactEmail', '') <> ''
    order by ci.created_at desc, ci.id desc
    limit 1
  `;
  if (!row) return null;
  return {
    name: (row.primaryContactName as string) ?? "",
    email: row.contactEmail as string,
    contextItemId: row.id as string,
  };
}

/** Does this project have any correction request for this profile URL? */
export async function hasCorrectionForUrl(tx: Tx, projectId: string, profileUrl: string): Promise<boolean> {
  const [row] = await tx`
    select exists (
      select 1 from profile_correction_requests where project_id = ${projectId} and profile_url = ${profileUrl}
    ) as found
  `;
  return Boolean(row?.found);
}

/** Requests waiting for a destination on one profile (operator visibility). */
export async function waitingCorrections(projectId: string, profileUrl?: string): Promise<CorrectionRow[]> {
  const rows = profileUrl
    ? await sql`
        select ${sql.unsafe(CORRECTION_SELECT)} from profile_correction_requests
        where project_id = ${projectId} and profile_url = ${profileUrl} and status = 'destination_required'
        order by created_at asc, id asc
      `
    : await sql`
        select ${sql.unsafe(CORRECTION_SELECT)} from profile_correction_requests
        where project_id = ${projectId} and status = 'destination_required'
        order by created_at asc, id asc
      `;
  return rows.map(toCorrection);
}

/** A string field from a run's input payload (the run's own start event). */
export async function runPayloadValue(tx: Tx, runId: string, key: string): Promise<string | null> {
  const [row] = await tx`select input -> 'payload' ->> ${key} as value from workflow_runs where id = ${runId}`;
  return (row?.value as string | null) ?? null;
}

// ---------------------------------------------------------------- drafting

export interface DraftRow {
  id: string;
  projectId: string;
  correctionRequestId: string;
  destinationId: string;
  requestSha256: string;
  attempt: number;
  status: string;
  runIdempotencyKey: string;
  eventId: string | null;
  workflowRunId: string | null;
  emailVersion: string | null;
  email: { templateVersion: string; to: string; subject: string; body: string } | null;
  emailSha256: string | null;
  fromAddress: string | null;
  connectionId: string | null;
  gmailDraftId: string | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  draftedAt: Date | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  confirmationApprovalId: string | null;
  failureReason: string | null;
  createdAt: Date;
}

const DRAFT_SELECT = `
  id, project_id, correction_request_id, destination_id, request_sha256, attempt, status,
  run_idempotency_key, event_id, workflow_run_id, email_version, email, email_sha256,
  from_address, connection_id, gmail_draft_id, gmail_message_id, gmail_thread_id,
  drafted_at, confirmed_at, confirmed_by, confirmation_approval_id, failure_reason, created_at
`;

function toDraft(r: Record<string, unknown>): DraftRow {
  return {
    id: r.id as string,
    projectId: r.projectId as string,
    correctionRequestId: r.correctionRequestId as string,
    destinationId: r.destinationId as string,
    requestSha256: r.requestSha256 as string,
    attempt: Number(r.attempt),
    status: r.status as string,
    runIdempotencyKey: r.runIdempotencyKey as string,
    eventId: (r.eventId as string | null) ?? null,
    workflowRunId: (r.workflowRunId as string | null) ?? null,
    emailVersion: (r.emailVersion as string | null) ?? null,
    email: (r.email as DraftRow["email"]) ?? null,
    emailSha256: (r.emailSha256 as string | null) ?? null,
    fromAddress: (r.fromAddress as string | null) ?? null,
    connectionId: (r.connectionId as string | null) ?? null,
    gmailDraftId: (r.gmailDraftId as string | null) ?? null,
    gmailMessageId: (r.gmailMessageId as string | null) ?? null,
    gmailThreadId: (r.gmailThreadId as string | null) ?? null,
    draftedAt: (r.draftedAt as Date | null) ?? null,
    confirmedAt: (r.confirmedAt as Date | null) ?? null,
    confirmedBy: (r.confirmedBy as string | null) ?? null,
    confirmationApprovalId: (r.confirmationApprovalId as string | null) ?? null,
    failureReason: (r.failureReason as string | null) ?? null,
    createdAt: r.createdAt as Date,
  };
}

export async function lockDraftDispatch(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(${PROFILE_DRAFT_DISPATCH_LOCK_KEY})`;
}

/**
 * Close attempts whose run can no longer progress. A `pending` attempt never
 * called Gmail, so it simply failed. A `creating` attempt may have created a
 * draft before its run stopped, so its outcome is unknown and it is never
 * retried automatically (a second draft would be a duplicate).
 */
export async function settleStalledDraftAttempts(
  tx: TransactionSql,
  releaseTimeoutMinutes: number
): Promise<{ id: string; status: string }[]> {
  const rows = await tx`
    update profile_correction_drafts a
    set status = case when a.status = 'creating' then 'outcome_unknown' else 'failed' end,
        failure_reason = case
          when a.status = 'creating' then 'the draft run stopped after Gmail may have been called; check Gmail for a stray draft'
          when r.id is null then 'the draft run never started'
          else 'the draft run stopped before Gmail was called: ' || r.state end,
        updated_at = now()
    from (select a2.id as attempt_id, r2.id, r2.state
            from profile_correction_drafts a2
            left join workflow_runs r2 on r2.idempotency_key = a2.run_idempotency_key
           where a2.status in ('pending', 'creating')) r
    where a.id = r.attempt_id
      and (
        (r.id is null and a.status = 'pending' and a.created_at < now() - make_interval(mins => ${releaseTimeoutMinutes}))
        or r.state in ('failed', 'cancelled', 'safely_stopped', 'timed_out', 'partially_completed')
      )
    returning a.id, a.status
  `;
  return rows.map((r) => ({ id: r.id as string, status: r.status as string }));
}

export interface DraftCandidate {
  id: string;
  projectId: string;
  destinationId: string;
  requestSha256: string;
  nextAttempt: number;
}

/**
 * Ready requests with no active attempt, oldest first. A request whose last
 * attempt has an unknown outcome waits for an operator; a recently failed one
 * waits for the retry window.
 */
export async function readyForDrafting(
  tx: TransactionSql,
  limit: number,
  retryMinutes: number
): Promise<DraftCandidate[]> {
  const rows = await tx`
    select r.id, r.project_id, r.destination_id, r.request_sha256,
      coalesce((select max(attempt) from profile_correction_drafts d where d.correction_request_id = r.id), 0) + 1
        as next_attempt
    from profile_correction_requests r
    where r.status = 'ready_to_draft'
      and r.destination_id is not null
      and not exists (
        select 1 from profile_correction_drafts d
        where d.correction_request_id = r.id
          and (d.status = any(${[...ACTIVE_DRAFT_STATUSES]}::text[])
               or d.status in ('outcome_unknown', 'orphaned')
               or (d.status = 'failed' and d.updated_at > now() - make_interval(mins => ${retryMinutes})))
      )
    order by r.routed_at asc nulls first, r.created_at asc, r.id asc
    limit ${limit}
    for update of r skip locked
  `;
  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.projectId as string,
    destinationId: r.destinationId as string,
    requestSha256: r.requestSha256 as string,
    nextAttempt: Number(r.nextAttempt),
  }));
}

export async function insertDraftAttempt(
  tx: TransactionSql,
  input: {
    id: string;
    projectId: string;
    correctionRequestId: string;
    destinationId: string;
    requestSha256: string;
    attempt: number;
    runIdempotencyKey: string;
  }
): Promise<boolean> {
  const rows = await tx`
    insert into profile_correction_drafts (
      id, project_id, correction_request_id, destination_id, request_sha256, attempt, run_idempotency_key
    ) values (
      ${input.id}, ${input.projectId}, ${input.correctionRequestId}, ${input.destinationId},
      ${input.requestSha256}, ${input.attempt}, ${input.runIdempotencyKey}
    )
    on conflict do nothing
    returning id
  `;
  return rows.length > 0;
}

export async function setDraftEvent(tx: TransactionSql, id: string, eventId: string): Promise<void> {
  await tx`update profile_correction_drafts set event_id = ${eventId}, updated_at = now() where id = ${id}`;
}

export async function draftById(tx: Tx, id: string): Promise<DraftRow | null> {
  const [row] = await tx`select ${tx.unsafe(DRAFT_SELECT)} from profile_correction_drafts where id = ${id}`;
  return row ? toDraft(row) : null;
}

export async function lockDraft(tx: TransactionSql, id: string, projectId: string): Promise<DraftRow | null> {
  const [row] = await tx`
    select ${tx.unsafe(DRAFT_SELECT)} from profile_correction_drafts
    where id = ${id} and project_id = ${projectId}
    for update
  `;
  return row ? toDraft(row) : null;
}

export async function listDrafts(correctionRequestId: string): Promise<DraftRow[]> {
  const rows = await sql`
    select ${sql.unsafe(DRAFT_SELECT)} from profile_correction_drafts
    where correction_request_id = ${correctionRequestId}
    order by attempt asc
  `;
  return rows.map(toDraft);
}

export async function setDraftStatus(
  tx: TransactionSql,
  id: string,
  args: { from: readonly string[]; to: string; reason?: string | null }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_drafts
    set status = ${args.to}, failure_reason = coalesce(${args.reason ?? null}, failure_reason), updated_at = now()
    where id = ${id} and status = any(${[...args.from]}::text[])
    returning id
  `;
  return rows.length > 0;
}

export async function markDraftCreating(
  tx: TransactionSql,
  id: string,
  args: {
    workflowRunId: string;
    emailVersion: string;
    email: Record<string, unknown>;
    emailSha256: string;
    fromAddress: string;
    connectionId: string;
  }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_drafts
    set status = 'creating', workflow_run_id = ${args.workflowRunId}, email_version = ${args.emailVersion},
        email = ${tx.json(args.email as never)}, email_sha256 = ${args.emailSha256},
        from_address = ${args.fromAddress}, connection_id = ${args.connectionId}, updated_at = now()
    where id = ${id} and status = 'pending'
    returning id
  `;
  return rows.length > 0;
}

export async function markDraftCreated(
  tx: TransactionSql,
  id: string,
  args: { status: string; gmailDraftId: string; gmailMessageId: string | null; gmailThreadId: string | null; reason?: string | null }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_drafts
    set status = ${args.status}, gmail_draft_id = ${args.gmailDraftId}, gmail_message_id = ${args.gmailMessageId},
        gmail_thread_id = ${args.gmailThreadId}, drafted_at = now(),
        failure_reason = ${args.reason ?? null}, updated_at = now()
    where id = ${id} and status = 'creating'
    returning id
  `;
  return rows.length > 0;
}

export async function markDraftSent(
  tx: TransactionSql,
  id: string,
  args: { confirmedBy: string | null; approvalId: string }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_drafts
    set status = 'sent', confirmed_at = now(), confirmed_by = ${args.confirmedBy},
        confirmation_approval_id = ${args.approvalId}, updated_at = now()
    where id = ${id} and status = 'created'
    returning id
  `;
  return rows.length > 0;
}

/** A re-route invalidates any attempt that has not yet called Gmail. */
export async function supersedePendingDrafts(tx: TransactionSql, correctionRequestId: string): Promise<number> {
  const rows = await tx`
    update profile_correction_drafts
    set status = 'superseded', failure_reason = 'the request was re-routed', updated_at = now()
    where correction_request_id = ${correctionRequestId} and status = 'pending'
    returning id
  `;
  return rows.length;
}

export async function setAwaitingSendConfirmation(
  tx: TransactionSql,
  id: string,
  draftId: string
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_requests
    set status = 'awaiting_send_confirmation', active_draft_id = ${draftId}, updated_at = now()
    where id = ${id} and status = 'ready_to_draft'
    returning id
  `;
  return rows.length > 0;
}

export async function markCorrectionSent(
  tx: TransactionSql,
  id: string,
  args: { draftId: string; confirmedBy: string | null; approvalId: string; recheckDays: number }
): Promise<{ sentAt: Date; recheckDueAt: Date } | null> {
  const [row] = await tx`
    update profile_correction_requests
    set status = 'sent', sent_at = now(), sent_confirmed_by = ${args.confirmedBy},
        sent_approval_id = ${args.approvalId}, sent_draft_id = ${args.draftId},
        recheck_due_at = now() + make_interval(days => ${args.recheckDays}), updated_at = now()
    where id = ${id} and status = 'awaiting_send_confirmation' and active_draft_id = ${args.draftId}
    returning sent_at, recheck_due_at
  `;
  return row ? { sentAt: row.sentAt as Date, recheckDueAt: row.recheckDueAt as Date } : null;
}

/** Exactly one recheck queue row per sent correction (unique index, migration 120). */
export async function insertRecheckRequest(
  tx: TransactionSql,
  input: {
    projectId: string;
    correctionRequestId: string;
    contextItemId: string | null;
    profileUrl: string;
    notBefore: Date;
    windowKey: string;
    runIdempotencyKey: string;
    requestedBy: string | null;
  }
): Promise<boolean> {
  const rows = await tx`
    insert into profile_check_requests (
      project_id, kind, context_item_id, correction_request_id, profile_url, origin,
      window_key, not_before, run_idempotency_key, requested_by
    ) values (
      ${input.projectId}, ${PROFILE_CHECK_KIND.recheck}, ${input.contextItemId}, ${input.correctionRequestId},
      ${input.profileUrl}, 'recheck', ${input.windowKey}, ${input.notBefore}, ${input.runIdempotencyKey},
      ${input.requestedBy}
    )
    on conflict (correction_request_id) where kind = 'recheck' do nothing
    returning id
  `;
  return rows.length > 0;
}

/** The succeeded outputs of named nodes in one run (for re-validation). */
export async function nodeOutputsForRun(
  tx: Tx,
  runId: string,
  nodeKeys: readonly string[]
): Promise<Record<string, unknown>> {
  const rows = await tx`
    select node_key, output from node_runs
    where workflow_run_id = ${runId} and node_key = any(${[...nodeKeys]}::text[]) and state = 'succeeded'
  `;
  return Object.fromEntries(rows.map((r) => [r.nodeKey as string, r.output]));
}

export async function enqueueDraftDispatchJob(tx: Tx, delaySeconds = 0): Promise<boolean> {
  const rows = await tx`
    insert into jobs (type, payload, run_after)
    select ${PROFILE_DRAFT_DISPATCH_JOB}, '{}'::jsonb, now() + make_interval(secs => ${delaySeconds})
    where not exists (
      select 1 from jobs where type = ${PROFILE_DRAFT_DISPATCH_JOB} and status = 'queued'
    )
    returning id
  `;
  return rows.length > 0;
}

// ----------------------------------------------------------------- recheck

export interface NewRecheckResult {
  projectId: string;
  correctionRequestId: string;
  checkRequestId: string | null;
  workflowRunId: string;
  profileUrl: string;
  requestSha256: string;
  beforeSourceArtifactId: string;
  afterSourceArtifactId: string | null;
  evidencePacketId: string | null;
  httpStatus: number | null;
  pageState: string;
  result: string;
  resultVersion: string;
  resultDetail: Record<string, unknown>;
  resultSha256: string;
}

export interface RecheckResultRow {
  id: string;
  correctionRequestId: string;
  workflowRunId: string;
  result: string;
  resultSha256: string;
  checkedAt: Date;
}

/** One result per correction; a second insert returns the first. */
export async function insertRecheckResult(
  tx: TransactionSql,
  input: NewRecheckResult
): Promise<{ created: boolean; row: RecheckResultRow }> {
  const inserted = await tx`
    insert into profile_correction_rechecks (
      project_id, correction_request_id, check_request_id, workflow_run_id, profile_url, request_sha256,
      before_source_artifact_id, after_source_artifact_id, evidence_packet_id, http_status, page_state,
      result, result_version, result_detail, result_sha256
    ) values (
      ${input.projectId}, ${input.correctionRequestId}, ${input.checkRequestId}, ${input.workflowRunId},
      ${input.profileUrl}, ${input.requestSha256}, ${input.beforeSourceArtifactId}, ${input.afterSourceArtifactId},
      ${input.evidencePacketId}, ${input.httpStatus}, ${input.pageState}, ${input.result}, ${input.resultVersion},
      ${tx.json(input.resultDetail as never)}, ${input.resultSha256}
    )
    on conflict (correction_request_id) do nothing
    returning id, correction_request_id, workflow_run_id, result, result_sha256, checked_at
  `;
  const row =
    inserted[0] ??
    (
      await tx`
        select id, correction_request_id, workflow_run_id, result, result_sha256, checked_at
        from profile_correction_rechecks where correction_request_id = ${input.correctionRequestId}
      `
    )[0];
  return {
    created: inserted.length > 0,
    row: {
      id: row!.id as string,
      correctionRequestId: row!.correctionRequestId as string,
      workflowRunId: row!.workflowRunId as string,
      result: row!.result as string,
      resultSha256: row!.resultSha256 as string,
      checkedAt: row!.checkedAt as Date,
    },
  };
}

/** Bind the recheck run to the sent correction (once). */
export async function claimRecheckRun(tx: TransactionSql, id: string, runId: string): Promise<boolean> {
  const rows = await tx`
    update profile_correction_requests
    set recheck_run_id = ${runId}, updated_at = now()
    where id = ${id} and status = 'sent' and (recheck_run_id is null or recheck_run_id = ${runId})
    returning id
  `;
  return rows.length > 0;
}

/** Close a sent correction with its recheck result (lifecycle only). */
export async function closeWithRecheckResult(
  tx: TransactionSql,
  id: string,
  args: { runId: string; resultId: string; result: string }
): Promise<boolean> {
  const rows = await tx`
    update profile_correction_requests
    set status = ${args.result}, recheck_result_id = ${args.resultId}, rechecked_at = now(), updated_at = now()
    where id = ${id} and status = 'sent' and recheck_run_id = ${args.runId}
    returning id
  `;
  return rows.length > 0;
}

/** Do these approved claims still exist in this project (any status)? */
export async function claimsInProject(tx: Tx, projectId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx`select id from claims where project_id = ${projectId} and id = any(${[...ids]}::uuid[])`;
  return new Set(rows.map((r) => r.id as string));
}

/** A source artifact's identity within a project. */
export async function sourceArtifactInProject(
  tx: Tx,
  projectId: string,
  id: string
): Promise<{ id: string; sha256: string; processingStatus: string } | null> {
  const [row] = await tx`
    select id, sha256, processing_status from source_artifacts where id = ${id} and project_id = ${projectId}
  `;
  return row
    ? { id: row.id as string, sha256: row.sha256 as string, processingStatus: (row.processingStatus as string) ?? "" }
    : null;
}

// ---------------------------------------------------------- reconciliation

export async function lockReconcile(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(${PROFILE_RECONCILE_LOCK_KEY})`;
}

export interface ReconcileRow {
  id: string;
  projectId: string;
  status: string;
  routedAt: Date | null;
  workflowRunId: string;
  destinationId: string | null;
  activeDraftId: string | null;
  contentRunState: string | null;
  contentApprovalId: string | null;
  contentApprovalDecision: string | null;
  contentApprovalDecidedBy: string | null;
  contentApprovalDecidedAt: Date | null;
  contentApprovalRationale: string | null;
  externalRunId: string | null;
  externalRunState: string | null;
  draftStatus: string | null;
  draftRunId: string | null;
  draftRunState: string | null;
  recheckRowId: string | null;
  recheckRowStatus: string | null;
  recheckRunId: string | null;
  recheckRunState: string | null;
  hasRecheckResult: boolean;
}

/**
 * Open requests whose awaited run can no longer progress, stalest first,
 * locked (skip locked: another reconciler takes the next ones). Healthy
 * requests are never selected.
 */
export async function reconcileCandidates(
  tx: TransactionSql,
  args: { projectId: string | null; limit: number; releaseTimeoutMinutes: number }
): Promise<ReconcileRow[]> {
  const stopped = [...STOPPED_RUN_STATES];
  const rows = await tx`
    select r.id, r.project_id, r.status, r.routed_at, r.workflow_run_id, r.destination_id, r.active_draft_id,
      cr.state as content_run_state,
      ca.id as content_approval_id, ca.decision as content_approval_decision,
      ca.decided_by as content_approval_decided_by, ca.decided_at as content_approval_decided_at,
      ca.rationale as content_approval_rationale,
      er.id as external_run_id, er.state as external_run_state,
      d.status as draft_status, dr.id as draft_run_id, dr.state as draft_run_state,
      q.id as recheck_row_id, q.status as recheck_row_status, qr.id as recheck_run_id, qr.state as recheck_run_state,
      (r.recheck_result_id is not null) as has_recheck_result
    from profile_correction_requests r
    left join workflow_runs cr on cr.id = r.workflow_run_id
    left join lateral (
      select a.id, a.decision, a.decided_by, a.decided_at, a.rationale
      from workflow_approvals a join node_runs n on n.id = a.node_run_id
      where a.workflow_run_id = r.workflow_run_id and n.node_key = ${PROFILE_CORRECTION_APPROVAL_NODE}
      order by a.requested_at desc limit 1
    ) ca on true
    left join workflow_runs er on r.destination_id is not null
      and er.idempotency_key = ${LIVE_RUN_KEY_PREFIX} || 'profile-external-approval:' || r.id || ':' || r.destination_id
    left join profile_correction_drafts d on d.id = r.active_draft_id
    left join workflow_runs dr on dr.idempotency_key = d.run_idempotency_key
    left join profile_check_requests q on q.kind = 'recheck' and q.correction_request_id = r.id
    left join workflow_runs qr on qr.idempotency_key = q.run_idempotency_key
    where (${args.projectId}::uuid is null or r.project_id = ${args.projectId})
      and (
        (r.status in ('awaiting_approval', 'approved') and cr.state = any(${stopped}::text[]))
        or (r.status = 'awaiting_external_approval' and (
              er.state = any(${stopped}::text[])
              or (er.id is null and r.routed_at < now() - make_interval(mins => ${args.releaseTimeoutMinutes}))))
        or (r.status = 'awaiting_send_confirmation' and dr.state = any(${stopped}::text[]))
        or (r.status = 'sent' and r.recheck_result_id is null and (
              (q.status = 'released' and qr.state = any(${stopped}::text[]))
              or q.status in ('failed', 'skipped')
              or q.id is null))
      )
    order by r.updated_at asc, r.id asc
    limit ${args.limit}
    for update of r skip locked
  `;
  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.projectId as string,
    status: r.status as string,
    routedAt: (r.routedAt as Date | null) ?? null,
    workflowRunId: r.workflowRunId as string,
    destinationId: (r.destinationId as string | null) ?? null,
    activeDraftId: (r.activeDraftId as string | null) ?? null,
    contentRunState: (r.contentRunState as string | null) ?? null,
    contentApprovalId: (r.contentApprovalId as string | null) ?? null,
    contentApprovalDecision: (r.contentApprovalDecision as string | null) ?? null,
    contentApprovalDecidedBy: (r.contentApprovalDecidedBy as string | null) ?? null,
    contentApprovalDecidedAt: (r.contentApprovalDecidedAt as Date | null) ?? null,
    contentApprovalRationale: (r.contentApprovalRationale as string | null) ?? null,
    externalRunId: (r.externalRunId as string | null) ?? null,
    externalRunState: (r.externalRunState as string | null) ?? null,
    draftStatus: (r.draftStatus as string | null) ?? null,
    draftRunId: (r.draftRunId as string | null) ?? null,
    draftRunState: (r.draftRunState as string | null) ?? null,
    recheckRowId: (r.recheckRowId as string | null) ?? null,
    recheckRowStatus: (r.recheckRowStatus as string | null) ?? null,
    recheckRunId: (r.recheckRunId as string | null) ?? null,
    recheckRunState: (r.recheckRunState as string | null) ?? null,
    hasRecheckResult: Boolean(r.hasRecheckResult),
  }));
}

/** A send that was never confirmed: back to ready, the draft no longer active. */
export async function reopenForDrafting(tx: TransactionSql, id: string): Promise<boolean> {
  const rows = await tx`
    update profile_correction_requests
    set status = 'ready_to_draft', active_draft_id = null, updated_at = now()
    where id = ${id} and status = 'awaiting_send_confirmation'
    returning id
  `;
  return rows.length > 0;
}

export async function failReleasedRecheck(tx: TransactionSql, id: string, reason: string): Promise<boolean> {
  const rows = await tx`
    update profile_check_requests set status = ${PROFILE_CHECK_STATUS.failed}, reason = ${reason}
    where id = ${id} and status = ${PROFILE_CHECK_STATUS.released}
    returning id
  `;
  return rows.length > 0;
}

/** Withdrawal: a queued recheck of the request will never run. */
export async function skipQueuedRecheck(tx: TransactionSql, correctionRequestId: string, reason: string): Promise<number> {
  const rows = await tx`
    update profile_check_requests set status = ${PROFILE_CHECK_STATUS.skipped}, reason = ${reason}
    where kind = 'recheck' and correction_request_id = ${correctionRequestId} and status = ${PROFILE_CHECK_STATUS.queued}
    returning id
  `;
  return rows.length;
}

/** Runs linked to a request that are still waiting or running. */
export async function openRunsForCorrection(tx: Tx, correctionRequestId: string): Promise<{ id: string; state: string }[]> {
  const rows = await tx`
    select distinct w.id, w.state from profile_correction_requests r
    join workflow_runs w on (
      w.id = r.workflow_run_id
      or w.idempotency_key like ${LIVE_RUN_KEY_PREFIX} || 'profile-external-approval:' || r.id || ':%'
      or w.idempotency_key in (select run_idempotency_key from profile_correction_drafts where correction_request_id = r.id)
      or w.idempotency_key = ${LIVE_RUN_KEY_PREFIX} || 'profile-recheck:' || r.id
    )
    where r.id = ${correctionRequestId}
      and w.state not in ('completed', 'failed', 'cancelled', 'safely_stopped', 'timed_out', 'partially_completed')
  `;
  return rows.map((r) => ({ id: r.id as string, state: r.state as string }));
}

/** The retry created for an uncertain attempt, if any (one per attempt). */
export async function retryOfAttempt(tx: Tx, draftAttemptId: string): Promise<DraftRow | null> {
  const [row] = await tx`
    select ${tx.unsafe(DRAFT_SELECT)} from profile_correction_drafts where retry_of = ${draftAttemptId}
  `;
  return row ? toDraft(row) : null;
}

export async function insertRetryAttempt(
  tx: TransactionSql,
  input: {
    id: string;
    projectId: string;
    correctionRequestId: string;
    destinationId: string;
    requestSha256: string;
    runIdempotencyKey: string;
    retryOf: string;
    requestedBy: string;
    reason: string;
  }
): Promise<boolean> {
  const rows = await tx`
    insert into profile_correction_drafts (
      id, project_id, correction_request_id, destination_id, request_sha256, attempt, run_idempotency_key,
      retry_of, retry_requested_by, retry_reason
    ) values (
      ${input.id}, ${input.projectId}, ${input.correctionRequestId}, ${input.destinationId}, ${input.requestSha256},
      (select coalesce(max(attempt), 0) + 1 from profile_correction_drafts where correction_request_id = ${input.correctionRequestId}),
      ${input.runIdempotencyKey}, ${input.retryOf}, ${input.requestedBy}, ${input.reason}
    )
    on conflict do nothing
    returning id
  `;
  return rows.length > 0;
}
