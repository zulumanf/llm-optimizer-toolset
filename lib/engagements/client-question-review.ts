/**
 * Client review of the proposed customer questions in the portal (spec 155).
 *
 * Append-only: every Approve / Request edit / Remove is a new
 * `client_question_reviews` row; the latest row per question is its state, so
 * progress, save and resume are derived. "Send my review" writes the
 * set-level `question_set` decision through the same ledger and the same
 * version pin as staff-recorded decisions. Once an approved decision exists on
 * the version, the review is locked — the frozen version is what gets measured.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertClientRespondent, assertProjectAccess, isClient, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { engagementForProject, type EngagementRow } from "@/lib/engagements/service";
import { listSubjectDecisions, proposedQuestionSet, questionSetSnapshot, type ProposedQuestionSet } from "@/lib/engagements/delivery";
import { clientActorOf } from "@/lib/engagements/client-onboarding";
import { ONBOARDING_OPEN_STAGES } from "@/lib/engagements/client-onboarding-rules";
import { segmentOf } from "@/lib/engagements/question-review";
export { OTHER_SEGMENT, segmentOf } from "@/lib/engagements/question-review";

export const QUESTION_REVIEW_DECISIONS = ["approved", "edit_requested", "removed"] as const;
export type QuestionReviewDecision = (typeof QUESTION_REVIEW_DECISIONS)[number];
export const QUESTION_COMMENT_MAX = 1000;
export const PORTAL_REVIEW_VERSION = "portal-question-review-v1";

const idSchema = z.string().uuid();

export interface ReviewedQuestionView {
  promptId: string;
  text: string;
  neighborhood: string | null;
  decision: QuestionReviewDecision | null;
  comment: string;
  decidedAt: Date | null;
}

export interface QuestionReviewView {
  versionId: string;
  version: number;
  total: number;
  reviewed: number;
  remaining: number;
  counts: Record<QuestionReviewDecision, number>;
  groups: { segment: string; questions: ReviewedQuestionView[] }[];
  /** Set-level decision on this version, if any. */
  submitted: { decision: string; decidedAt: Date; channel: string } | null;
  locked: boolean;
  canRespond: boolean;
}

/** Latest decision per question on a version (pure SQL read). */
async function latestDecisions(versionId: string): Promise<Map<string, { decision: QuestionReviewDecision; comment: string; decidedAt: Date }>> {
  const rows = await sql`
    select distinct on (prompt_id) prompt_id, decision, comment, decided_at
    from client_question_reviews where prompt_set_version_id = ${versionId}
    order by prompt_id, decided_at desc, id desc
  `;
  return new Map(rows.map((r) => [r.promptId as string, { decision: r.decision as QuestionReviewDecision, comment: (r.comment as string) ?? "", decidedAt: r.decidedAt as Date }]));
}

/** Questions whose latest portal decision asks for an edit or removal. */
export async function openPortalRequests(versionId: string): Promise<number> {
  const latest = await latestDecisions(versionId);
  return [...latest.values()].filter((d) => d.decision !== "approved").length;
}

/** Operator view of a version's portal review (staff page; no auth here,
 * the delivery page is staff-gated). */
export async function operatorReviewSummary(qs: ProposedQuestionSet): Promise<{ reviewed: number; counts: Record<QuestionReviewDecision, number>; requests: { text: string; decision: QuestionReviewDecision; comment: string }[] }> {
  const latest = await latestDecisions(qs.versionId);
  const counts: Record<QuestionReviewDecision, number> = { approved: 0, edit_requested: 0, removed: 0 };
  const requests: { text: string; decision: QuestionReviewDecision; comment: string }[] = [];
  for (const q of qs.questions) {
    const d = latest.get(q.promptId);
    if (!d) continue;
    counts[d.decision] += 1;
    if (d.decision !== "approved") requests.push({ text: q.text, decision: d.decision, comment: d.comment });
  }
  return { reviewed: counts.approved + counts.edit_requested + counts.removed, counts, requests };
}

function buildView(qs: ProposedQuestionSet, latest: Awaited<ReturnType<typeof latestDecisions>>, submitted: QuestionReviewView["submitted"], canRespond: boolean): QuestionReviewView {
  const groups = new Map<string, ReviewedQuestionView[]>();
  const counts: Record<QuestionReviewDecision, number> = { approved: 0, edit_requested: 0, removed: 0 };
  for (const q of qs.questions) {
    const d = latest.get(q.promptId) ?? null;
    if (d) counts[d.decision] += 1;
    const seg = segmentOf(q);
    groups.set(seg, [...(groups.get(seg) ?? []), { promptId: q.promptId, text: q.text, neighborhood: q.neighborhood, decision: d?.decision ?? null, comment: d?.comment ?? "", decidedAt: d?.decidedAt ?? null }]);
  }
  const reviewed = counts.approved + counts.edit_requested + counts.removed;
  const locked = submitted?.decision === "approved";
  return {
    versionId: qs.versionId,
    version: qs.version,
    total: qs.questions.length,
    reviewed,
    remaining: qs.questions.length - reviewed,
    counts,
    groups: [...groups.entries()].map(([segment, questions]) => ({ segment, questions })),
    submitted,
    locked,
    canRespond: canRespond && !locked,
  };
}

