/**
 * Autonomous fulfillment lane (spec 137): lane modes, the explicit state
 * machine over the spec 129 handoff row, the send-intent identity, the
 * founder's operator view, and the reconstruction/metrics readers.
 *
 * Preparation authority is broad (verify, compile, publish, QA); send
 * authority is narrow (release policy + canonical gate). The lane mode
 * decides only the last step. Nothing here transmits.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { logActivity } from "@/lib/prospects/shared";
import type { AutonomyClass } from "@/lib/prospects/reply-preprocess";

// ------------------------------------------------------------------ modes

export const LANE_MODES = ["SHADOW", "CANARY", "NARROW_AUTONOMOUS", "MANUAL_ONLY"] as const;
export type LaneMode = (typeof LANE_MODES)[number];
export const DEFAULT_LANE_MODE: LaneMode = "SHADOW";
export const DEFAULT_CANARY_PERCENT = 10;

export const RELEASE_POLICIES = ["report_and_video", "report_only"] as const;
export type ReleasePolicy = (typeof RELEASE_POLICIES)[number];
/** Fail closed toward the intended experiment: a handoff waits for a
 * releasable video walkthrough unless the policy explicitly says report_only. */
export const DEFAULT_RELEASE_POLICY: ReleasePolicy = "report_and_video";

/** A founder-recorded, audited per-handoff exception wins over the global
 * policy (e.g. one prospect gets the report without a walkthrough). It
 * never widens autonomy: the lane mode still decides transmission. */
export function effectiveReleasePolicy(cfg: Pick<LaneConfig, "releasePolicy">, override: string | null | undefined): ReleasePolicy {
  return override && (RELEASE_POLICIES as readonly string[]).includes(override) ? (override as ReleasePolicy) : cfg.releasePolicy;
}

export interface LaneConfig {
  mode: LaneMode;
  canaryPercent: number;
  killSwitch: boolean;
  releasePolicy: ReleasePolicy;
  source: string;
}

/** Explicit config wins; the legacy spec 129 opt-in maps to the narrow
 * lane; otherwise SHADOW. The kill switch never changes the mode label —
 * it forbids transmission on top of it. */
export function resolveLaneConfig(env: Record<string, string | undefined> = process.env): LaneConfig {
  const killSwitch = env.AUTONOMOUS_POSITIVE_REPLY_KILL_SWITCH === "true";
  const pct = Number(env.AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT ?? DEFAULT_CANARY_PERCENT);
  const canaryPercent = Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.floor(pct))) : DEFAULT_CANARY_PERCENT;
  const rawPolicy = (env.FULFILLMENT_RELEASE_POLICY ?? "").toLowerCase();
  const releasePolicy: ReleasePolicy = (RELEASE_POLICIES as readonly string[]).includes(rawPolicy) ? (rawPolicy as ReleasePolicy) : DEFAULT_RELEASE_POLICY;
  const raw = (env.AUTONOMOUS_POSITIVE_REPLY_MODE ?? "").toUpperCase();
  if ((LANE_MODES as readonly string[]).includes(raw)) return { mode: raw as LaneMode, canaryPercent, killSwitch, releasePolicy, source: "AUTONOMOUS_POSITIVE_REPLY_MODE" };
  if (env.REPORT_HANDOFF_AUTOSEND === "true") return { mode: "NARROW_AUTONOMOUS", canaryPercent, killSwitch, releasePolicy, source: "REPORT_HANDOFF_AUTOSEND=true (legacy opt-in)" };
  return { mode: DEFAULT_LANE_MODE, canaryPercent, killSwitch, releasePolicy, source: "default" };
}

/** Deterministic 0–99 bucket for canary selection. */
export function canaryBucket(handoffId: string): number {
  return parseInt(createHash("sha256").update(handoffId).digest("hex").slice(0, 8), 16) % 100;
}

export type ReleaseAction = "transmit" | "hold_shadow" | "manual_only";
export interface ReleaseDecision { action: ReleaseAction; autoVerdict: "transmit" | "would_send" | "escalated"; detail: string }

