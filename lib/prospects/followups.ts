/**
 * Competitive-mismatch follow-up sequences (spec 127). One row per
 * prospect per experiment carries the FROZEN Touch 1 evidence; Touch 2/3
 * are ordinary outreach_drafts rendered from that snapshot at most
 * FOLLOWUP_RENDER_LEAD_MINUTES before their recipient-local morning slot,
 * approved on behalf of the enrolling operator (the enrollment is the human
 * confirmation, PRINCIPLES #8), and transmitted by the existing gated
 * dispatcher. Every reply, bounce, DNC, suppression or exit stops the
 * sequence; preflight fails closed.
 */
import { latestEvidenceCorrection, type EvidenceCorrection } from "@/lib/prospects/evidence-corrections";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import * as connectors from "@/db/connectors";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { log } from "@/lib/logger";
import { executeCapability } from "@/lib/connectors/execute";
import type { ParsedGmailMessage } from "@/lib/connectors/adapters/google";
import { checkSuppression } from "@/lib/outreach/suppression";
import { stripQuotedReply } from "@/lib/prospects/reply-classify";
import {
  FOLLOWUP_CADENCE_BUSINESS_DAYS,
  FOLLOWUP_CATEGORY_LINE,
  FOLLOWUP_EXPERIMENT_ID,
  FOLLOWUP_MAX_SEQUENCE_AGE_DAYS,
  FOLLOWUP_OOO_PAUSE_DAYS,
  FOLLOWUP_RENDER_LEAD_MINUTES,
  FOLLOWUP_REPLY_SYNC_MAX_AGE_MINUTES,
  FOLLOWUP_SEND_WINDOW,
  FOLLOWUP_TEMPLATE_VERSIONS,
  FOLLOWUP_TEMPLATE_VERSION_LIST,
  GMAIL_DAILY_SEND_CAP,
  MISMATCH_TEMPLATE_VERSION,
  OUTREACH_PUBLIC_WEBSITE,
  PROSPECT_EXIT_STAGES,
  UNATTENDED_SEND_BLOCKED_STAGES,
  type FollowupTemplateVersion,
  type ProspectStage,
  type ReplyClassification,
} from "@/lib/prospects/constants";
import { CURRENT } from "@/lib/prospects/benchmark";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import {
  addBusinessDays,
  deterministicOffsetMinutes,
  nextMorningSlot,
  timezoneForState,
  wallClock,
  zonedInstant,
} from "@/lib/prospects/business-days";
import { evaluateEngagement, type EngagementState } from "@/lib/prospects/engagement-state";
import {
  CATEGORY_LINE_PREFIX,
  followupStartsNewThread,
  followupTemplateFor,
  lintFollowupCopy,
  qaFollowupEvidence,
  renderFollowup,
  type FollowupBranch,
  type FollowupQaContext,
  type ProspectEntityType,
} from "@/lib/prospects/followup-templates";
import { competitiveMismatchReview, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { prospectIntent } from "@/lib/prospects/dashboard";
import { logActivity } from "@/lib/prospects/shared";

export const SEQUENCE_STATUSES = ["active", "paused", "replied", "stopped", "complete"] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

export interface FollowupSequence {
  id: string;
  prospectId: string;
  experimentId: string;
  contactId: string | null;
  touch1DraftId: string;
  touch1SendId: string;
  /** Actual Gmail-accepted transmit time of Touch 1 — the cadence and the
   * 21-day expiry count from this, never from a draft or planned time. */
  touch1SentAt: Date;
  competitorCompanyId: string;
  /** Effective evidence (spec 130 correction overlaid); the stored row keeps
   * the frozen original. */
  evidenceSnapshot: MismatchEvidenceSnapshot;
  evidenceCorrection?: EvidenceCorrection | null;
  distinctCompetitorQuestions: number;
  timezone: string;
  status: SequenceStatus;
  stopReason: string | null;
  pausedUntil: Date | null;
  pauseReason: string | null;
  nextTouch: 2 | 3 | null;
  nextDueAt: Date | null;
  lastTouchSendId: string | null;
  enrolledBy: string;
}

const SEQ_COLUMNS = sql`
  id, prospect_id, experiment_id, contact_id, touch1_draft_id, touch1_send_id,
  (select s.sent_at from prospect_outreach_sends s where s.id = touch1_send_id) as touch1_sent_at,
  competitor_company_id, evidence_snapshot, distinct_competitor_questions, timezone,
  status, stop_reason, paused_until, pause_reason, next_touch, next_due_at,
  last_touch_send_id, enrolled_by
`;

function toSequence(r: Record<string, unknown>): FollowupSequence {
  return {
    id: r.id as string,
    prospectId: r.prospectId as string,
    experimentId: r.experimentId as string,
    contactId: (r.contactId as string | null) ?? null,
    touch1DraftId: r.touch1DraftId as string,
    touch1SendId: r.touch1SendId as string,
    touch1SentAt: new Date(r.touch1SentAt as Date),
    competitorCompanyId: r.competitorCompanyId as string,
    evidenceSnapshot: r.evidenceSnapshot as MismatchEvidenceSnapshot,
    evidenceCorrection: null,
    distinctCompetitorQuestions: Number(r.distinctCompetitorQuestions ?? 0),
    timezone: r.timezone as string,
    status: r.status as SequenceStatus,
    stopReason: (r.stopReason as string | null) ?? null,
    pausedUntil: r.pausedUntil ? new Date(r.pausedUntil as Date) : null,
    pauseReason: (r.pauseReason as string | null) ?? null,
    nextTouch: (r.nextTouch as 2 | 3 | null) ?? null,
    nextDueAt: r.nextDueAt ? new Date(r.nextDueAt as Date) : null,
    lastTouchSendId: (r.lastTouchSendId as string | null) ?? null,
    enrolledBy: r.enrolledBy as string,
  };
}

/** Load an active user as the actor for unattended bookkeeping. */
export async function userById(id: string): Promise<CurrentUser | null> {
  const [u] = await sql`select id, email, name, role from users where id = ${id} and active`;
  return u ? { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] } : null;
}

/** Spec 130: overlay the latest evidence correction for the sequence's
 * delivered Touch 1 so every reader (renderer, QA, handoff, report) states
 * corrected counts while the stored row keeps the frozen original. */
export function withEvidenceCorrection(seq: FollowupSequence, correction: EvidenceCorrection | null): FollowupSequence {
  if (!correction) return seq;
  return { ...seq, evidenceSnapshot: correction.correctedSnapshot, evidenceCorrection: correction };
}

async function overlayCorrection(seq: FollowupSequence): Promise<FollowupSequence> {
  return withEvidenceCorrection(seq, await latestEvidenceCorrection(seq.prospectId, seq.touch1SendId));
}

export async function getFollowupSequence(id: string): Promise<FollowupSequence | null> {
  const [row] = await sql`select ${SEQ_COLUMNS} from outreach_followup_sequences where id = ${id}`;
  return row ? overlayCorrection(toSequence(row)) : null;
}

export async function sequenceForProspect(
  prospectId: string,
  experimentId = FOLLOWUP_EXPERIMENT_ID
): Promise<FollowupSequence | null> {
  const [row] = await sql`
    select ${SEQ_COLUMNS} from outreach_followup_sequences
    where prospect_id = ${prospectId} and experiment_id = ${experimentId}
  `;
  return row ? overlayCorrection(toSequence(row)) : null;
}

// ------------------------------------------------------------ cadence

/** Local midnight of the calendar day `n` business days after `from`. The
 * touch may go any time in that day's morning window. */
export function dueDayStart(from: Date, n: number, tz: string): Date {
  const w = wallClock(addBusinessDays(from, n, tz), tz);
  return zonedInstant(w.year, w.month, w.day, 0, 0, tz);
}

export function slotFor(seq: Pick<FollowupSequence, "id" | "timezone">, earliest: Date): Date {
  return nextMorningSlot(earliest, {
    tz: seq.timezone,
    startHour: FOLLOWUP_SEND_WINDOW.startHour,
    offsetMinutes: deterministicOffsetMinutes(
      seq.id,
      FOLLOWUP_SEND_WINDOW.minOffsetMinutes,
      FOLLOWUP_SEND_WINDOW.maxOffsetMinutes
    ),
  });
}

/** Projected send instant for the next touch (null when nothing is due). */
export function projectedSlot(seq: FollowupSequence, now: Date): Date | null {
  if (seq.status !== "active" || !seq.nextDueAt) return null;
  const earliest = new Date(Math.max(seq.nextDueAt.getTime(), now.getTime()));
  return slotFor(seq, earliest);
}

