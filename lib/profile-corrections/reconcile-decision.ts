/**
 * Spec 147 §8.4 — what reconciliation does with one open correction. Pure.
 *
 * A request is only moved when the run it is waiting on can never progress
 * (a stopped run state, or a start that never happened past the release
 * timeout). Nothing here ever infers success:
 *
 *   awaiting_approval + content run stopped
 *       → rejected (when the human rejected it) or expired
 *   approved + content run stopped before routing          → expired
 *   awaiting_external_approval + authorization run stopped,
 *       or never started                                    → destination_required
 *   awaiting_send_confirmation + draft run stopped
 *       → ready_to_draft, and the created draft attempt becomes
 *         outcome_unknown (the draft may or may not have been sent; only an
 *         operator can resolve that, and nothing retries it automatically)
 *   sent + no recheck result, and the recheck run stopped or the recheck
 *       could not be released                               → needs_review
 *
 * Everything else — a run still waiting or running, a destination still
 * missing, a healthy queued recheck — is left untouched. A combination that
 * should be impossible (a completed run with no outcome) is reported as an
 * anomaly for an operator, never resolved.
 */
import {
  PROFILE_CORRECTION_STATUS,
  RECONCILE_REASON,
  STOPPED_RUN_STATES,
  type ReconcileReason,
} from "@/lib/profile-corrections/constants";

export interface ReconcileSnapshot {
  status: string;
  /** The check run that built (and gates) the request. */
  contentRunState: string | null;
  contentApprovalDecision: string | null;
  routedAt: Date | null;
  /** The publisher authorization run for the current destination, if any. */
  externalRunState: string | null;
  /** The active draft attempt's run, when awaiting send confirmation. */
  draftRunState: string | null;
  draftAttemptStatus: string | null;
  /** The recheck queue row and its run, when sent. */
  recheckRowStatus: string | null;
  recheckRunState: string | null;
  hasRecheckResult: boolean;
}

export type ReconcileDecision =
  | { action: "none" }
  | { action: "anomaly"; note: string }
  | {
      action: "move";
      to: string;
      reason: ReconcileReason;
      /** The active draft attempt becomes outcome_unknown. */
      draftOutcomeUnknown?: boolean;
      /** The released recheck row is closed as failed. */
      failRecheckRow?: boolean;
    };

const stopped = (state: string | null): boolean =>
  state !== null && (STOPPED_RUN_STATES as readonly string[]).includes(state);

export function reconciliationDecision(
  s: ReconcileSnapshot,
  now: Date,
  releaseTimeoutMinutes: number
): ReconcileDecision {
  const S = PROFILE_CORRECTION_STATUS;
  switch (s.status) {
    case S.awaitingApproval:
      if (stopped(s.contentRunState)) {
        return s.contentApprovalDecision === "rejected"
          ? { action: "move", to: S.rejected, reason: RECONCILE_REASON.contentApprovalRejected }
          : { action: "move", to: S.expired, reason: RECONCILE_REASON.contentRunStopped };
      }
      return s.contentRunState === "completed"
        ? { action: "anomaly", note: "the content run completed but the request is still awaiting approval" }
        : { action: "none" };

    case S.approved:
      if (stopped(s.contentRunState)) {
        return { action: "move", to: S.expired, reason: RECONCILE_REASON.routingRunStopped };
      }
      return s.contentRunState === "completed"
        ? { action: "anomaly", note: "the content run completed without routing the approved request" }
        : { action: "none" };

    case S.awaitingExternalApproval: {
      if (stopped(s.externalRunState)) {
        return { action: "move", to: S.destinationRequired, reason: RECONCILE_REASON.externalRunStopped };
      }
      const neverStarted =
        s.externalRunState === null &&
        s.routedAt !== null &&
        now.getTime() - s.routedAt.getTime() > releaseTimeoutMinutes * 60_000;
      return neverStarted
        ? { action: "move", to: S.destinationRequired, reason: RECONCILE_REASON.externalRunNeverStarted }
        : { action: "none" };
    }

    case S.awaitingSendConfirmation:
      if (stopped(s.draftRunState)) {
        return {
          action: "move",
          to: S.readyToDraft,
          reason: RECONCILE_REASON.sendConfirmationStopped,
          draftOutcomeUnknown: s.draftAttemptStatus === "created",
        };
      }
      return { action: "none" };

    case S.sent:
      if (s.hasRecheckResult) return { action: "none" };
      if (s.recheckRowStatus === "released" && stopped(s.recheckRunState)) {
        return { action: "move", to: S.needsReview, reason: RECONCILE_REASON.recheckRunStopped, failRecheckRow: true };
      }
      if (s.recheckRowStatus === "failed" || s.recheckRowStatus === "skipped" || s.recheckRowStatus === null) {
        return { action: "move", to: S.needsReview, reason: RECONCILE_REASON.recheckNotReleased };
      }
      return { action: "none" };

    default:
      return { action: "none" };
  }
}
