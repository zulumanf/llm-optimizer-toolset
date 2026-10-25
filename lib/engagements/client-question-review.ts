/**
 * Client review of the proposed customer questions, and the client's binding
 * approval of the measurement plan (spec 155, amendment R3/R4).
 *
 * Review is INFORMAL and append-only: every Approve / Request edit / Remove is
 * a new `client_question_reviews` row; the latest row per question is its
 * state, so progress, save and resume are derived. "Send my review" sends
 * feedback (`changes_requested` or `acknowledged`) and NEVER records an
 * approval.
 *
 * The BINDING act is approveMeasurementPlan: the approver sees the exact final
 * question version and the protocol (definition of a recommendation, method,
 * success criteria) and approves both in one transaction.
 *
 * Approval binds to wording (R4): a per-question approval belongs to one
 * version and prompt; on a newer version a question counts as approved only
 * if an earlier version of this engagement approved IDENTICAL normalised
 * text. Revised wording needs a fresh decision.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertClientApprover, assertProjectAccess, isClient, isClientApprover, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { engagementForProject, type EngagementRow } from "@/lib/engagements/service";
import {
  acceptProtocolInTx,
  listProtocols,
  listSubjectDecisions,
  loadProtocol,
  proposedQuestionSet,
  protocolAcceptanceBlockers,
  questionSetSnapshot,
  type ProposedQuestionSet,
} from "@/lib/engagements/delivery";
import { clientActorOf } from "@/lib/engagements/client-onboarding";
import { ONBOARDING_OPEN_STAGES } from "@/lib/engagements/client-onboarding-rules";
import { normalizePromptText } from "@/lib/prompts/import-parse";
import { segmentOf } from "@/lib/engagements/question-review";
export { OTHER_SEGMENT, segmentOf } from "@/lib/engagements/question-review";

export const QUESTION_REVIEW_DECISIONS = ["approved", "edit_requested", "removed"] as const;
export type QuestionReviewDecision = (typeof QUESTION_REVIEW_DECISIONS)[number];
export const QUESTION_COMMENT_MAX = 1000;
export const PORTAL_REVIEW_VERSION = "portal-question-review-v2";

const idSchema = z.string().uuid();

export interface ReviewedQuestionView {
  promptId: string;
  text: string;
  neighborhood: string | null;
  /** The client's own decision on THIS version, if any. */
  decision: QuestionReviewDecision | null;
  comment: string;
  decidedAt: Date | null;
  /** Approved on an earlier version with identical wording (R4). */
  carried: boolean;
  /** Earlier versions were reviewed and this wording is new or changed. */
  revised: boolean;
}

export type ReadOnlyReason = "staff_preview" | "viewer" | null;

export interface QuestionReviewView {
  versionId: string;
  version: number;
  /** Shown with the version: each revision is a new set, so its numbering restarts. */
  setName: string;
  total: number;
  /** Direct decisions on this version plus carried approvals. */
  reviewed: number;
  remaining: number;
  counts: Record<QuestionReviewDecision, number> & { carried: number };
  groups: { segment: string; questions: ReviewedQuestionView[] }[];
  /** The latest set-level decision on this version, if any. */
  submitted: { decision: string; decidedAt: Date; channel: string } | null;
  /** The version is approved (bound to a protocol); no further review. */
  locked: boolean;
  canRespond: boolean;
  readOnlyReason: ReadOnlyReason;
  /** The binding step, when it is the next thing to do (R3). */
  plan: { protocolId: string; version: number; ready: boolean; blockers: string[] } | null;
}

type Latest = Map<string, { decision: QuestionReviewDecision; comment: string; decidedAt: Date }>;

/** Latest decision per question on a version. */
async function latestDecisions(versionId: string): Promise<Latest> {
  const rows = await sql`
    select distinct on (prompt_id) prompt_id, decision, comment, decided_at
    from client_question_reviews where prompt_set_version_id = ${versionId}
    order by prompt_id, decided_at desc, id desc
  `;
  return new Map(rows.map((r) => [r.promptId as string, { decision: r.decision as QuestionReviewDecision, comment: (r.comment as string) ?? "", decidedAt: r.decidedAt as Date }]));
}