/** The instant after which no cold touch may leave (calendar days from the
 * successful Touch 1). Pure. */
export function sequenceExpiresAt(touch1SentAt: Date): Date {
  return new Date(touch1SentAt.getTime() + FOLLOWUP_MAX_SEQUENCE_AGE_DAYS * 86_400_000);
}
export function sequenceExpired(touch1SentAt: Date, at: Date): boolean {
  return at.getTime() > sequenceExpiresAt(touch1SentAt).getTime();
}

// ------------------------------------------------------------ OOO parsing

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Deterministic return-date extraction from an autoresponder. Returns the
 * local midnight after the stated date, or null when no date is stated. */
export function parseOooReturnDate(text: string, now: Date, tz: string): Date | null {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  const ctx = t.match(/(?:return(?:ing)?|back|until|through|out of (?:the )?office (?:until|through))[^.\n]{0,40}/);
  if (!ctx) return null;
  const span = ctx[0];
  const nowW = wallClock(now, tz);
  let month: number | null = null;
  let day: number | null = null;
  const named = span.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})\b/);
  const numeric = span.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (named) {
    month = MONTHS.indexOf(named[1]!) + 1;
    day = Number(named[2]);
  } else if (numeric) {
    month = Number(numeric[1]);
    day = Number(numeric[2]);
  }
  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  let year = nowW.year;
  if (month < nowW.month || (month === nowW.month && day < nowW.day)) year += 1;
  const back = zonedInstant(year, month, day, 0, 0, tz);
  if (back.getTime() - now.getTime() > 120 * 86_400_000) return null;
  return new Date(back.getTime() + 86_400_000);
}

// ------------------------------------------------------------ enrollment

export async function marketTimezone(prospectId: string): Promise<{ tz: string; marketName: string }> {
  const [row] = await sql`
    select m.state_code, m.name as market_name
    from prospects p
    join market_launches l on l.id = p.launch_id
    join markets m on m.id = l.market_id
    where p.id = ${prospectId}
  `;
  return {
    tz: timezoneForState((row?.stateCode as string | null) ?? null),
    marketName: (row?.marketName as string | null) ?? "",
  };
}

/** Distinct frozen-run questions in which the competitor was recommended
 * (echo-excluded, current revision) — the "several questions" claim gate. */
export async function distinctCompetitorQuestions(snapshot: MismatchEvidenceSnapshot): Promise<number> {
  const [row] = await sql`
    select count(distinct r.prompt_id)::int as n
    from mentions m
    join responses r on r.id = m.response_id
    join companies c on c.id = m.company_id
    where r.run_id = ${snapshot.runId} and r.provider = ${snapshot.provider}
      and r.error is null
      and c.id = ${snapshot.competitor.companyId} and m.recommended
      and ${CURRENT} and ${PROMPT_ECHO_EXCLUDED}
  `;
  return Number(row?.n ?? 0);
}

export interface DeliveredTouch1 {
  sendId: string;
  draftId: string;
  contactId: string | null;
  sentAt: Date;
  body: string;
  subject: string | null;
  /** Effective evidence: the frozen snapshot with the latest spec 130
   * correction overlaid. What was SENT is `originalSnapshot`. */
  evidenceSnapshot: MismatchEvidenceSnapshot;
  originalSnapshot: MismatchEvidenceSnapshot;
  correction: EvidenceCorrection | null;
  /** Draft that carries the snapshot (the sent draft or an ancestor). */
  evidenceDraftId: string;
}

/** The newest Gmail-accepted mismatch Touch 1 for a prospect. The sent
 * draft may be a superseding rewrite (2026-08-31 em-dash edit) that carries
 * no template version or snapshot; the frozen evidence is taken from the
 * nearest ancestor that does, and the sent body must still state it. */
export async function deliveredTouch1(prospectId: string): Promise<DeliveredTouch1 | null> {
  const rows = await sql`
    with recursive chain as (
      select s.id as send_id, s.sent_at, d.id as sent_draft_id, d.contact_id, d.body, d.subject,
        d.id as draft_id, d.parent_id, d.prompt_version, d.evidence_snapshot, 0 as depth
      from prospect_outreach_sends s join outreach_drafts d on d.id = s.draft_id
      where s.prospect_id = ${prospectId} and s.allowed and s.channel = 'gmail' and s.provider_message_id is not null
      union all
      select c.send_id, c.sent_at, c.sent_draft_id, c.contact_id, c.body, c.subject,
        p.id, p.parent_id, p.prompt_version, p.evidence_snapshot, c.depth + 1
      from chain c join outreach_drafts p on p.id = c.parent_id
      where c.evidence_snapshot is null and c.depth < 10
    )
    select * from chain
    where prompt_version = ${MISMATCH_TEMPLATE_VERSION} and evidence_snapshot is not null
    order by sent_at desc, depth asc limit 1
  `;
  const r = rows[0];
  if (!r) return null;
  const snapshot = r.evidenceSnapshot as MismatchEvidenceSnapshot;
  const body = r.body as string;
  const stated = [
    `${snapshot.prospect.recommendationCount} of ${snapshot.answerCount}`,
    `${snapshot.competitor.recommendationCount} of ${snapshot.answerCount}`,
    snapshot.competitor.name,
    snapshot.prospect.productionDisplay,
    snapshot.competitor.productionDisplay,
  ].every((f) => body.includes(f));
  if (!stated) {
    throw new ClassifiedError("validation", "The sent Touch 1 body no longer states its ancestor's frozen evidence — refusing to enroll.");
  }
  const correction = await latestEvidenceCorrection(prospectId, r.sendId as string);
  return {
    sendId: r.sendId as string,
    draftId: r.sentDraftId as string,
    contactId: (r.contactId as string | null) ?? null,
    sentAt: new Date(r.sentAt as Date),
    body,
    subject: (r.subject as string | null) ?? null,
    evidenceSnapshot: correction?.correctedSnapshot ?? snapshot,
    originalSnapshot: snapshot,
    correction,
    evidenceDraftId: r.draftId as string,
  };
}

export interface EnrollResult {
  sequenceId: string;
  created: boolean;
  status: SequenceStatus;
  nextDueAt: Date | null;
}

/** Enroll a prospect whose mismatch Touch 1 was accepted by Gmail. Idempotent. */
export async function enrollFollowupSequence(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<EnrollResult>> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      experimentId: z.string().min(1).default(FOLLOWUP_EXPERIMENT_ID),
    })
    .safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const { prospectId, experimentId } = parsed.data;
  try {
    assertCanWrite(user);
    const existing = await sequenceForProspect(prospectId, experimentId);
    if (existing) {
      return ok({ sequenceId: existing.id, created: false, status: existing.status, nextDueAt: existing.nextDueAt });
    }
    const t1 = await deliveredTouch1(prospectId);
    if (!t1) {
      throw new ClassifiedError("validation", "No delivered competitive-mismatch Touch 1 on this prospect.");
    }
    const snapshot = t1.evidenceSnapshot;
    const { tz } = await marketTimezone(prospectId);
    const distinct = await distinctCompetitorQuestions(snapshot);
    const sentAt = t1.sentAt;
    const nextDueAt = dueDayStart(sentAt, FOLLOWUP_CADENCE_BUSINESS_DAYS[2], tz);
    const [row] = await sql`
      insert into outreach_followup_sequences
        (prospect_id, experiment_id, contact_id, touch1_draft_id, touch1_send_id,
         competitor_company_id, evidence_snapshot, distinct_competitor_questions,
         timezone, next_touch, next_due_at, last_touch_send_id, enrolled_by)
      values (${prospectId}, ${experimentId}, ${t1.contactId},
        ${t1.draftId}, ${t1.sendId}, ${snapshot.competitor.companyId},
        ${sql.json(snapshot as never)}, ${distinct}, ${tz}, 2, ${nextDueAt},
        ${t1.sendId}, ${user.id})
      returning id
    `;
    const sequenceId = row!.id as string;
    await sql.begin(async (tx) => {
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.followup_enrolled",
        entity: "outreach_followup_sequence",
        entityId: sequenceId,
        detail: { prospectId, experimentId, touch1SendId: t1.sendId, nextDueAt: nextDueAt.toISOString(), distinct },
      });
      await logActivity(tx, prospectId, "followup_enrolled", { sequenceId, nextDueAt: nextDueAt.toISOString() }, user.id);
    });
    // Signals that already exist (a reply recorded before enrollment) stop it now.
    const after = await applySequenceSignals(sequenceId, new Date());
    return ok({ sequenceId, created: true, status: after?.status ?? "active", nextDueAt });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------ signals

