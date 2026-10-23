/**
 * Spec 147 §3.2 — start profile checks for one project, or for every live
 * engagement on the weekly schedule. Starting never launches a run: it
 * queues one durable profile_check_requests row per eligible confirmed URL
 * and kicks the bounded dispatcher, which releases them under the global
 * inference limit. Operator and schedule share this one path.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  enqueueDispatchJob,
  insertCheckRequest,
  openCorrectionUrls,
  profileCheckPreconditions,
} from "@/db/profile-corrections";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import {
  assertCanWrite,
  assertProjectAccess,
  assertRole,
  systemUser,
  type CurrentUser,
} from "@/lib/auth";
import { weekStart } from "@/lib/cycles/service";
import { listLiveEngagements } from "@/lib/engagements/service";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  PROFILE_CHECK_BLOCK,
  PROFILE_CHECK_ORIGINS,
  PROFILE_CHECK_SKIP,
  PROFILE_CORRECTIONS_DISABLED_MESSAGE,
  profileCheckRunKey,
  profileCorrectionsEnabled,
  type ProfileCheckBlockReason,
  type ProfileCheckOrigin,
  type ProfileCheckSkipReason,
} from "@/lib/profile-corrections/constants";
import { reconcileProfileCorrections } from "@/lib/profile-corrections/reconcile";
import { listConfirmedProfileUrls } from "@/lib/profile-corrections/urls";

const ACTIVE_PROJECT_STATUS = "active";
const WEEK_WINDOW_PREFIX = "week:";
const DAY_WINDOW_PREFIX = "day:";

const startSchema = z.object({
  projectId: z.string().uuid(),
  origin: z.enum(PROFILE_CHECK_ORIGINS),
});

export interface QueuedProfileCheck {
  checkRequestId: string;
  contextItemId: string;
  profileUrl: string;
}

export interface SkippedProfileCheck {
  contextItemId: string | null;
  profileUrl: string | null;
  reason: ProfileCheckSkipReason;
  detail?: string;
}

export interface StartProfileChecksResult {
  projectId: string;
  origin: ProfileCheckOrigin;
  window: string;
  status: "queued" | "nothing_queued" | "blocked";
  blockedReason: ProfileCheckBlockReason | null;
  queued: QueuedProfileCheck[];
  skipped: SkippedProfileCheck[];
}

/**
 * The duplicate-suppression window: one check per profile per ISO week on the
 * schedule, per UTC day for an operator. Prefixed so a Monday operator check
 * never collides with that week's scheduled one.
 */
export function profileCheckWindow(origin: ProfileCheckOrigin, now = new Date()): string {
  return origin === "schedule"
    ? `${WEEK_WINDOW_PREFIX}${weekStart(now)}`
    : `${DAY_WINDOW_PREFIX}${now.toISOString().slice(0, 10)}`;
}

function blockedReasonFor(pre: {
  projectStatus: string | null;
  hasLiveEngagement: boolean;
  approvedClaims: number;
}): ProfileCheckBlockReason | null {
  if (pre.projectStatus !== ACTIVE_PROJECT_STATUS) return PROFILE_CHECK_BLOCK.projectInactive;
  if (!pre.hasLiveEngagement) return PROFILE_CHECK_BLOCK.noLiveEngagement;
  // With no approved facts, compare can only answer "no contradictions" —
  // a false clean profile. Refuse rather than record it.
  if (pre.approvedClaims === 0) return PROFILE_CHECK_BLOCK.noApprovedFacts;
  return null;
}