/**
 * Wording reviewed on EARLIER versions of this engagement: normalised text →
 * approved? (the latest decision on that version). Only identical wording can
 * carry an approval forward.
 */
async function priorWording(engagementId: string, currentVersionId: string): Promise<{ approved: Set<string>; seen: Set<string>; any: boolean }> {
  const rows = await sql`
    select distinct on (r.prompt_set_version_id, r.prompt_id) r.prompt_set_version_id, r.prompt_id, r.decision, v.frozen_prompts
    from client_question_reviews r join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.engagement_id = ${engagementId} and r.prompt_set_version_id <> ${currentVersionId}
    order by r.prompt_set_version_id, r.prompt_id, r.decided_at desc, r.id desc
  `;
  const approved = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    const prompts = (r.frozenPrompts as { promptId: string; text: string }[]) ?? [];
    const text = prompts.find((q) => q.promptId === r.promptId)?.text;
    if (!text) continue;
    const key = normalizePromptText(text);
    seen.add(key);
    if (r.decision === "approved") approved.add(key);
  }
  return { approved, seen, any: rows.length > 0 };
}

interface Effective {
  promptId: string;
  text: string;
  state: "approved" | "edit_requested" | "removed" | "pending";
  carried: boolean;
}

/** Each question's effective state for this version (pure over the reads). */
function effectiveStates(qs: ProposedQuestionSet, latest: Latest, prior: Awaited<ReturnType<typeof priorWording>>): Effective[] {
  return qs.questions.map((q) => {
    const d = latest.get(q.promptId);
    if (d) return { promptId: q.promptId, text: q.text, state: d.decision, carried: false };
    const carried = prior.approved.has(normalizePromptText(q.text));
    return { promptId: q.promptId, text: q.text, state: carried ? "approved" : "pending", carried };
  });
}

/** Questions whose latest portal decision asks for an edit or removal. */
export async function openPortalRequests(versionId: string): Promise<number> {
  const latest = await latestDecisions(versionId);
  return [...latest.values()].filter((d) => d.decision !== "approved").length;
}

/** Operator view of a version's portal review (staff page). */
export async function operatorReviewSummary(qs: ProposedQuestionSet, engagementId?: string): Promise<{ reviewed: number; counts: Record<QuestionReviewDecision, number> & { carried: number }; requests: { text: string; decision: QuestionReviewDecision; comment: string }[] }> {
  const latest = await latestDecisions(qs.versionId);
  const prior = engagementId ? await priorWording(engagementId, qs.versionId) : { approved: new Set<string>(), seen: new Set<string>(), any: false };
  const counts = { approved: 0, edit_requested: 0, removed: 0, carried: 0 };
  const requests: { text: string; decision: QuestionReviewDecision; comment: string }[] = [];
  for (const s of effectiveStates(qs, latest, prior)) {
    if (s.state === "pending") continue;
    if (s.carried) counts.carried += 1;
    else counts[s.state] += 1;
    const d = latest.get(s.promptId);
    if (d && d.decision !== "approved") requests.push({ text: s.text, decision: d.decision, comment: d.comment });
  }
  return { reviewed: counts.approved + counts.edit_requested + counts.removed + counts.carried, counts, requests };
}

const stageOpen = (e: EngagementRow) => (ONBOARDING_OPEN_STAGES as readonly string[]).includes(e.stage);

async function versionLocked(e: EngagementRow, versionId: string): Promise<boolean> {
  const latest = (await listSubjectDecisions(e.id, "question_set")).find((d) => d.subjectRef === versionId);
  if (latest?.decision === "approved") return true;
  return (await listProtocols(e.id)).some((p) => p.status === "accepted" && p.promptSetVersionId === versionId);
}