async function setSequence(
  id: string,
  patch: { status?: SequenceStatus; stopReason?: string | null; pausedUntil?: Date | null; pauseReason?: string | null }
): Promise<void> {
  await sql`
    update outreach_followup_sequences set
      status = coalesce(${patch.status ?? null}, status),
      stop_reason = case when ${patch.stopReason === undefined} then stop_reason else ${patch.stopReason ?? null} end,
      paused_until = case when ${patch.pausedUntil === undefined} then paused_until else ${patch.pausedUntil ?? null} end,
      pause_reason = case when ${patch.pauseReason === undefined} then pause_reason else ${patch.pauseReason ?? null} end,
      updated_at = now()
    where id = ${id}
  `;
}

/** Cancel any queued (approved, unsent) touch draft of a sequence. */
async function cancelQueuedTouches(sequenceId: string, reason: string, excludeDraftId: string | null = null): Promise<number> {
  const rows = await sql`
    update outreach_drafts set status = 'superseded', scheduled_send_at = null,
      send_claimed_at = null, last_send_error = ${reason.slice(0, 500)}
    where sequence_id = ${sequenceId} and status = 'approved' and sent_recorded_at is null
      and (${excludeDraftId}::uuid is null or id != ${excludeDraftId})
    returning id
  `;
  return rows.length;
}

interface SequenceSignals {
  replies: { classification: ReplyClassification; receivedAt: Date; bodyText: string }[];
  contactDnc: boolean;
  prospectDnc: boolean;
  suppressed: string | null;
  stage: ProspectStage;
  bounced: boolean;
  email: string | null;
}

async function loadSignals(seq: FollowupSequence): Promise<SequenceSignals> {
  const [p] = await sql`
    select p.stage, p.do_not_contact, p.email as prospect_email,
      c.do_not_contact as contact_dnc, c.email as contact_email, c.do_not_contact_reason
    from prospects p
    left join prospect_contacts c on c.id = ${seq.contactId}
    where p.id = ${seq.prospectId}
  `;
  const [t1] = await sql`select sent_at from prospect_outreach_sends where id = ${seq.touch1SendId}`;
  const replies = await sql`
    select classification, received_at, body_text from prospect_replies
    where prospect_id = ${seq.prospectId} and received_at >= ${t1!.sentAt as Date}
    order by received_at asc
  `;
  const email = ((p?.contactEmail ?? p?.prospectEmail) as string | null) ?? null;
  const suppression = email ? await checkSuppression({ email, phone: null, projectId: null }) : null;
  return {
    replies: replies.map((r) => ({
      classification: r.classification as ReplyClassification,
      receivedAt: new Date(r.receivedAt as Date),
      bodyText: r.bodyText as string,
    })),
    contactDnc: Boolean(p?.contactDnc),
    prospectDnc: Boolean(p?.doNotContact),
    suppressed: suppression?.suppressed ? `${suppression.matchedScope}: ${suppression.reason}` : null,
    stage: p?.stage as ProspectStage,
    bounced: /bounce/i.test((p?.doNotContactReason as string | null) ?? ""),
    email,
  };
}

/** Apply reply / stop / pause signals to one sequence. Returns the sequence
 * after the update (or null when it does not exist). */
export async function applySequenceSignals(
  sequenceId: string,
  now: Date,
  opts: { excludeDraftId?: string } = {}
): Promise<FollowupSequence | null> {
  const seq = await getFollowupSequence(sequenceId);
  if (!seq || seq.status === "complete" || seq.status === "stopped" || seq.status === "replied") return seq;
  const s = await loadSignals(seq);
  const human = s.replies.filter((r) => r.classification !== "out_of_office");
  const exclude = opts.excludeDraftId ?? null;
  const stop = async (status: SequenceStatus, reason: string): Promise<FollowupSequence | null> => {
    await setSequence(seq.id, { status, stopReason: reason });
    const cancelled = await cancelQueuedTouches(seq.id, `Sequence ${status}: ${reason}`, exclude);
    await sql.begin(async (tx) => {
      await logActivity(tx, seq.prospectId, "followup_stopped", { sequenceId: seq.id, status, reason, cancelled }, seq.enrolledBy);
    });
    return getFollowupSequence(seq.id);
  };
  if (human.length > 0) {
    const last = human[human.length - 1]!;
    // A reply whose body could not be read or classified still STOPS the
    // sequence (a possible human is enough) but never suppresses: it is
    // surfaced for review instead.
    const needsReview = last.classification === "unclear";
    const after = await stop(
      "replied",
      `human reply (${last.classification}) at ${last.receivedAt.toISOString()}${needsReview ? " - needs review" : ""}`
    );
    if (POSITIVE.includes(last.classification)) {
      const reportReady = await reportReadyFor(seq);
      await sql.begin(async (tx) => {
        await logActivity(tx, seq.prospectId, "founder_action_required", {
          sequenceId: seq.id, action: "send_private_report", classification: last.classification,
          reportState: reportReady ? "READY_TO_SEND" : "REPORT_NOT_GENERATED",
        }, seq.enrolledBy);
      });
    }
    return after;
  }
  if (sequenceExpired(seq.touch1SentAt, now)) {
    return stop("complete", `expired: ${FOLLOWUP_MAX_SEQUENCE_AGE_DAYS} calendar days since Touch 1`);
  }
  if (s.bounced) return stop("stopped", "hard bounce");
  if (s.contactDnc || s.prospectDnc) return stop("stopped", "do-not-contact");
  if (s.suppressed) return stop("stopped", `suppressed (${s.suppressed})`);
  if ((PROSPECT_EXIT_STAGES as readonly string[]).includes(s.stage)) return stop("stopped", `prospect exited (${s.stage})`);
  if ((UNATTENDED_SEND_BLOCKED_STAGES as readonly string[]).includes(s.stage)) {
    return stop("stopped", `stage "${s.stage}" blocks unattended outreach`);
  }
  const ooo = s.replies.filter((r) => r.classification === "out_of_office");
  if (ooo.length > 0) {
    const last = ooo[ooo.length - 1]!;
    const back = parseOooReturnDate(last.bodyText, last.receivedAt, seq.timezone);
    const until = back ?? new Date(last.receivedAt.getTime() + FOLLOWUP_OOO_PAUSE_DAYS * 86_400_000);
    if (until.getTime() > now.getTime() && (seq.status !== "paused" || !seq.pausedUntil || seq.pausedUntil.getTime() !== until.getTime())) {
      await setSequence(seq.id, {
        status: "paused", pausedUntil: until,
        pauseReason: back ? "out of office — stated return date" : `out of office — no return date, ${FOLLOWUP_OOO_PAUSE_DAYS}-day pause`,
      });
      await cancelQueuedTouches(seq.id, "Paused: out-of-office autoresponder", exclude);
      return getFollowupSequence(seq.id);
    }
  }
  // An expired OOO pause (not an operator pause) resumes on its own.
  if (seq.status === "paused" && seq.pausedUntil && seq.pausedUntil.getTime() <= now.getTime() && seq.pauseReason?.startsWith("out of office")) {
    await setSequence(seq.id, { status: "active", pausedUntil: null, pauseReason: null });
    return getFollowupSequence(seq.id);
  }
  return seq;
}

// ------------------------------------------------------------ engagement

export interface SequenceEngagement {
  state: EngagementState;
  reason: string;
  credibleOpens: number;
  discountedOpens: number;
}

export async function sequenceEngagement(seq: FollowupSequence, now: Date): Promise<SequenceEngagement> {
  const sends = await sql`
    select s.id, s.sent_at from prospect_outreach_sends s
    left join outreach_drafts d on d.id = s.draft_id
    where s.allowed and (s.id = ${seq.touch1SendId} or d.sequence_id = ${seq.id})
    order by s.sent_at
  `;
  const ids = sends.map((s) => s.id as string);
  const opens = ids.length
    ? await sql`select send_id, opened_at, user_agent from outreach_email_opens where send_id = any(${ids}::uuid[])`
    : [];
  const s = await loadSignals(seq);
  let auditMeaningful = false;
  try {
    const intent = await prospectIntent(seq.prospectId, now);
    auditMeaningful = Boolean(intent?.engagement.meaningfullyEngaged && intent.engagement.attribution === "attributed_link");
  } catch {
    auditMeaningful = false;
  }
  const v = evaluateEngagement({
    sends: sends.map((x) => ({ id: x.id as string, sentAt: new Date(x.sentAt as Date) })),
    opens: opens.map((o) => ({ sendId: o.sendId as string, openedAt: new Date(o.openedAt as Date), userAgent: (o.userAgent as string | null) ?? null })),
    auditMeaningfullyEngaged: auditMeaningful,
    replies: s.replies.map((r) => ({ classification: r.classification, receivedAt: r.receivedAt })),
    stopReason: seq.status === "stopped" ? seq.stopReason ?? "stopped" : null,
    pausedUntil: seq.pausedUntil,
    now,
  });
  return v;
}