export async function startProfileChecks(
  user: CurrentUser,
  raw: unknown,
  now: Date = new Date()
): Promise<ActionResult<StartProfileChecksResult>> {
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const { projectId, origin } = parsed.data;

  try {
    if (origin === "operator") {
      assertRole(user, "operator");
      await assertProjectAccess(user, projectId);
    } else {
      assertCanWrite(user);
    }
    // Spec 158: opt-in; refused after the authorization gate.
    if (!profileCorrectionsEnabled()) {
      throw new ClassifiedError("conflict", PROFILE_CORRECTIONS_DISABLED_MESSAGE);
    }

    const window = profileCheckWindow(origin, now);
    const result: StartProfileChecksResult = {
      projectId,
      origin,
      window,
      status: "nothing_queued",
      blockedReason: null,
      queued: [],
      skipped: [],
    };

    const blocked = blockedReasonFor(await profileCheckPreconditions(projectId));
    if (blocked) {
      result.status = "blocked";
      result.blockedReason = blocked;
      if (origin === "operator") await audit(user, result);
      return ok(result);
    }

    // Free profiles whose correction can never progress (spec 147 §8.4).
    await reconcileProfileCorrections({ projectId });

    const { urls, skipped } = await listConfirmedProfileUrls(projectId);
    for (const s of skipped) {
      result.skipped.push({ contextItemId: s.contextItemId, profileUrl: s.sourceRef, reason: s.reason });
    }
    if (urls.length === 0) {
      result.skipped.push({
        contextItemId: null,
        profileUrl: null,
        reason: PROFILE_CHECK_SKIP.noConfirmedProfiles,
      });
      log("info", "profile_checks.no_profiles", { projectId, origin });
      if (origin === "operator") await audit(user, result);
      return ok(result);
    }

    // A profile whose correction is still open is not checked again: the
    // open request (and later its recheck) owns that profile.
    const open = await openCorrectionUrls(sql, projectId);
    for (const url of urls) {
      if (open.has(url.profileUrl)) {
        result.skipped.push({
          contextItemId: url.contextItemId,
          profileUrl: url.profileUrl,
          reason: PROFILE_CHECK_SKIP.openCorrection,
        });
        continue;
      }
      // One URL failing to queue must not stop the others.
      try {
        const checkRequestId = randomUUID();
        const inserted = await insertCheckRequest(sql, {
          id: checkRequestId,
          projectId,
          contextItemId: url.contextItemId,
          profileUrl: url.profileUrl,
          origin,
          windowKey: window,
          runIdempotencyKey: profileCheckRunKey(projectId, checkRequestId),
          requestedBy: user.id,
        });
        if (inserted) {
          result.queued.push({ checkRequestId, contextItemId: url.contextItemId, profileUrl: url.profileUrl });
        } else {
          result.skipped.push({
            contextItemId: url.contextItemId,
            profileUrl: url.profileUrl,
            reason: PROFILE_CHECK_SKIP.alreadyRequested,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        log("warn", "profile_checks.queue_failed", { projectId, contextItemId: url.contextItemId, error: message });
        result.skipped.push({
          contextItemId: url.contextItemId,
          profileUrl: url.profileUrl,
          reason: PROFILE_CHECK_SKIP.queueFailed,
          detail: message,
        });
      }
    }

    if (result.queued.length > 0) {
      result.status = "queued";
      await enqueueDispatchJob(sql, 0);
    }
    // The schedule re-runs every tick; only real work is worth an audit row.
    if (origin === "operator" || result.queued.length > 0) await audit(user, result);
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

async function audit(user: CurrentUser, result: StartProfileChecksResult): Promise<void> {
  await sql.begin((tx) =>
    writeAudit(tx, {
      userId: user.id,
      action: "profile_checks.queued",
      entity: "project",
      entityId: result.projectId,
      projectId: result.projectId,
      detail: {
        origin: result.origin,
        window: result.window,
        status: result.status,
        blockedReason: result.blockedReason,
        queued: result.queued.length,
        skipped: result.skipped.map((s) => ({ contextItemId: s.contextItemId, reason: s.reason })),
      },
    })
  );
}

export interface WeeklyProfileChecksSummary {
  projects: number;
  queued: number;
  blocked: number;
  failed: number;
}

/**
 * The weekly schedule (runWeeklyKick): every live engagement's project goes
 * through the same startProfileChecks path. One client failing never stops
 * another's. The per-week window makes repeated ticks no-ops.
 */
export async function startWeeklyProfileChecks(now: Date = new Date()): Promise<WeeklyProfileChecksSummary> {
  const system = await systemUser();
  const projectIds = [...new Set((await listLiveEngagements()).map((e) => e.projectId))];
  const summary: WeeklyProfileChecksSummary = { projects: projectIds.length, queued: 0, blocked: 0, failed: 0 };
  for (const projectId of projectIds) {
    try {
      const result = await startProfileChecks(system, { projectId, origin: "schedule" }, now);
      if (!result.ok) {
        summary.failed += 1;
        log("warn", "profile_checks.weekly_start_failed", { projectId, error: result.error.message });
        continue;
      }
      summary.queued += result.data.queued.length;
      if (result.data.status === "blocked") summary.blocked += 1;
    } catch (err) {
      summary.failed += 1;
      log("warn", "profile_checks.weekly_start_failed", {
        projectId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return summary;
}