/** The draft protocol on the version under review, and why it can't be approved yet. */
async function planState(e: EngagementRow, qs: ProposedQuestionSet, states: Effective[]): Promise<QuestionReviewView["plan"]> {
  const draft = (await listProtocols(e.id)).find((p) => p.status === "draft" && p.promptSetVersionId === qs.versionId);
  if (!draft) return null;
  const blockers = await protocolAcceptanceBlockers(e, draft);
  const notApproved = states.filter((s) => s.state !== "approved").length;
  if (notApproved > 0) blockers.unshift(`${notApproved} question(s) are not approved yet.`);
  return { protocolId: draft.id, version: draft.version, ready: blockers.length === 0, blockers };
}

/** The review of the version under review, or null when none. */
export async function portalQuestionReview(user: CurrentUser, projectId: string): Promise<QuestionReviewView | null> {
  await assertProjectAccess(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const qs = await proposedQuestionSet(e.id, e.projectId);
  if (!qs || qs.questions.length === 0) return null;
  const [latest, prior] = await Promise.all([latestDecisions(qs.versionId), priorWording(e.id, qs.versionId)]);
  const states = effectiveStates(qs, latest, prior);
  const decision = (await listSubjectDecisions(e.id, "question_set")).find((d) => d.subjectRef === qs.versionId) ?? null;
  const locked = await versionLocked(e, qs.versionId);
  const groups = new Map<string, ReviewedQuestionView[]>();
  const counts = { approved: 0, edit_requested: 0, removed: 0, carried: 0 };
  qs.questions.forEach((q, n) => {
    const d = latest.get(q.promptId) ?? null;
    const s = states[n]!;
    if (s.carried) counts.carried += 1;
    else if (s.state !== "pending") counts[s.state] += 1;
    const key = normalizePromptText(q.text);
    const seg = segmentOf(q);
    groups.set(seg, [
      ...(groups.get(seg) ?? []),
      { promptId: q.promptId, text: q.text, neighborhood: q.neighborhood, decision: d?.decision ?? null, comment: d?.comment ?? "", decidedAt: d?.decidedAt ?? null, carried: s.carried, revised: prior.any && !prior.seen.has(key) },
    ]);
  });
  const reviewed = states.filter((s) => s.state !== "pending").length;
  const approver = isClientApprover(user) && stageOpen(e);
  return {
    versionId: qs.versionId,
    version: qs.version,
    setName: qs.setName,
    total: qs.questions.length,
    reviewed,
    remaining: qs.questions.length - reviewed,
    counts,
    groups: [...groups.entries()].map(([segment, questions]) => ({ segment, questions })),
    submitted: decision ? { decision: decision.decision, decidedAt: decision.decidedAt, channel: decision.channel } : null,
    locked,
    canRespond: approver && !locked,
    readOnlyReason: !isClient(user) ? "staff_preview" : !isClientApprover(user) ? "viewer" : null,
    plan: locked ? null : await planState(e, qs, states),
  };
}

async function clientReviewContext(user: CurrentUser, projectId: string, versionId: string): Promise<{ e: EngagementRow; qs: ProposedQuestionSet }> {
  await assertClientApprover(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e || !stageOpen(e)) throw new ClassifiedError("not_found", "There are no questions to review right now.");
  const qs = await proposedQuestionSet(e.id, e.projectId);
  if (!qs || qs.versionId !== versionId) throw new ClassifiedError("conflict", "These questions have been updated. Please reload the page.");
  if (await versionLocked(e, qs.versionId)) throw new ClassifiedError("conflict", "These questions are already approved.");
  return { e, qs };
}

const reviewSchema = z.object({
  projectId: idSchema,
  versionId: idSchema,
  items: z
    .array(z.object({ promptId: idSchema, decision: z.enum(QUESTION_REVIEW_DECISIONS), comment: z.string().trim().max(QUESTION_COMMENT_MAX, "Keep comments under 1,000 characters.").default("") }))
    .min(1)
    .max(500),
});

/** Record one or more per-question decisions (each saves immediately). */
export async function reviewQuestions(user: CurrentUser, raw: unknown): Promise<ActionResult<{ recorded: number }>> {
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    const { e, qs } = await clientReviewContext(user, i.projectId, i.versionId);
    const allowed = new Set(qs.questions.map((q) => q.promptId));
    if (i.items.some((x) => !allowed.has(x.promptId))) throw new ClassifiedError("validation", "That question is not part of this review.");
    await insertReviews(user, e, qs.versionId, i.items, "single");
    return ok({ recorded: i.items.length });
  } catch (err) {
    return fail(err);
  }
}