// ------------------------------------------------------------ render + schedule

/** Postal + opt-out lines the Touch 1 body carried, verbatim. */
export function footerTailFrom(touch1Body: string): string[] {
  const lines = touch1Body.split("\n");
  const site = lines.findIndex((l) => l.includes(OUTREACH_PUBLIC_WEBSITE));
  return site >= 0 ? lines.slice(site + 1).filter((l) => l.trim().length > 0) : [];
}

export function firstNameFrom(touch1Body: string): string {
  const first = (touch1Body.split("\n", 1)[0] ?? "").trim();
  return first.replace(/^Hi\s+/i, "").replace(/[,—-]\s*$/, "").trim();
}

/** RealTrends entity level behind the frozen prospect production record:
 * the licensed-dataset row or the authority signal the snapshot points at.
 * Null when neither states it — the render then fails closed. */
export async function prospectEntityType(snapshot: MismatchEvidenceSnapshot): Promise<ProspectEntityType | null> {
  const id = snapshot.prospect.productionSignalId;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await sql`
    select coalesce(
      (select r.entity_type from realtrends_records r where r.id = ${id}::uuid),
      (select coalesce(s.metadata->>'entity_type', s.metadata->>'entityType') from prospect_authority_signals s where s.id = ${id}::uuid)
    ) as entity_type
  `;
  const t = row?.entityType as string | null | undefined;
  return t === "individual" || t === "team" ? t : null;
}

/** True only when a PUBLISHED private report exists for the prospect whose
 * frozen mismatch block states exactly this sequence's evidence. */
export async function reportReadyFor(seq: Pick<FollowupSequence, "prospectId" | "evidenceSnapshot">): Promise<boolean> {
  const s = seq.evidenceSnapshot;
  const [row] = await sql`
    select 1 as ok from prospect_audits a
    where a.prospect_id = ${seq.prospectId} and a.status = 'published'
      and a.snapshot->'mismatch'->'competitor'->>'name' = ${s.competitor.name}
      and (a.snapshot->'mismatch'->>'answerCount')::int = ${s.answerCount}
      and (a.snapshot->'mismatch'->'competitor'->>'recommendationCount')::int = ${s.competitor.recommendationCount}
      and (a.snapshot->'mismatch'->'prospect'->>'recommendationCount')::int = ${s.prospect.recommendationCount}
    limit 1
  `;
  return Boolean(row?.ok);
}

const CATEGORY_PHRASE: Record<string, string> = {
  "audience:seller": "seller questions",
  "audience:buyer": "buyer questions",
  neighborhood: "neighborhood questions",
  luxury: "luxury questions",
  "property:condominiums": "condo questions",
  "property:single-family homes": "single-family home questions",
  "property:townhomes": "townhome questions",
};

/** Touch 3 (engaged) personalization: the one frozen-run category that holds
 * more than half of the recommendation gap with ≥ 3 competitor
 * recommendations, phrased in plain words; null otherwise. Deterministic over
 * the frozen benchmark (spec 128 categorizer). */
export async function categoryLineFor(snapshot: MismatchEvidenceSnapshot): Promise<string | null> {
  const { mismatchQuestions, categorize } = await import("@/lib/prospects/audit-mismatch");
  const questions = await mismatchQuestions(snapshot);
  const totalGap = questions.reduce((acc, q) => acc + q.competitorRecommended - q.prospectRecommended, 0);
  if (totalGap <= 0) return null;
  const pick = categorize(questions)
    .filter((c) => CATEGORY_PHRASE[c.key] && c.competitor >= FOLLOWUP_CATEGORY_LINE.minCompetitor && c.competitor > c.prospect)
    .filter((c) => (c.competitor - c.prospect) / totalGap > FOLLOWUP_CATEGORY_LINE.minGapShare)
    .sort((a, b) => (b.competitor - b.prospect) - (a.competitor - a.prospect))[0];
  return pick ? `${CATEGORY_LINE_PREFIX}${CATEGORY_PHRASE[pick.key]}.` : null;
}

/** Everything the evidence QA needs beyond the snapshot, for one template. */
export async function followupQaContext(seq: FollowupSequence, version: FollowupTemplateVersion): Promise<FollowupQaContext> {
  const [entityType, reportReady] = await Promise.all([prospectEntityType(seq.evidenceSnapshot), reportReadyFor(seq)]);
  const categoryLine = version === FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged ? await categoryLineFor(seq.evidenceSnapshot) : null;
  return { entityType, reportReady, distinctCompetitorQuestions: seq.distinctCompetitorQuestions, categoryLine };
}

/** Draft QA entry (draft-qa.ts): the context for a queued touch draft, or
 * null when the draft belongs to no sequence. */
export async function followupQaContextForDraft(draftId: string): Promise<FollowupQaContext | null> {
  const [d] = await sql`select sequence_id, prompt_version from outreach_drafts where id = ${draftId}`;
  if (!d?.sequenceId) return null;
  const seq = await getFollowupSequence(d.sequenceId as string);
  if (!seq) return null;
  return followupQaContext(seq, d.promptVersion as FollowupTemplateVersion);
}

export interface RenderedTouch {
  version: FollowupTemplateVersion;
  branch: FollowupBranch;
  subject: string;
  body: string;
  cta: string;
  newThread: boolean;
  parentSendId: string;
  engagement: SequenceEngagement;
  claimVariant: string | null;
  qa: { check: string; detail: string }[];
}

/** Render the next touch as it would go right now (branch decided now). */
export async function renderNextTouch(seq: FollowupSequence, now: Date): Promise<RenderedTouch | null> {
  if (!seq.nextTouch) return null;
  const [t1] = await sql`
    select d.body, s.id as send_id, s.subject_snapshot
    from outreach_drafts d
    join lateral (select s.id, d2.subject as subject_snapshot from prospect_outreach_sends s join outreach_drafts d2 on d2.id = s.draft_id where s.id = ${seq.touch1SendId}) s on true
    where d.id = ${seq.touch1DraftId}
  `;
  if (!t1) return null;
  const engagement = await sequenceEngagement(seq, now);
  const branch: FollowupBranch = engagement.state === "MEANINGFUL_ENGAGEMENT" ? "engaged" : "no_engagement";
  const version = followupTemplateFor(seq.nextTouch, branch);
  const { marketName } = await marketTimezone(seq.prospectId);
  const ctx = await followupQaContext(seq, version);
  const rendered = renderFollowup(version, {
    firstName: firstNameFrom(t1.body as string),
    marketName,
    snapshot: seq.evidenceSnapshot,
    distinctCompetitorQuestions: seq.distinctCompetitorQuestions,
    footerTail: footerTailFrom(t1.body as string),
    entityType: ctx.entityType,
    reportReady: ctx.reportReady,
    categoryLine: ctx.categoryLine,
  });
  const parentSendId = seq.lastTouchSendId ?? seq.touch1SendId;
  const [parent] = await sql`
    select d.subject from prospect_outreach_sends s join outreach_drafts d on d.id = s.draft_id where s.id = ${parentSendId}
  `;
  const newThread = followupStartsNewThread(version);
  const parentSubject = (parent?.subject as string | null) ?? "";
  const subject = newThread
    ? rendered.subject ?? ""
    : parentSubject.startsWith("Re: ") ? parentSubject : `Re: ${parentSubject}`;
  const qa = [
    ...lintFollowupCopy(subject, rendered.body),
    ...qaFollowupEvidence(version, rendered.body, seq.evidenceSnapshot, ctx),
  ];
  if (!newThread && !parent) qa.push({ check: "followup_threading", detail: "parent send for in-thread reply not found." });
  return {
    version, branch, subject, body: rendered.body, cta: rendered.cta, newThread, parentSendId, engagement,
    claimVariant: rendered.claimVariant, qa,
  };
}

/** Live integrity of the frozen comparison (spec 124 QA reused): the
 * benchmark must still show the same counts and the competitor must still
 * be eligible; otherwise the evidence is invalid and the sequence stops. */