/** The release policy, after every gate has passed. */
export function releaseDecision(cfg: LaneConfig, handoffId: string): ReleaseDecision {
  if (cfg.killSwitch) return { action: "hold_shadow", autoVerdict: "would_send", detail: "kill switch on: all gates passed; not transmitted" };
  switch (cfg.mode) {
    case "MANUAL_ONLY":
      return { action: "manual_only", autoVerdict: "escalated", detail: "lane MANUAL_ONLY: founder sends" };
    case "SHADOW":
      return { action: "hold_shadow", autoVerdict: "would_send", detail: "SHADOW: all gates passed; would have sent" };
    case "CANARY": {
      const b = canaryBucket(handoffId);
      return b < cfg.canaryPercent
        ? { action: "transmit", autoVerdict: "transmit", detail: `CANARY: bucket ${b} < ${cfg.canaryPercent}%` }
        : { action: "hold_shadow", autoVerdict: "would_send", detail: `CANARY: bucket ${b} >= ${cfg.canaryPercent}%; held` };
    }
    case "NARROW_AUTONOMOUS":
      return { action: "transmit", autoVerdict: "transmit", detail: "NARROW_AUTONOMOUS: all gates passed" };
  }
}

// ---------------------------------------------------------- state machine

export const HANDOFF_STATUSES = [
  "pending", "autonomy_eligible", "evidence_verified", "report_published", "qa_passed",
  "release_ready", "scheduled", "sent", "needs_review", "stopped",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** Explicit transitions. `needs_review` leaves only by a founder's
 * reactivation (back to the eligibility check) or a stop. */
export const LANE_TRANSITIONS: Record<HandoffStatus, readonly HandoffStatus[]> = {
  pending: ["autonomy_eligible", "needs_review", "stopped"],
  autonomy_eligible: ["evidence_verified", "needs_review", "stopped"],
  evidence_verified: ["report_published", "needs_review", "stopped"],
  report_published: ["qa_passed", "needs_review", "stopped"],
  qa_passed: ["release_ready", "needs_review", "stopped"],
  // release_ready → qa_passed: the release policy gained a dependency the
  // artifacts no longer satisfy (WAITING_FOR_VIDEO); the report stays ready.
  release_ready: ["scheduled", "qa_passed", "needs_review", "stopped"],
  scheduled: ["sent", "needs_review", "stopped"],
  needs_review: ["autonomy_eligible", "stopped"],
  sent: [],
  stopped: [],
};
export const TERMINAL_STATUSES: readonly HandoffStatus[] = ["sent", "stopped"];

export function canTransition(from: HandoffStatus, to: HandoffStatus): boolean {
  return LANE_TRANSITIONS[from].includes(to);
}
export function assertTransition(from: HandoffStatus, to: HandoffStatus): void {
  if (!canTransition(from, to)) {
    throw new ClassifiedError("validation", `Invalid fulfillment transition ${from} → ${to}.`);
  }
}

/** Conceptual state for operators; the DB keeps the compact status. */
export function conceptualState(h: { status: HandoffStatus; autoVerdict: string | null; reason: string | null }): string {
  switch (h.status) {
    case "pending": return "POSITIVE_REPLY_RECEIVED";
    case "autonomy_eligible": return "AUTONOMY_ELIGIBLE";
    case "evidence_verified": return "EVIDENCE_VERIFIED";
    case "report_published": return "REPORT_READY";
    case "qa_passed": return /^WAITING_FOR_VIDEO/.test(h.reason ?? "") ? "REPORT_READY_WAITING_FOR_VIDEO" : "SEMANTIC_QA_PASSED";
    case "release_ready": return h.autoVerdict === "would_send" ? "RELEASE_READY_SHADOW_HELD" : "RELEASE_READY";
    case "scheduled": return "SEND_INTENT_CREATED";
    case "sent": return "SENT_AWAITING_RESPONSE";
    case "needs_review": return /^(EVIDENCE|ENTITY)_/.test(h.reason ?? "") ? "EVIDENCE_BLOCKED" : /^RELEASE_/.test(h.reason ?? "") ? "RELEASE_BLOCKED" : "ESCALATED_TO_FOUNDER";
    case "stopped": return "FAILED_TERMINAL";
  }
}

// ------------------------------------------------------------ send intent

export const FULFILLMENT_MESSAGE_TYPES = ["positive_reply_report_delivery"] as const;
export type FulfillmentMessageType = (typeof FULFILLMENT_MESSAGE_TYPES)[number];

/** One logical external action = one identity: prospect + source reply +
 * evidence/manifest version + message type + template. */
export function sendIntentKey(i: { prospectId: string; replyId: string; manifestHash: string; messageType: FulfillmentMessageType; templateVersion: string; variant?: string }): string {
  return createHash("sha256").update([i.prospectId, i.replyId, i.manifestHash, i.messageType, i.templateVersion, i.variant ?? ""].join("|")).digest("hex");
}

/** The RFC 5322 Message-ID stamped on the outgoing mail — the fingerprint
 * reconciliation searches for (`rfc822msgid:`). Deterministic per intent. */
export function sendMessageIdFor(intentKey: string, senderDomain: string): string {
  return `<rf-${intentKey.slice(0, 32)}@${senderDomain}>`;
}

export function senderDomainOf(email: string | null | undefined, fallback = "recommendedfirst.com"): string {
  const at = (email ?? "").lastIndexOf("@");
  return at > 0 ? (email as string).slice(at + 1).toLowerCase() : fallback;
}

// ------------------------------------------------------------ video readiness

export interface VideoReleasability { releasable: boolean; artifactId: string | null; detail: string }

/** Is a releasable video walkthrough on file for this handoff? Delegates to
 * the video lane's own release recheck (stage release_ready, status ready,
 * current binding to the manifest, passed script/semantic/artifact QA, not
 * delivered, release switch open) — the ONE definition. A handoff held at
 * qa_passed may ask too. Any failure to answer is "not releasable". */
export async function videoReleasableFor(handoffId: string): Promise<VideoReleasability> {
  try {
    const { videoReleaseRecheck } = await import("@/lib/prospects/video-walkthrough");
    const r = await videoReleaseRecheck(handoffId, process.env, { handoffStatuses: ["qa_passed", "release_ready", "scheduled"] });
    return { releasable: r.passed, artifactId: r.artifactId, detail: r.detail };
  } catch (err) {
    return { releasable: false, artifactId: null, detail: `video lane unavailable: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}` };
  }
}

// ------------------------------------------------------------ operator view

export interface LaneHandoffView {
  status: HandoffStatus;
  reason: string | null;
  autonomyClass: AutonomyClass | null;
  autonomyReason: string | null;
  autoVerdict: string | null;
  laneMode: string | null;
  releaseVerdict: { verified?: boolean; reasons?: string[] } | null;
}

export interface OperatorView {
  prospect: string;
  reply: string;
  state: string;
  whyStopped: string | null;
  evidenceStatus: string;
  reportStatus: string;
  videoStatus: string;
  nextAction: string;
}

const ORDER = HANDOFF_STATUSES as readonly string[];
const atOrPast = (s: HandoffStatus, m: HandoffStatus): boolean => ORDER.indexOf(s) >= ORDER.indexOf(m) && s !== "needs_review" && s !== "stopped";

/** The concise founder view: no logs to dig through. */
export function operatorView(h: LaneHandoffView, ctx: { prospectName: string; replyExcerpt: string; reportPublished: boolean; videoStatus?: string }): OperatorView {
  const stopped = h.status === "needs_review" || h.status === "stopped";
  const evidenceStatus = h.releaseVerdict
    ? h.releaseVerdict.verified ? "verified (primary = shadow)" : `blocked: ${(h.releaseVerdict.reasons ?? []).join(", ")}`
    : atOrPast(h.status, "evidence_verified") ? "verified" : "not yet verified";
  const reportStatus = atOrPast(h.status, "report_published") || ctx.reportPublished ? "published over the frozen evidence" : "not published";
  let nextAction: string;
  switch (h.status) {
    case "needs_review": nextAction = h.autonomyClass === "escalate" ? "Read the reply and answer by hand (publish + reply)." : "Resolve the block, then reactivate or answer by hand."; break;
    case "qa_passed": nextAction = /^WAITING_FOR_VIDEO/.test(h.reason ?? "") ? "Report ready; waiting for a releasable video walkthrough before founder review." : "Awaiting the release policy."; break;
    case "stopped": nextAction = "No external response (terminal)."; break;
    case "release_ready": nextAction = h.autoVerdict === "would_send" ? "SHADOW: review the staged reply; send by hand if you agree." : "Awaiting release."; break;
    case "scheduled": nextAction = "Send intent created; dispatcher will transmit."; break;
    case "sent": nextAction = "Report delivered; own the conversation from here."; break;
    default: nextAction = "Automation in progress."; break;
  }
  return {
    prospect: ctx.prospectName,
    reply: ctx.replyExcerpt,
    state: conceptualState({ status: h.status, autoVerdict: h.autoVerdict, reason: h.reason }),
    whyStopped: stopped ? (h.reason ?? h.autonomyReason ?? "unspecified") : null,
    evidenceStatus,
    reportStatus,
    videoStatus: ctx.videoStatus ?? (/^WAITING_FOR_VIDEO/.test(h.reason ?? "") ? "not releasable yet (required by the release policy)" : "not part of this release policy"),
    nextAction,
  };
}

// ------------------------------------------------------------ DB readers

export const REVIEW_OVERRIDE_ACTION = "prospect.report_handoff_review_accepted";

/** Explicit founder reactivation: the only way out of needs_review that is
 * not a stop. Re-enters at the eligibility check — never past it. With
 * `acceptReviewConcerns`, the founder takes responsibility for the copy the
 * semantic reviewer blocked: the next pass records the reviewer's concerns
 * as accepted instead of re-asking the model. Evidence, manifest and
 * template assertions are deterministic and can never be accepted away. */
export async function reactivateHandoff(user: CurrentUser, handoffId: string, reason: string, opts: { acceptReviewConcerns?: boolean } = {}): Promise<void> {
  const [h] = await sql`select id, prospect_id, status, reason from prospect_report_handoffs where id = ${handoffId}`;
  if (!h) throw new ClassifiedError("not_found", "Handoff not found.");
  assertTransition(h.status as HandoffStatus, "autonomy_eligible");
  if (opts.acceptReviewConcerns && !/semantic review/.test((h.reason as string | null) ?? "")) {
    throw new ClassifiedError("validation", "Only a semantic-review block can be accepted; evidence and assertion blocks must be resolved.");
  }
  await sql.begin(async (tx) => {
    await tx`update prospect_report_handoffs set status = 'autonomy_eligible', reason = null, attempts = 0, auto_verdict = null,
      reactivated_at = now(), reactivated_by = ${user.id}, updated_at = now() where id = ${handoffId} and status = 'needs_review'`;
    await writeAudit(tx, { userId: user.id, action: "prospect.report_handoff_reactivated", entity: "prospect_report_handoff", entityId: handoffId, detail: { reason, acceptReviewConcerns: Boolean(opts.acceptReviewConcerns) } });
    if (opts.acceptReviewConcerns) {
      // Bound to the content hash the reviewer blocked: a revised report or
      // email is a new artifact and is reviewed again.
      const [blocked] = await tx`select content_hash from prospect_report_qa_runs where handoff_id = ${handoffId} and kind = 'release_review' and not passed order by created_at desc limit 1`;
      await writeAudit(tx, { userId: user.id, action: REVIEW_OVERRIDE_ACTION, entity: "prospect_report_handoff", entityId: handoffId, detail: { reason, blockedReason: h.reason, contentHash: (blocked?.contentHash as string | null) ?? null } });
    }
    await logActivity(tx, h.prospectId as string, "report_handoff_reactivated", { handoffId, reason, acceptReviewConcerns: Boolean(opts.acceptReviewConcerns) }, user.id);
  });
}

/** The founder's standing acceptance of the reviewer's concerns for this
 * handoff, if recorded after the reviewer's latest block. */
export async function reviewOverrideFor(handoffId: string, contentHash: string): Promise<{ userId: string; reason: string; at: Date } | null> {
  const [row] = await sql`
    select a.user_id, a.detail->>'reason' as reason, a.at from audit_log a
    where a.action = ${REVIEW_OVERRIDE_ACTION} and a.entity_id = ${handoffId} and a.detail->>'contentHash' = ${contentHash}
    order by a.at desc limit 1`;
  return row ? { userId: row.userId as string, reason: (row.reason as string) ?? "", at: new Date(row.at as Date) } : null;
}

export interface FulfillmentMetrics {
  positiveReplies: number;
  autonomyEligible: number;
  autonomyIneligible: number;
  escalated: number;
  evidenceBlocked: number;
  entityBlocked: number;
  primaryShadowDisagreement: number;
  pendingCorrectionBlocked: number;
  artifactGenerationFailure: number;
  shadowWouldSend: number;
  autonomousSends: number;
  duplicateActionPrevented: number;
  sendReconciliationRequired: number;
  medianReplyToDeliveryMinutes: number | null;
}

/** Counts, not scores. Every number is a row count over the ledgers. */
export async function fulfillmentMetrics(since: Date): Promise<FulfillmentMetrics> {
  const [r] = await sql`
    with h as (select * from prospect_report_handoffs where created_at >= ${since})
    select
      (select count(*) from prospect_replies where classification = 'positive_interest' and received_at >= ${since}) as positive_replies,
      (select count(*) from h where autonomy_class = 'autonomy_eligible') as autonomy_eligible,
      (select count(*) from h where autonomy_class = 'escalate') as autonomy_ineligible,
      (select count(*) from h where status = 'needs_review') as escalated,
      (select count(*) from h where status = 'needs_review' and reason like 'EVIDENCE_RELEASE_BLOCKED%') as evidence_blocked,
      (select count(*) from h where status = 'needs_review' and reason ~ 'ENTITY_UNVERIFIED|AMBIGUOUS_IDENTITY|ENTITY_LEVEL_MISMATCH') as entity_blocked,
      (select count(*) from h where status = 'needs_review' and reason ~ 'PRIMARY_SHADOW_COUNT_MISMATCH|DENOMINATOR_MISMATCH') as primary_shadow_disagreement,
      (select count(*) from h where status = 'needs_review' and reason like '%PENDING_CORRECTION%') as pending_correction_blocked,
      (select count(*) from h where status = 'needs_review' and reason ~ '^(publish refused|ARTIFACT_)') as artifact_generation_failure,
      (select count(*) from h where auto_verdict = 'would_send') as shadow_would_send,
      (select count(*) from h where auto_verdict = 'transmit' and status = 'sent') as autonomous_sends,
      (select count(*) from audit_log where action = 'prospect.fulfillment_duplicate_prevented' and at >= ${since}) as duplicate_action_prevented,
      (select count(*) from prospect_outreach_sends where reconciled_from is not null and sent_at >= ${since}) as send_reconciliation_required,
      (select percentile_cont(0.5) within group (order by extract(epoch from (s.sent_at - r.received_at)) / 60)
         from h join prospect_replies r on r.id = h.reply_id join outreach_drafts d on d.id = h.draft_id
         join prospect_outreach_sends s on s.draft_id = d.id and s.allowed where h.status = 'sent') as median_minutes
  `;
  const n = (v: unknown): number => Number(v ?? 0);
  return {
    positiveReplies: n(r!.positiveReplies), autonomyEligible: n(r!.autonomyEligible), autonomyIneligible: n(r!.autonomyIneligible),
    escalated: n(r!.escalated), evidenceBlocked: n(r!.evidenceBlocked), entityBlocked: n(r!.entityBlocked),
    primaryShadowDisagreement: n(r!.primaryShadowDisagreement), pendingCorrectionBlocked: n(r!.pendingCorrectionBlocked),
    artifactGenerationFailure: n(r!.artifactGenerationFailure), shadowWouldSend: n(r!.shadowWouldSend), autonomousSends: n(r!.autonomousSends),
    duplicateActionPrevented: n(r!.duplicateActionPrevented), sendReconciliationRequired: n(r!.sendReconciliationRequired),
    medianReplyToDeliveryMinutes: r!.medianMinutes === null || r!.medianMinutes === undefined ? null : Number(r!.medianMinutes),
  };
}

/** Everything behind one autonomous action, from the reply to the provider
 * message id. Reads only; secrets are never selected. */
export async function reconstructFulfillment(handoffId: string): Promise<Record<string, unknown> | null> {
  const [h] = await sql`select * from prospect_report_handoffs where id = ${handoffId}`;
  if (!h) return null;
  const [reply, manifest, artifacts, qa, draft, send] = await Promise.all([
    sql`select id, classification, classifier_version, received_at, gmail_message_id from prospect_replies where id = ${h.replyId}`,
    h.manifestId ? sql`select id, version, evidence_hash, manifest_hash, manifest::text as manifest_text, created_at from prospect_fact_manifests where id = ${h.manifestId}` : Promise.resolve([]),
    sql`select id, kind, revision, template_version, ref_audit_id, ref_draft_id, content_hash, status, stale_reason, created_at from prospect_fulfillment_artifacts where handoff_id = ${handoffId} order by created_at`,
    sql`select kind, content_hash, passed, agent_version, model, error, created_at from prospect_report_qa_runs where handoff_id = ${handoffId} order by created_at`,
    h.draftId ? sql`select id, prompt_version, send_intent_key, send_message_id, scheduled_send_at, sent_recorded_at from outreach_drafts where id = ${h.draftId}` : Promise.resolve([]),
    h.draftId ? sql`select id, body_hash, provider_message_id, gmail_thread_id, sent_at, allowed, gate_verdict, reconciled_from from prospect_outreach_sends where draft_id = ${h.draftId} order by sent_at` : Promise.resolve([]),
  ]);
  return {
    handoff: { id: h.id, status: h.status, reason: h.reason, laneMode: h.laneMode, autonomyClass: h.autonomyClass, autonomyReason: h.autonomyReason, autoVerdict: h.autoVerdict, releaseVerdict: h.releaseVerdict, createdAt: h.createdAt, updatedAt: h.updatedAt },
    reply: reply[0] ?? null,
    manifest: manifest[0] ? { ...manifest[0], manifest: JSON.parse(manifest[0].manifestText as string) as unknown, manifestText: undefined } : null,
    artifacts,
    qaRuns: qa,
    sendIntent: draft[0] ?? null,
    sends: send,
  };
}