const approveRemainingSchema = z.object({ projectId: idSchema, versionId: idSchema, segment: z.string().trim().max(200).nullable().default(null) });

/** Batch: approve every question that has no decision and no carried
 * approval (optionally one segment). Never overwrites a decision. */
export async function approveRemainingQuestions(user: CurrentUser, raw: unknown): Promise<ActionResult<{ recorded: number }>> {
  const parsed = approveRemainingSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    const { e, qs } = await clientReviewContext(user, i.projectId, i.versionId);
    const states = effectiveStates(qs, await latestDecisions(qs.versionId), await priorWording(e.id, qs.versionId));
    const targets = qs.questions.filter((q, n) => states[n]!.state === "pending" && (i.segment === null || segmentOf(q) === i.segment));
    if (targets.length === 0) return ok({ recorded: 0 });
    await insertReviews(user, e, qs.versionId, targets.map((q) => ({ promptId: q.promptId, decision: "approved" as const, comment: "" })), "batch");
    return ok({ recorded: targets.length });
  } catch (err) {
    return fail(err);
  }
}

async function insertReviews(user: CurrentUser, e: EngagementRow, versionId: string, items: { promptId: string; decision: QuestionReviewDecision; comment: string }[], mode: "single" | "batch"): Promise<void> {
  const actor = clientActorOf(user);
  await sql.begin(async (tx) => {
    for (const x of items) {
      await tx`
        insert into client_question_reviews (engagement_id, project_id, prompt_set_version_id, prompt_id, decision, comment, decided_by, client_actor)
        values (${e.id}, ${e.projectId}, ${versionId}, ${x.promptId}, ${x.decision}, ${x.comment}, ${user.id}, ${actor})
      `;
    }
    await writeAudit(tx, {
      userId: user.id,
      action: "engagement.client_question_review",
      entity: "client_engagement",
      entityId: e.id,
      projectId: e.projectId,
      detail: { versionId, mode, count: items.length, decisions: items.map((x) => ({ promptId: x.promptId, decision: x.decision })), channel: "portal" },
    });
  });
}

/**
 * "Send my review" (R3): feedback, never an approval. Refused until every
 * question has a decision or a carried approval. Any open edit/removal →
 * `changes_requested` (with the requests); otherwise `acknowledged` — the
 * review is done and the binding approval is approveMeasurementPlan.
 */