async function evidenceStillValid(seq: FollowupSequence): Promise<string | null> {
  const review = await competitiveMismatchReview(seq.prospectId, { contactId: seq.contactId });
  const s = seq.evidenceSnapshot;
  if (!review || !review.benchmark) return "benchmark no longer available";
  if (review.benchmark.answerCount !== s.answerCount) return `live answer count ${review.benchmark.answerCount} ≠ frozen ${s.answerCount}`;
  if (review.prospect.recommendationCount !== s.prospect.recommendationCount) return "prospect recommendation count changed";
  const comp = review.evaluation.candidates.find((c) => c.companyId === s.competitor.companyId);
  if (!comp || comp.recommendationCount !== s.competitor.recommendationCount) return "competitor recommendation count changed";
  if (!review.evaluation.eligibleCandidates.some((c) => c.companyId === s.competitor.companyId)) return "comparison no longer eligible";
  return null;
}

export interface ScheduleReport {
  considered: number;
  rendered: number;
  waiting: number;
  stopped: number;
  qaFailed: number;
}

/** Worker entry: stop/pause on signals, then render + queue any touch whose
 * slot is within the render lead. Idempotent per tick. */
export async function scheduleDueFollowups(now: Date = new Date()): Promise<ScheduleReport> {
  const report: ScheduleReport = { considered: 0, rendered: 0, waiting: 0, stopped: 0, qaFailed: 0 };
  const rows = await sql`
    select id from outreach_followup_sequences
    where status in ('active', 'paused') order by next_due_at asc nulls last
  `;
  for (const row of rows) {
    report.considered += 1;
    const seq = await applySequenceSignals(row.id as string, now);
    if (!seq || seq.status !== "active" || !seq.nextTouch || !seq.nextDueAt) {
      if (seq && seq.status !== "active") report.stopped += 1;
      continue;
    }
    const slot = await capAwareSlot(seq, projectedSlot(seq, now)!);
    if (sequenceExpired(seq.touch1SentAt, slot)) {
      // Deferrals (cap, holidays, OOO) pushed the slot past the sequence age
      // limit: a follow-up weeks later is never sent.
      await setSequence(seq.id, { status: "complete", stopReason: `expired: next slot ${slot.toISOString()} is past ${FOLLOWUP_MAX_SEQUENCE_AGE_DAYS} days since Touch 1` });
      await cancelQueuedTouches(seq.id, "Sequence complete: expired");
      report.stopped += 1;
      continue;
    }
    if (slot.getTime() - now.getTime() > FOLLOWUP_RENDER_LEAD_MINUTES * 60_000) {
      report.waiting += 1;
      continue;
    }
    const [live] = await sql`
      select id, scheduled_send_at, last_send_error from outreach_drafts
      where sequence_id = ${seq.id} and touch_number = ${seq.nextTouch}
        and status = 'approved' and sent_recorded_at is null
    `;
    if (live && live.scheduledSendAt) {
      report.waiting += 1;
      continue;
    }
    if (live) {
      // Parked by the dispatcher (gate refusal, transport trouble): retire it
      // and render afresh for the next slot — the branch may have changed.
      await sql`
        update outreach_drafts set status = 'superseded' where id = ${live.id}
      `;
      log("warn", "followup.parked_touch_retired", { sequenceId: seq.id, draftId: live.id, reason: live.lastSendError });
    }
    const invalid = await evidenceStillValid(seq);
    if (invalid) {
      await setSequence(seq.id, { status: "stopped", stopReason: `evidence invalid: ${invalid}` });
      report.stopped += 1;
      continue;
    }
    const touch = await renderNextTouch(seq, now);
    if (!touch) continue;
    if (touch.qa.length > 0) {
      report.qaFailed += 1;
      log("warn", "followup.render_qa_failed", { sequenceId: seq.id, issues: touch.qa });
      continue;
    }
    await queueTouchDraft(seq, touch, slot);
    report.rendered += 1;
  }
  return report;
}

/** The trailing-24h Gmail cap counts every transmit. A follow-up slot whose
 * window is already full (sent + queued) moves to the next business-day
 * morning instead of burning an attempt on a refusal. */
async function capAwareSlot(seq: FollowupSequence, slot: Date): Promise<Date> {
  let candidate = slot;
  for (let i = 0; i < 5; i += 1) {
    const [row] = await sql`
      select
        (select count(*) from prospect_outreach_sends
          where channel = 'gmail' and allowed and sent_at > ${candidate}::timestamptz - interval '24 hours' and sent_at <= ${candidate}) as sent,
        (select count(*) from outreach_drafts
          where status = 'approved' and sent_recorded_at is null and scheduled_send_at is not null
            and scheduled_send_at > ${candidate}::timestamptz - interval '24 hours' and scheduled_send_at <= ${candidate}) as queued
    `;
    const used = Number(row?.sent ?? 0) + Number(row?.queued ?? 0);
    if (used < GMAIL_DAILY_SEND_CAP) return candidate;
    log("warn", "followup.slot_deferred_cap", { sequenceId: seq.id, slot: candidate.toISOString(), used });
    candidate = slotFor(seq, new Date(candidate.getTime() + 86_400_000));
  }
  return candidate;
}

async function queueTouchDraft(seq: FollowupSequence, touch: RenderedTouch, slot: Date): Promise<string> {
  return sql.begin(async (tx) => {
    const [v] = await tx`
      select coalesce(max(version), 0)::int as v from outreach_drafts where prospect_id = ${seq.prospectId}
    `;
    const purpose =
      `Experiment ${seq.experimentId}: Touch ${seq.nextTouch} (${touch.version}, ${touch.branch}) over the frozen Touch 1 ` +
      `evidence; branch chosen at render from engagement state ${touch.engagement.state}. Enrollment approved by operator.`;
    const [row] = await tx`
      insert into outreach_drafts
        (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta,
         generated_by, prompt_version, evidence_snapshot, status, approved_by, approved_at,
         created_by, scheduled_send_at, scheduled_by, scheduled_business_purpose,
         sequence_id, touch_number, branch, parent_send_id, engagement_state_at_dispatch)
      select d.prospect_id, d.finding_id, d.channel, ${seq.contactId}, ${Number(v!.v) + 1},
        ${touch.subject}, ${touch.body}, 'direct, plain, peer-to-peer', ${touch.cta},
        'system', ${touch.version}, ${sql.json(seq.evidenceSnapshot as never)}, 'approved', ${seq.enrolledBy}, now(),
        ${seq.enrolledBy}, ${slot}, ${seq.enrolledBy}, ${purpose},
        ${seq.id}, ${seq.nextTouch}, ${touch.branch}, ${touch.parentSendId}, ${touch.engagement.state}
      from outreach_drafts d where d.id = ${seq.touch1DraftId}
      returning id
    `;
    const draftId = row!.id as string;
    await writeAudit(tx, {
      userId: seq.enrolledBy,
      action: "prospect.followup_rendered",
      entity: "outreach_draft",
      entityId: draftId,
      detail: {
        sequenceId: seq.id, touch: seq.nextTouch, branch: touch.branch, template: touch.version,
        engagementState: touch.engagement.state, engagementReason: touch.engagement.reason,
        credibleOpens: touch.engagement.credibleOpens, discountedOpens: touch.engagement.discountedOpens,
        slot: slot.toISOString(), claimVariant: touch.claimVariant,
        bodyHash: createHash("sha256").update(`${touch.subject}\n${touch.body}`).digest("hex"),
      },
    });
    await logActivity(tx, seq.prospectId, "followup_scheduled", { draftId, touch: seq.nextTouch, branch: touch.branch, slot: slot.toISOString() }, seq.enrolledBy);
    return draftId;
  });
}

// ------------------------------------------------------------ preflight (dispatch)

export interface FollowupThreading {
  threadId: string | null;
  inReplyTo: string | null;
  references: string | null;
}
export type PreflightResult =
  | { ok: true; detail: string; threading: FollowupThreading }
  | { ok: false; detail: string };

function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

async function readThread(threadId: string): Promise<ParsedGmailMessage[] | null> {
  const res = await executeCapability<{ messages: ParsedGmailMessage[] }>({
    capability: "email.read_thread", projectId: null, provider: "gmail", mode: "live",
    input: { threadId },
  });
  return res.ok ? res.data?.messages ?? [] : null;
}

/** Runs inside the send gate for drafts that belong to a sequence. Every
 * failure refuses the send; Gmail unavailability refuses too. */
