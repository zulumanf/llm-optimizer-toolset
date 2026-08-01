/**
 * Pure pipeline-transition rules (spec 032). The service enforces these
 * inside a transaction; tests exercise them directly.
 */
import {
  ALL_PROSPECT_STAGES,
  CONFLICT_GATE_STAGE,
  CONFLICT_STATUSES_ALLOWING_PROGRESS,
  CONTACT_GATE_STAGE,
  PROSPECT_STAGES,
  type ConflictStatus,
  type ProspectStage,
} from "@/lib/prospects/constants";

export interface TransitionContext {
  fromStage: ProspectStage;
  toStage: ProspectStage;
  conflictStatus: ConflictStatus;
  doNotContact: boolean;
}

export type TransitionVerdict =
  | { allowed: true; requiresConflictCheck: boolean }
  | { allowed: false; reason: string; overridable: boolean };

function ladderIndex(stage: ProspectStage): number {
  return (PROSPECT_STAGES as readonly string[]).indexOf(stage);
}

/** Is `stage` at or past `gate` on the ordered ladder? Exit stages are not. */
export function atOrPast(stage: ProspectStage, gate: ProspectStage): boolean {
  const s = ladderIndex(stage);
  const g = ladderIndex(gate);
  return s >= 0 && g >= 0 && s >= g;
}

/**
 * Validate a transition. `requiresConflictCheck` tells the service to run a
 * fresh exclusivity check when the prospect crosses the conflict gate with a
 * stale/unchecked status — the service records the check and re-validates.
 */
export function validateTransition(ctx: TransitionContext): TransitionVerdict {
  if (!ALL_PROSPECT_STAGES.includes(ctx.toStage)) {
    return { allowed: false, reason: `Unknown stage "${ctx.toStage}".`, overridable: false };
  }
  if (ctx.fromStage === ctx.toStage) {
    return { allowed: false, reason: "The prospect is already in that stage.", overridable: false };
  }

  const crossesConflictGate =
    atOrPast(ctx.toStage, CONFLICT_GATE_STAGE) &&
    !atOrPast(ctx.fromStage, CONFLICT_GATE_STAGE);

  if (atOrPast(ctx.toStage, CONTACT_GATE_STAGE) && ctx.doNotContact) {
    return {
      allowed: false,
      reason: "This prospect is flagged do-not-contact; contact stages are closed.",
      overridable: false,
    };
  }

  if (atOrPast(ctx.toStage, CONFLICT_GATE_STAGE)) {
    // A recorded admin override stands; everything else gets a fresh check
    // when crossing the gate (or when no check was ever recorded).
    if (ctx.conflictStatus !== "override" && (crossesConflictGate || ctx.conflictStatus === "unchecked")) {
      return { allowed: true, requiresConflictCheck: true };
    }
    if (!CONFLICT_STATUSES_ALLOWING_PROGRESS.includes(ctx.conflictStatus)) {
      return {
        allowed: false,
        reason: `Exclusivity conflict (${ctx.conflictStatus}) blocks progression past ${CONFLICT_GATE_STAGE}.`,
        overridable: true,
      };
    }
  }

  return { allowed: true, requiresConflictCheck: false };
}