const stageOpen = (e: EngagementRow) => (ONBOARDING_OPEN_STAGES as readonly string[]).includes(e.stage);

/** The client's review of the version under review, or null when none. */
export async function portalQuestionReview(user: CurrentUser, projectId: string): Promise<QuestionReviewView | null> {
  await assertProjectAccess(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const qs = await proposedQuestionSet(e.id, e.projectId);
  if (!qs || qs.questions.length === 0) return null;
  const latest = await latestDecisions(qs.versionId);
  const decision = (await listSubjectDecisions(e.id, "question_set")).find((d) => d.subjectRef === qs.versionId) ?? null;
  return buildView(qs, latest, decision ? { decision: decision.decision, decidedAt: decision.decidedAt, channel: decision.channel } : null, isClient(user) && stageOpen(e));
}

async function clientReviewContext(user: CurrentUser, projectId: string, versionId: string): Promise<{ e: EngagementRow; qs: ProposedQuestionSet }> {
  await assertClientRespondent(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e || !stageOpen(e)) throw new ClassifiedError("not_found", "There are no questions to review right now.");
  const qs = await proposedQuestionSet(e.id, e.projectId);
  if (!qs || qs.versionId !== versionId) throw new ClassifiedError("conflict", "These questions have been updated. Please reload the page.");
  const decided = (await listSubjectDecisions(e.id, "question_set")).find((d) => d.subjectRef === qs.versionId);
  if (decided?.decision === "approved") throw new ClassifiedError("conflict", "These questions are already approved.");
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

/** Batch: approve every not-yet-reviewed question (optionally one segment).
 * Never overwrites a decision the client already made. */
export async function approveRemainingQuestions(user: CurrentUser, raw: unknown): Promise<ActionResult<{ recorded: number }>> {
  const parsed = approveRemainingSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    const { e, qs } = await clientReviewContext(user, i.projectId, i.versionId);
    const latest = await latestDecisions(qs.versionId);
    const targets = qs.questions.filter((q) => !latest.has(q.promptId) && (i.segment === null || segmentOf(q) === i.segment));
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
 * "Send my review": the set-level decision. Refused until every question is
 * reviewed. All approved → `approved` (the version may then be measured);
 * anything else → `changes_requested` with the requests in the snapshot.
 */
export async function submitQuestionReview(user: CurrentUser, raw: unknown): Promise<ActionResult<{ decision: "approved" | "changes_requested" }>> {
  const parsed = z.object({ projectId: idSchema, versionId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    const { e, qs } = await clientReviewContext(user, parsed.data.projectId, parsed.data.versionId);
    const latest = await latestDecisions(qs.versionId);
    const remaining = qs.questions.filter((q) => !latest.has(q.promptId)).length;
    if (remaining > 0) throw new ClassifiedError("validation", `${remaining} question(s) still need a decision.`);
    const pinned = await questionSetSnapshot(e, qs.versionId);
    if (!pinned) throw new ClassifiedError("not_found", "There are no questions to review right now.");
    const requests = qs.questions
      .map((q) => ({ promptId: q.promptId, text: q.text, ...latest.get(q.promptId)! }))
      .filter((q) => q.decision !== "approved")
      .map((q) => ({ promptId: q.promptId, text: q.text, decision: q.decision, comment: q.comment }));
    const decision = requests.length === 0 ? "approved" : "changes_requested";
    const note = requests.length === 0 ? "" : `${requests.filter((r) => r.decision === "edit_requested").length} edit(s) requested, ${requests.filter((r) => r.decision === "removed").length} removal(s).`;
    await sql.begin(async (tx) => {
      await tx`
        insert into engagement_client_decisions (engagement_id, project_id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by)
        values (${e.id}, ${e.projectId}, 'question_set', ${qs.versionId}, ${decision}, 'portal', ${clientActorOf(user)}, ${note},
          ${tx.json({ ...pinned, reviewVersion: PORTAL_REVIEW_VERSION, approved: qs.questions.length - requests.length, requests } as never)}, ${user.id})
      `;
      await writeAudit(tx, { userId: user.id, action: "engagement.client_decision", entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: { subjectKind: "question_set", subjectRef: qs.versionId, decision, channel: "portal", requests: requests.length } });
    });
    return ok({ decision });
  } catch (err) {
    return fail(err);
  }
}