export async function followupPreflight(
  draftId: string,
  now: Date = new Date(),
  opts: { excludeDraftId?: string } = {}
): Promise<PreflightResult> {
  const [d] = await sql`
    select sequence_id, touch_number, parent_send_id, engagement_state_at_dispatch, body, subject
    from outreach_drafts where id = ${draftId}
  `;
  if (!d?.sequenceId) return { ok: false, detail: "draft is not part of a follow-up sequence." };
  const seq = await applySequenceSignals(d.sequenceId as string, now, opts);
  if (!seq) return { ok: false, detail: "sequence not found." };
  if (seq.status !== "active") return { ok: false, detail: `sequence is ${seq.status}${seq.stopReason ? ` (${seq.stopReason})` : ""}.` };
  if (seq.nextTouch !== Number(d.touchNumber)) return { ok: false, detail: `sequence expects touch ${seq.nextTouch}, draft is touch ${d.touchNumber}.` };

  const gmail = await connectors.connectionFor({ projectId: null, provider: "gmail" });
  if (!gmail) return { ok: false, detail: "no Gmail connection." };
  const syncAge = gmail.lastSyncAt ? (now.getTime() - gmail.lastSyncAt.getTime()) / 60_000 : Infinity;
  if (syncAge > FOLLOWUP_REPLY_SYNC_MAX_AGE_MINUTES) {
    return { ok: false, detail: `reply sync is stale (${Number.isFinite(syncAge) ? Math.round(syncAge) : "never"} min) — refusing to send blind.` };
  }
  const sender = ((gmail.config as { sendAsAddress?: string }).sendAsAddress ?? gmail.externalAccountId ?? "").toLowerCase();

  // Live inbox check across every thread of the sequence (the no-engagement
  // branch may have opened a second thread).
  const threads = await sql`
    select distinct s.gmail_thread_id, s.sent_at from prospect_outreach_sends s
    left join outreach_drafts d on d.id = s.draft_id
    where s.allowed and s.gmail_thread_id is not null
      and (s.id = ${seq.touch1SendId} or d.sequence_id = ${seq.id})
  `;
  let lastOutbound: ParsedGmailMessage | null = null;
  let parentThreadId: string | null = null;
  const [parent] = await sql`select gmail_thread_id from prospect_outreach_sends where id = ${d.parentSendId as string}`;
  parentThreadId = (parent?.gmailThreadId as string | null) ?? null;
  for (const t of threads) {
    const messages = await readThread(t.gmailThreadId as string);
    if (messages === null) return { ok: false, detail: `Gmail thread ${t.gmailThreadId} could not be read — failing closed.` };
    const outbound = messages.filter((m) => addressOf(m.from) === sender);
    const lastOut = outbound.reduce<ParsedGmailMessage | null>((a, m) => (!a || (m.date ?? "") > (a.date ?? "") ? m : a), null);
    for (const m of messages) {
      const from = addressOf(m.from);
      if (from === sender) continue;
      if (lastOut && (m.date ?? "") < (lastOut.date ?? "")) continue;
      if (/mailer-daemon|postmaster/i.test(from)) {
        await recordBounce(seq, m, opts.excludeDraftId ?? null);
        return { ok: false, detail: "bounce found in thread — sequence stopped." };
      }
      await recordInboundReply(seq, m);
      await applySequenceSignals(seq.id, now, opts);
      return { ok: false, detail: `inbound reply found in Gmail thread (${m.id}) — sequence stopped.` };
    }
    if ((t.gmailThreadId as string) === parentThreadId) lastOutbound = lastOut;
  }

  const engagement = await sequenceEngagement(seq, now);
  if (engagement.state !== (d.engagementStateAtDispatch as string)) {
    return { ok: false, detail: `engagement changed since render (${d.engagementStateAtDispatch} → ${engagement.state}); re-rendering.` };
  }
  const version = await templateOf(draftId);
  const qa = lintFollowupCopy((d.subject as string | null) ?? null, d.body as string)
    .concat(qaFollowupEvidence(version, d.body as string, seq.evidenceSnapshot, await followupQaContext(seq, version)));
  if (qa.length) return { ok: false, detail: qa.map((i) => `[${i.check}] ${i.detail}`).join(" ") };

  const newThread = followupStartsNewThread(version);
  if (!newThread && !parentThreadId) {
    return { ok: false, detail: "in-thread touch but the parent send has no Gmail thread id — refusing to open a new thread." };
  }
  return {
    ok: true,
    detail: `sequence active, sync ${Math.round(syncAge)} min old, ${threads.length} thread(s) clean, engagement ${engagement.state}`,
    threading: newThread
      ? { threadId: null, inReplyTo: null, references: null }
      : { threadId: parentThreadId, inReplyTo: lastOutbound?.messageId ?? null, references: lastOutbound?.messageId ?? null },
  };
}

async function templateOf(draftId: string): Promise<FollowupTemplateVersion> {
  const [r] = await sql`select prompt_version from outreach_drafts where id = ${draftId}`;
  return r!.promptVersion as FollowupTemplateVersion;
}

export async function recordInboundReply(seq: FollowupSequence, m: ParsedGmailMessage): Promise<boolean> {
  const [dup] = await sql`select id from prospect_replies where gmail_message_id = ${m.id}`;
  if (dup) return false;
  const text = stripQuotedReply(m.body).slice(0, 20000) || m.subject;
  const [send] = await sql`
    select s.id from prospect_outreach_sends s left join outreach_drafts d on d.id = s.draft_id
    where s.allowed and (s.id = ${seq.touch1SendId} or d.sequence_id = ${seq.id})
      and (${m.date ?? null}::timestamptz is null or s.sent_at <= ${m.date ?? null})
    order by s.sent_at desc limit 1
  `;
  const user = await userById(seq.enrolledBy);
  if (!user) return false;
  const { recordProspectReply } = await import("@/lib/prospects/service");
  const res = await recordProspectReply(user, {
    prospectId: seq.prospectId,
    contactId: seq.contactId ?? undefined,
    sendId: (send?.id as string | undefined) ?? undefined,
    bodyText: text,
    receivedAt: m.date ? new Date(m.date) : new Date(),
    gmailMessageId: m.id,
  });
  return res.ok;
}

export async function recordBounce(seq: FollowupSequence, m: ParsedGmailMessage, excludeDraftId: string | null = null): Promise<void> {
  if (seq.contactId) {
    await sql`
      update prospect_contacts set do_not_contact = true,
        do_not_contact_reason = ${`hard_bounce ${(m.date ?? "").slice(0, 10)}: Gmail delivery failure (${m.id}). Re-source before contacting.`},
        updated_at = now()
      where id = ${seq.contactId} and not do_not_contact
    `;
  }
  await setSequence(seq.id, { status: "stopped", stopReason: "hard bounce" });
  await cancelQueuedTouches(seq.id, "Sequence stopped: hard bounce", excludeDraftId);
}

/** After an allowed transmit of a touch draft: advance or complete. */
type Tx = Parameters<typeof logActivity>[0];

export async function advanceSequenceAfterSend(
  tx: Tx,
  draft: { sequenceId: string; touchNumber: number },
  sendId: string,
  sentAt: Date
): Promise<void> {
  const [row] = await tx`select timezone from outreach_followup_sequences where id = ${draft.sequenceId}`;
  const tz = (row?.timezone as string) ?? "America/New_York";
  if (draft.touchNumber === 2) {
    const due = dueDayStart(sentAt, FOLLOWUP_CADENCE_BUSINESS_DAYS[3], tz);
    await tx`
      update outreach_followup_sequences set last_touch_send_id = ${sendId}, next_touch = 3,
        next_due_at = ${due}, updated_at = now() where id = ${draft.sequenceId}
    `;
  } else {
    await tx`
      update outreach_followup_sequences set last_touch_send_id = ${sendId}, next_touch = null,
        next_due_at = null, status = 'complete', updated_at = now() where id = ${draft.sequenceId}
    `;
  }
}

// ------------------------------------------------------------ operator controls

const idInput = z.object({ sequenceId: z.string().uuid(), reason: z.string().trim().min(3).max(300).optional() });

export async function pauseFollowupSequence(user: CurrentUser, raw: unknown): Promise<ActionResult<{ status: SequenceStatus }>> {
  const p = idInput.safeParse(raw);
  if (!p.success) return fail(new ClassifiedError("validation", firstZodMessage(p.error)));
  try {
    assertCanWrite(user);
    const seq = await getFollowupSequence(p.data.sequenceId);
    if (!seq) throw new ClassifiedError("not_found", "Sequence not found.");
    if (seq.status !== "active") throw new ClassifiedError("validation", `Sequence is ${seq.status}.`);
    await setSequence(seq.id, { status: "paused", pausedUntil: null, pauseReason: `operator: ${p.data.reason ?? "paused"}` });
    await cancelQueuedTouches(seq.id, "Paused by operator");
    await sql.begin(async (tx) => {
      await writeAudit(tx, { userId: user.id, action: "prospect.followup_paused", entity: "outreach_followup_sequence", entityId: seq.id, detail: { reason: p.data.reason ?? null } });
    });
    return ok({ status: "paused" });
  } catch (err) {
    return fail(err);
  }
}