export async function submitQuestionReview(user: CurrentUser, raw: unknown): Promise<ActionResult<{ decision: "acknowledged" | "changes_requested" }>> {
  const parsed = z.object({ projectId: idSchema, versionId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    const { e, qs } = await clientReviewContext(user, parsed.data.projectId, parsed.data.versionId);
    const latest = await latestDecisions(qs.versionId);
    const states = effectiveStates(qs, latest, await priorWording(e.id, qs.versionId));
    const remaining = states.filter((s) => s.state === "pending").length;
    if (remaining > 0) throw new ClassifiedError("validation", `${remaining} question(s) still need a decision.`);
    const pinned = await questionSetSnapshot(e, qs.versionId);
    if (!pinned) throw new ClassifiedError("not_found", "There are no questions to review right now.");
    const requests = states
      .filter((s) => s.state === "edit_requested" || s.state === "removed")
      .map((s) => ({ promptId: s.promptId, text: s.text, decision: s.state, comment: latest.get(s.promptId)?.comment ?? "" }));
    const decision = requests.length === 0 ? "acknowledged" : "changes_requested";
    const note = requests.length === 0 ? "Review complete; awaiting the measurement-plan approval." : `${requests.filter((r) => r.decision === "edit_requested").length} edit(s) requested, ${requests.filter((r) => r.decision === "removed").length} removal(s).`;
    await sql.begin(async (tx) => {
      await tx`
        insert into engagement_client_decisions (engagement_id, project_id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by)
        values (${e.id}, ${e.projectId}, 'question_set', ${qs.versionId}, ${decision}, 'portal', ${clientActorOf(user)}, ${note},
          ${tx.json({ ...pinned, reviewVersion: PORTAL_REVIEW_VERSION, approved: states.filter((s) => s.state === "approved").length, carried: states.filter((s) => s.carried).length, requests } as never)}, ${user.id})
      `;
      await writeAudit(tx, { userId: user.id, action: "engagement.client_decision", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { subjectKind: "question_set", subjectRef: qs.versionId, decision, channel: "portal", requests: requests.length } });
    });
    return ok({ decision });
  } catch (err) {
    return fail(err);
  }
}

const planSchema = z.object({
  projectId: idSchema,
  versionId: idSchema,
  protocolId: idSchema,
  /** The approver ticked the explicit confirmation. */
  confirm: z.literal(true, { message: "Please confirm you've reviewed the measurement plan." }),
});

/**
 * The binding approval (R3). In ONE transaction: an `approved` question-set
 * decision on the exact version (content-hash pinned) and acceptance of the
 * draft protocol that cites it, with the approver as the accepting client.
 * Refused unless every question on the version is approved for its exact
 * wording, no portal request is open, the protocol is complete, and no
 * baseline is locked.
 */
export async function approveMeasurementPlan(user: CurrentUser, raw: unknown): Promise<ActionResult<{ protocolId: string; versionId: string }>> {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    const { e, qs } = await clientReviewContext(user, i.projectId, i.versionId);
    const p = await loadProtocol(i.protocolId);
    if (!p || p.engagementId !== e.id) throw new ClassifiedError("not_found", "That measurement plan is not available.");
    if (p.promptSetVersionId !== qs.versionId) throw new ClassifiedError("conflict", "This plan cites a different question set. Please reload the page.");
    const latest = await latestDecisions(qs.versionId);
    const states = effectiveStates(qs, latest, await priorWording(e.id, qs.versionId));
    const notApproved = states.filter((s) => s.state !== "approved");
    if (notApproved.length > 0) throw new ClassifiedError("validation", `${notApproved.length} question(s) are not approved for their exact wording yet.`);
    const blockers = await protocolAcceptanceBlockers(e, p);
    if (blockers.length > 0) throw new ClassifiedError("conflict", blockers[0]!);
    const pinned = await questionSetSnapshot(e, qs.versionId);
    if (!pinned) throw new ClassifiedError("not_found", "That measurement plan is not available.");
    const actor = clientActorOf(user);
    await sql.begin(async (tx) => {
      await tx`
        insert into engagement_client_decisions (engagement_id, project_id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by)
        values (${e.id}, ${e.projectId}, 'question_set', ${qs.versionId}, 'approved', 'portal', ${actor}, 'Approved with the measurement plan.',
          ${tx.json({ ...pinned, reviewVersion: PORTAL_REVIEW_VERSION, protocolId: p.id, protocolVersion: p.version, direct: states.filter((s) => !s.carried).length, carried: states.filter((s) => s.carried).length } as never)}, ${user.id})
      `;
      await acceptProtocolInTx(tx, { userId: user.id, clientActor: actor, channel: "portal", note: "Approved in the client portal with the final question set." }, e, p);
    });
    return ok({ protocolId: p.id, versionId: qs.versionId });
  } catch (err) {
    return fail(err);
  }
}
