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
  INFERENCE_ACTIVE_RUN_STATES,
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
  contextItemId: string;
  profileUrl: string;
  origin: "operator" | "schedule";
  windowKey: string;
  projectStatus: string | null;
}

/** Oldest due queued checks, locked for this transaction. */
export async function claimDueChecks(tx: TransactionSql, limit: number): Promise<DueCheckRequest[]> {
  if (limit <= 0) return [];
  const rows = await tx`
    select q.id, q.project_id, q.context_item_id, q.profile_url, q.origin, q.window_key,
      p.status as project_status
    from profile_check_requests q
    left join projects p on p.id = q.project_id
    where q.status = ${PROFILE_CHECK_STATUS.queued}
      and q.kind = ${PROFILE_CHECK_KIND.check}
      and q.not_before <= now()
    order by q.not_before asc, q.created_at asc, q.id asc
    limit ${limit}
    for update of q skip locked
  `;
  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.projectId as string,
    contextItemId: r.contextItemId as string,
    profileUrl: r.profileUrl as string,
    origin: r.origin as "operator" | "schedule",
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
        and kind = ${PROFILE_CHECK_KIND.check}
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