export async function resumeFollowupSequence(user: CurrentUser, raw: unknown): Promise<ActionResult<{ status: SequenceStatus }>> {
  const p = idInput.safeParse(raw);
  if (!p.success) return fail(new ClassifiedError("validation", firstZodMessage(p.error)));
  try {
    assertCanWrite(user);
    const seq = await getFollowupSequence(p.data.sequenceId);
    if (!seq) throw new ClassifiedError("not_found", "Sequence not found.");
    if (seq.status !== "paused") throw new ClassifiedError("validation", `Sequence is ${seq.status}.`);
    await setSequence(seq.id, { status: "active", pausedUntil: null, pauseReason: null });
    await sql.begin(async (tx) => {
      await writeAudit(tx, { userId: user.id, action: "prospect.followup_resumed", entity: "outreach_followup_sequence", entityId: seq.id, detail: {} });
    });
    return ok({ status: "active" });
  } catch (err) {
    return fail(err);
  }
}

/** Cancel every future touch. Terminal. */
export async function stopFollowupSequence(user: CurrentUser, raw: unknown): Promise<ActionResult<{ status: SequenceStatus }>> {
  const p = idInput.safeParse(raw);
  if (!p.success) return fail(new ClassifiedError("validation", firstZodMessage(p.error)));
  try {
    assertCanWrite(user);
    const seq = await getFollowupSequence(p.data.sequenceId);
    if (!seq) throw new ClassifiedError("not_found", "Sequence not found.");
    if (seq.status === "complete" || seq.status === "stopped") throw new ClassifiedError("validation", `Sequence is already ${seq.status}.`);
    await setSequence(seq.id, { status: "stopped", stopReason: `operator: ${p.data.reason ?? "stopped"}` });
    const cancelled = await cancelQueuedTouches(seq.id, "Stopped by operator");
    await sql.begin(async (tx) => {
      await writeAudit(tx, { userId: user.id, action: "prospect.followup_stopped", entity: "outreach_followup_sequence", entityId: seq.id, detail: { reason: p.data.reason ?? null, cancelled } });
      await logActivity(tx, seq.prospectId, "followup_stopped", { sequenceId: seq.id, status: "stopped", reason: p.data.reason ?? "operator" }, user.id);
    });
    return ok({ status: "stopped" });
  } catch (err) {
    return fail(err);
  }
}

/** Pause or resume every active sequence of an experiment (founder switch). */
export async function setAllFollowupsPaused(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ affected: number }>> {
  const p = z.object({ paused: z.boolean(), experimentId: z.string().min(1).default(FOLLOWUP_EXPERIMENT_ID) }).safeParse(raw);
  if (!p.success) return fail(new ClassifiedError("validation", firstZodMessage(p.error)));
  try {
    assertCanWrite(user);
    const rows = p.data.paused
      ? await sql`
          update outreach_followup_sequences set status = 'paused', pause_reason = 'operator: pause all', updated_at = now()
          where experiment_id = ${p.data.experimentId} and status = 'active' returning id
        `
      : await sql`
          update outreach_followup_sequences set status = 'active', pause_reason = null, paused_until = null, updated_at = now()
          where experiment_id = ${p.data.experimentId} and status = 'paused' and pause_reason = 'operator: pause all' returning id
        `;
    if (p.data.paused) {
      for (const r of rows) await cancelQueuedTouches(r.id as string, "Paused by operator (all)");
    }
    await sql.begin(async (tx) => {
      for (const r of rows) {
        await writeAudit(tx, { userId: user.id, action: p.data.paused ? "prospect.followups_paused_all" : "prospect.followups_resumed_all", entity: "outreach_followup_sequence", entityId: r.id as string, detail: { experimentId: p.data.experimentId, affected: rows.length } });
      }
    });
    return ok({ affected: rows.length });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------ operator view

export const SEQUENCE_DISPLAY_STATES = [
  "T1_SENT", "T2_DUE", "T2_SCHEDULED", "T2_SENT", "T3_DUE", "T3_SCHEDULED", "T3_SENT",
  "REPLIED", "REPLY_NEEDS_REVIEW", "STOPPED", "BOUNCED", "OOO_PAUSED", "PAUSED", "SUPPRESSED", "COMPLETE_NO_REPLY",
] as const;
export type SequenceDisplayState = (typeof SEQUENCE_DISPLAY_STATES)[number];

export type HandoffDisplayState =
  | "REPORT_NOT_GENERATED" | "READY_TO_SEND" | "IN_PROGRESS" | "SCHEDULED" | "SENT" | "NEEDS_REVIEW" | "STOPPED";

export interface FollowupSequenceView {
  sequenceId: string;
  prospectId: string;
  businessName: string;
  market: string;
  recipientEmail: string | null;
  competitor: string;
  touch1SentAt: Date;
  status: SequenceStatus;
  displayState: SequenceDisplayState;
  stopReason: string | null;
  pausedUntil: Date | null;
  nextTouch: 2 | 3 | null;
  nextSlot: Date | null;
  timezone: string;
  queued: { draftId: string; touch: number; branch: string | null; template: string | null; scheduledSendAt: Date | null; engagement: string | null } | null;
  touches: { touch: number; branch: string | null; template: string | null; sentAt: Date; opens: number; gmailThreadId: string | null }[];
  replies: { classification: string; receivedAt: Date; afterTouch: number }[];
  /** After a positive reply: where the report handoff (spec 129) stands and
   * what, if anything, the founder must do. */
  handoff: { reportState: HandoffDisplayState; nextAction: string; reason: string | null } | null;
  expiresAt: Date;
}

export async function listFollowupSequences(filter: { prospectId?: string; experimentId?: string } = {}, now: Date = new Date()): Promise<FollowupSequenceView[]> {
  const rows = await sql`
    select q.*, p.business_name, l.name as market, t1.sent_at as touch1_sent_at, t1.recipient_email,
      (select coalesce(json_agg(json_build_object('draftId', d.id, 'touch', d.touch_number, 'branch', d.branch,
          'template', d.prompt_version, 'scheduledSendAt', d.scheduled_send_at, 'engagement', d.engagement_state_at_dispatch)), '[]')
        from outreach_drafts d where d.sequence_id = q.id and d.status = 'approved' and d.sent_recorded_at is null) as queued,
      (select coalesce(json_agg(json_build_object('touch', coalesce(d.touch_number, 1), 'branch', d.branch, 'template', d.prompt_version,
          'sentAt', s.sent_at, 'gmailThreadId', s.gmail_thread_id,
          'opens', (select count(*) from outreach_email_opens o where o.send_id = s.id)) order by s.sent_at), '[]')
        from prospect_outreach_sends s join outreach_drafts d on d.id = s.draft_id
        where s.allowed and (s.id = q.touch1_send_id or d.sequence_id = q.id)) as touches,
      (select coalesce(json_agg(json_build_object('classification', r.classification, 'receivedAt', r.received_at) order by r.received_at), '[]')
        from prospect_replies r where r.prospect_id = q.prospect_id and r.received_at >= t1.sent_at) as replies,
      (select json_build_object('status', h.status, 'reason', h.reason, 'scheduledAt', d.scheduled_send_at)
        from prospect_report_handoffs h left join outreach_drafts d on d.id = h.draft_id
        where h.prospect_id = q.prospect_id order by h.created_at desc limit 1) as handoff_row
    from outreach_followup_sequences q
    join prospects p on p.id = q.prospect_id
    join market_launches l on l.id = p.launch_id
    join prospect_outreach_sends t1 on t1.id = q.touch1_send_id
    where (${filter.prospectId ?? null}::uuid is null or q.prospect_id = ${filter.prospectId ?? null})
      and (${filter.experimentId ?? null}::text is null or q.experiment_id = ${filter.experimentId ?? null})
    order by q.next_due_at asc nulls last, p.business_name
  `;
  const positiveSeqs = rows.filter((r) => r.status === "replied");
  const readiness = new Map<string, boolean>();
  for (const r of positiveSeqs) readiness.set(r.id as string, await reportReadyFor(toSequence(r)));
  return rows.map((r) => {
    const seq = toSequence(r);
    const touches = ((r.touches as { touch: number; branch: string | null; template: string | null; sentAt: string; opens: number; gmailThreadId: string | null }[]) ?? [])
      .map((t) => ({ ...t, sentAt: new Date(t.sentAt), opens: Number(t.opens) }));
    const queuedList = (r.queued as { draftId: string; touch: number; branch: string | null; template: string | null; scheduledSendAt: string | null; engagement: string | null }[]) ?? [];
    const queued = queuedList[0] ? { ...queuedList[0], scheduledSendAt: queuedList[0].scheduledSendAt ? new Date(queuedList[0].scheduledSendAt) : null } : null;
    const replies = ((r.replies as { classification: string; receivedAt: string }[]) ?? []).map((x) => {
      const at = new Date(x.receivedAt);
      const preceding = touches.filter((t) => t.sentAt.getTime() <= at.getTime());
      return { classification: x.classification, receivedAt: at, afterTouch: preceding.length ? preceding[preceding.length - 1]!.touch : 1 };
    });
    const lastTouch = touches.length ? touches[touches.length - 1]!.touch : 1;
    const lastReply = replies.length ? replies[replies.length - 1]! : null;
    let displayState: SequenceDisplayState;
    if (seq.status === "replied") displayState = lastReply?.classification === "unclear" || /needs review/.test(seq.stopReason ?? "") ? "REPLY_NEEDS_REVIEW" : "REPLIED";
    else if (seq.status === "stopped") displayState = /bounce/i.test(seq.stopReason ?? "") ? "BOUNCED" : /suppress/i.test(seq.stopReason ?? "") ? "SUPPRESSED" : "STOPPED";
    else if (seq.status === "paused") displayState = seq.pauseReason?.startsWith("out of office") ? "OOO_PAUSED" : "PAUSED";
    else if (seq.status === "complete") displayState = "COMPLETE_NO_REPLY";
    else if (queued) displayState = queued.touch === 2 ? "T2_SCHEDULED" : "T3_SCHEDULED";
    else if (seq.nextTouch === 2) displayState = seq.nextDueAt && seq.nextDueAt.getTime() <= now.getTime() ? "T2_DUE" : "T1_SENT";
    else if (seq.nextTouch === 3) displayState = seq.nextDueAt && seq.nextDueAt.getTime() <= now.getTime() ? "T3_DUE" : "T2_SENT";
    else displayState = lastTouch === 3 ? "T3_SENT" : "T1_SENT";
    return {
      sequenceId: seq.id,
      prospectId: seq.prospectId,
      businessName: r.businessName as string,
      market: r.market as string,
      recipientEmail: (r.recipientEmail as string | null) ?? null,
      competitor: seq.evidenceSnapshot.competitor.name,
      touch1SentAt: new Date(r.touch1SentAt as Date),
      status: seq.status,
      displayState,
      stopReason: seq.stopReason,
      pausedUntil: seq.pausedUntil,
      nextTouch: seq.nextTouch,
      nextSlot: queued?.scheduledSendAt ?? projectedSlot(seq, now),
      timezone: seq.timezone,
      queued,
      touches,
      replies,
      handoff:
        r.handoffRow || (seq.status === "replied" && lastReply && POSITIVE.includes(lastReply.classification as ReplyClassification))
          ? handoffDisplay(r.handoffRow as { status: string; reason: string | null; scheduledAt: string | null } | null, readiness.get(seq.id) ?? false, seq.timezone)
          : null,
      expiresAt: sequenceExpiresAt(seq.touch1SentAt),
    };
  });
}

function handoffDisplay(
  row: { status: string; reason: string | null; scheduledAt: string | null } | null,
  reportReady: boolean,
  tz: string
): FollowupSequenceView["handoff"] {
  if (!row) {
    return reportReady
      ? { reportState: "READY_TO_SEND", nextAction: "Reply in thread with the private report", reason: null }
      : { reportState: "REPORT_NOT_GENERATED", nextAction: "Generate + QA the private report, then reply in thread", reason: null };
  }
  switch (row.status) {
    case "sent": return { reportState: "SENT", nextAction: "Report delivered in thread; watch for the next reply", reason: null };
    case "scheduled": {
      const at = row.scheduledAt ? new Date(row.scheduledAt) : null;
      const w = at ? wallClock(at, tz) : null;
      return { reportState: "SCHEDULED", nextAction: `Report reply queued${w ? ` for ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")} local` : ""}`, reason: null };
    }
    case "needs_review": return { reportState: "NEEDS_REVIEW", nextAction: "Fix the report or send by hand", reason: row.reason };
    case "stopped": return { reportState: "STOPPED", nextAction: "No report: the prospect opted out or is blocked", reason: row.reason };
    case "qa_passed": return { reportState: "READY_TO_SEND", nextAction: "QA passed; autosend is off, reply in thread by hand", reason: row.reason };
    default: return { reportState: "IN_PROGRESS", nextAction: "Generating and QA-ing the report", reason: row.reason };
  }
}

// ------------------------------------------------------------ experiment metrics

export interface FollowupMetrics {
  experimentId: string;
  sequences: number;
  delivered: { t1: number; t2: number; t3: number };
  byBranch: Record<string, { delivered: number; repliesAfter: number; positiveAfter: number }>;
  humanReplies: number;
  positiveReplies: number;
  negativeReplies: number;
  bounced: number;
  dnc: number;
  positiveReplyRate: number | null;
  humanReplyRate: number | null;
  medianHoursToReply: number | null;
  firstReplyAfterTouch: Record<string, number>;
  diagnostic: { credibleOpenSequences: number };
}

const POSITIVE: ReplyClassification[] = ["positive_interest", "proof_request", "question", "referral"];
const NEGATIVE: ReplyClassification[] = ["not_interested", "unsubscribe", "objection"];

export async function followupMetrics(experimentId = FOLLOWUP_EXPERIMENT_ID, now: Date = new Date()): Promise<FollowupMetrics> {
  const views = await listFollowupSequences({ experimentId }, now);
  const delivered = { t1: 0, t2: 0, t3: 0 };
  const byBranch: FollowupMetrics["byBranch"] = {};
  const firstReplyAfterTouch: Record<string, number> = {};
  let human = 0, positive = 0, negative = 0, bounced = 0, dnc = 0;
  const hours: number[] = [];
  let credibleOpenSequences = 0;
  for (const v of views) {
    for (const t of v.touches) {
      if (t.touch === 1) delivered.t1 += 1;
      if (t.touch === 2) delivered.t2 += 1;
      if (t.touch === 3) delivered.t3 += 1;
      if (t.template && t.touch > 1) {
        const key = `${t.template}`;
        byBranch[key] ??= { delivered: 0, repliesAfter: 0, positiveAfter: 0 };
        byBranch[key].delivered += 1;
      }
    }
    const humanReplies = v.replies.filter((r) => r.classification !== "out_of_office");
    if (humanReplies.length) {
      human += 1;
      const first = humanReplies[0]!;
      firstReplyAfterTouch[String(first.afterTouch)] = (firstReplyAfterTouch[String(first.afterTouch)] ?? 0) + 1;
      const touch = v.touches.find((t) => t.touch === first.afterTouch);
      if (touch) hours.push((first.receivedAt.getTime() - touch.sentAt.getTime()) / 3_600_000);
      if (touch?.template && first.afterTouch > 1) {
        byBranch[touch.template]!.repliesAfter += 1;
        if (POSITIVE.includes(first.classification as ReplyClassification)) byBranch[touch.template]!.positiveAfter += 1;
      }
      if (POSITIVE.includes(first.classification as ReplyClassification)) positive += 1;
      if (NEGATIVE.includes(first.classification as ReplyClassification)) negative += 1;
    }
    if (v.displayState === "BOUNCED") bounced += 1;
    if (v.stopReason === "do-not-contact" || v.displayState === "SUPPRESSED") dnc += 1;
    if (v.touches.some((t) => t.opens > 0)) credibleOpenSequences += 1;
  }
  const sorted = hours.sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  return {
    experimentId,
    sequences: views.length,
    delivered,
    byBranch,
    humanReplies: human,
    positiveReplies: positive,
    negativeReplies: negative,
    bounced,
    dnc,
    positiveReplyRate: delivered.t1 ? positive / delivered.t1 : null,
    humanReplyRate: delivered.t1 ? human / delivered.t1 : null,
    medianHoursToReply: median,
    firstReplyAfterTouch,
    diagnostic: { credibleOpenSequences },
  };
}

export function isFollowupTemplate(version: string | null | undefined): version is FollowupTemplateVersion {
  return !!version && FOLLOWUP_TEMPLATE_VERSION_LIST.includes(version);
}
