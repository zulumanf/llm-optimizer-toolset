/**
 * Client delivery service (spec 154): welcome → details → questions →
 * protocol → baseline → roadmap → weekly updates and check-ins → Day-90
 * review → close, over the records spec 131 already keeps. Every write is
 * staff-only (assertCanWrite), audited, and scoped to one engagement; the
 * client's own view is assembled read-only in lib/portal/delivery.ts.
 *
 * Nothing here sends email, schedules calendar events, calls a third-party
 * measurement API, or decides a fee.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany } from "@/db/companies";
import { listComparisonCompanies } from "@/db/competitors";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { DECISION_CHANNELS } from "@/lib/engagements/constants";
import {
  engagementForProject,
  getEngagement,
  listContextItems,
  listMeasurements,
  type EngagementRow,
  type MeasurementRow,
} from "@/lib/engagements/service";
import { minPropertyValueFrom } from "@/lib/engagements/onboarding-intake";
import { reviewQuestionCsv, type QuestionReview } from "@/lib/engagements/question-review";
import {
  DECISION_SUBJECTS,
  EXTERNAL_QA_STATUSES,
  EXTERNAL_RAW_EXPORT_MAX,
  MEETING_KINDS,
  PLAN_PHASES,
  PROTOCOL_DEFAULTS,
  RECOMMENDATION_DISTINCTION,
  SUBJECT_DECISIONS,
  WEEKLY_WINDOW_DAYS,
  composeFinalReviewBody,
  composeWeeklyBody,
  composeWelcome,
  defaultCheckinAgenda,
  deliveryJourney,
  nextCheckinDue,
  offboardingChecklist,
  operatorNoteIssues,
  phaseWindows,
  planItemState,
  protocolMissing,
  questionChanges,
  rateView,
  type JourneyInput,
  type JourneyStep,
  type OffboardingItem,
  type UpdateBody,
  type WorkState,
} from "@/lib/engagements/delivery-rules";
import { addDays, commercialGate, todayIso } from "@/lib/engagements/rules";
import { usdToCents } from "@/lib/pricing/policy";

const idSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const plain = (v: unknown): Record<string, never> => JSON.parse(JSON.stringify(v)) as Record<string, never>;
const toIso = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
const MANUAL_PLAN_COMPOSER = "manual-plan-v1";

async function loadEngagement(engagementId: string): Promise<EngagementRow> {
  const e = await getEngagement(engagementId);
  if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
  return e;
}

async function audit(tx: TransactionSql, user: CurrentUser, e: EngagementRow, action: string, detail: Record<string, unknown>): Promise<void> {
  await writeAudit(tx, { userId: user.id, action, entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: plain(detail) });
}

/** A question-set version this engagement may measure on: one frozen in the
 * client project, or the version behind a pre-sale benchmark linked to the
 * engagement's own prospect (the spec-131 shared-market case). */
async function versionAllowed(e: EngagementRow, versionId: string): Promise<boolean> {
  const [hit] = await sql`
    select 1 as ok from prompt_set_versions v join prompt_sets s on s.id = v.prompt_set_id
    where v.id = ${versionId} and s.project_id = ${e.projectId}
    union all
    select 1 from prospect_benchmarks b join runs r on r.id = b.run_id
    where ${e.prospectId}::uuid is not null and b.prospect_id = ${e.prospectId}::uuid and r.prompt_set_version_id = ${versionId}
    limit 1
  `;
  return Boolean(hit);
}

// ------------------------------------------------------------ question set

export interface ProposedQuestionSet {
  setId: string;
  setName: string;
  versionId: string;
  version: number;
  frozenAt: Date;
  questions: { promptId: string; text: string; priceTier: string | null; neighborhood: string | null; audience: string | null }[];
  decision: SubjectDecisionRow | null;
}

/** The question-set version under review: the one the latest protocol cites,
 * else the newest frozen version of a set in this client project. */
export async function proposedQuestionSet(engagementId: string, projectId: string): Promise<ProposedQuestionSet | null> {
  const [p] = await sql`
    select prompt_set_version_id from engagement_protocols where engagement_id = ${engagementId}
    order by (status = 'accepted') desc, version desc limit 1
  `;
  const [row] = p
    ? await sql`
        select v.id, v.version, v.frozen_at, v.frozen_prompts, s.id as set_id, s.name
        from prompt_set_versions v join prompt_sets s on s.id = v.prompt_set_id
        where v.id = ${p.promptSetVersionId as string}`
    : await sql`
        select v.id, v.version, v.frozen_at, v.frozen_prompts, s.id as set_id, s.name
        from prompt_set_versions v join prompt_sets s on s.id = v.prompt_set_id
        where s.project_id = ${projectId} and s.archived_at is null
        order by v.frozen_at desc limit 1`;
  if (!row) return null;
  const frozen = (row.frozenPrompts as { promptId: string; text: string; isHoldout?: boolean; priceTier?: string | null; neighborhood?: string | null; audience?: string | null; position: number }[]) ?? [];
  const decisions = await listSubjectDecisions(engagementId, "question_set");
  return {
    setId: row.setId as string,
    setName: row.name as string,
    versionId: row.id as string,
    version: Number(row.version),
    frozenAt: row.frozenAt as Date,
    questions: [...frozen]
      .filter((q) => !q.isHoldout)
      .sort((a, b) => a.position - b.position)
      .map((q) => ({ promptId: q.promptId, text: q.text, priceTier: q.priceTier ?? null, neighborhood: q.neighborhood ?? null, audience: q.audience ?? null })),
    decision: decisions.find((d) => d.subjectRef === (row.id as string)) ?? null,
  };
}

/** Names that make a measurement question "branded": subject + tracked
 * competitors (with aliases) + client-confirmed name variants. Never the
 * whole company registry (audit P1-11). */
async function brandNames(e: EngagementRow): Promise<{ id: string; name: string; aliases: string[] }[]> {
  const subject = await getSubjectCompany(e.projectId);
  const comps = await listComparisonCompanies(e.projectId);
  const ids = comps.map((c) => c.companyId);
  const rows = ids.length > 0 ? await sql`select id, name, aliases from companies where id = any(${ids}::uuid[])` : [];
  const variants = (await listContextItems(e.id))
    .filter((x) => x.kind === "identity" && typeof x.value.nameVariant === "string")
    .map((x) => x.value.nameVariant as string);
  const out = rows.map((r) => ({ id: r.id as string, name: r.name as string, aliases: (r.aliases as string[]) ?? [] }));
  if (subject && !out.some((c) => c.id === subject.id)) out.push({ id: subject.id, name: subject.name, aliases: subject.aliases ?? [] });
  if (variants.length > 0) out.push({ id: "00000000-0000-0000-0000-000000000000", name: variants[0]!, aliases: variants.slice(1) });
  return out;
}

const importSchema = z.object({
  engagementId: idSchema,
  setName: z.string().trim().min(1).max(120),
  content: z.string().min(1, "Paste the CSV export.").max(500_000),
  /** Apply the client-confirmed minimum property value as a hard floor. */
  applyPriceFloor: z.boolean().default(true),
  requireSellerIntent: z.boolean().default(true),
  defaultAudience: z.string().trim().max(60).nullable().default(null),
  /** Validate only; write nothing. */
  dryRun: z.boolean().default(false),
});

export interface QuestionImportResult {
  review: QuestionReview;
  floorUsd: number | null;
  setId: string | null;
  versionId: string | null;
  version: number | null;
}

/**
 * Import the client-reviewed questions into a NEW prompt set on the client
 * project and freeze it as the proposed version. Refuses on any blocking
 * issue — nothing is partially written. The frozen version is immutable;
 * it becomes the measurement set only after the client approves it and a
 * protocol citing it is accepted.
 */
export async function importClientQuestions(user: CurrentUser, raw: unknown): Promise<ActionResult<QuestionImportResult>> {
  const parsed = importSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await loadEngagement(i.engagementId);
    const floorUsd = i.applyPriceFloor ? minPropertyValueFrom(await listContextItems(e.id)) : null;
    const review = reviewQuestionCsv(i.content, {
      minPropertyValueUsd: floorUsd,
      brands: await brandNames(e),
      requireSellerIntent: i.requireSellerIntent,
      defaultAudience: i.defaultAudience,
    });
    if (i.dryRun || !review.ok) {
      if (!i.dryRun) {
        const first = review.issues.find((x) => x.severity === "blocking");
        return fail(new ClassifiedError("validation", `Import refused: ${review.issues.filter((x) => x.severity === "blocking").length} blocking issue(s). First — line ${first?.line}: ${first?.message}`));
      }
      return ok({ review, floorUsd, setId: null, versionId: null, version: null });
    }
    const { createPromptSet, freezePromptSet } = await import("@/lib/prompts/set-service");
    const set = await createPromptSet(user, { projectId: e.projectId, name: i.setName, description: `Client-reviewed question set (spec 154, ${review.version}).` });
    if (!set.ok) return set;
    await sql.begin(async (tx) => {
      let position = 0;
      for (const r of review.rows) {
        position += 1;
        await tx`
          insert into prompts (prompt_set_id, text, category, language, position, source, audience, price_tier, neighborhood, property_type)
          values (${set.data.id}, ${r.text}, ${r.category}, 'en', ${position}, 'import', ${r.audience}, ${r.priceTier}, ${r.neighborhood}, ${r.propertyType})
        `;
      }
      await audit(tx, user, e, "engagement.questions_imported", {
        setId: set.data.id,
        imported: review.rows.length,
        excluded: review.excluded.length,
        warnings: review.issues.length,
        segments: review.segments,
        floorUsd,
        reviewVersion: review.version,
      });
    });
    const frozen = await freezePromptSet(user, { id: set.data.id });
    if (!frozen.ok) return frozen;
    const [v] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.data.id} and version = ${frozen.data.version}`;
    return ok({ review, floorUsd, setId: set.data.id, versionId: v!.id as string, version: frozen.data.version });
  } catch (err) {
    return fail(err);
  }
}

// --------------------------------------------------------- decisions

export interface SubjectDecisionRow {
  id: string;
  subjectKind: string;
  subjectRef: string;
  decision: string;
  channel: string;
  clientActor: string;
  note: string;
  snapshot: Record<string, unknown>;
  recordedBy: string | null;
  decidedAt: Date;
}

export async function listSubjectDecisions(engagementId: string, kind?: string): Promise<SubjectDecisionRow[]> {
  const rows = await sql`
    select id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by, decided_at
    from engagement_client_decisions
    where engagement_id = ${engagementId} ${kind ? sql`and subject_kind = ${kind}` : sql``}
    order by decided_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    subjectKind: r.subjectKind as string,
    subjectRef: r.subjectRef as string,
    decision: r.decision as string,
    channel: r.channel as string,
    clientActor: r.clientActor as string,
    note: (r.note as string) ?? "",
    snapshot: (r.snapshot as Record<string, unknown>) ?? {},
    recordedBy: (r.recordedBy as string | null) ?? null,
    decidedAt: r.decidedAt as Date,
  }));
}

/** Pins exactly which question wording a decision is about. Shared by staff
 * channel decisions and the client's portal review (spec 155). Null when the
 * version is not one this engagement may measure on. */
export async function questionSetSnapshot(e: EngagementRow, versionId: string): Promise<{ versionId: string; version: number; questionCount: number; contentSha256: string } | null> {
  if (!(await versionAllowed(e, versionId))) return null;
  const [v] = await sql`select v.id, v.version, v.frozen_prompts from prompt_set_versions v where v.id = ${versionId}`;
  if (!v) return null;
  const texts = ((v.frozenPrompts as { text: string }[]) ?? []).map((q) => q.text);
  return { versionId: v.id as string, version: Number(v.version), questionCount: texts.length, contentSha256: createHash("sha256").update(JSON.stringify(texts)).digest("hex") };
}

/** Spec 155 freeze gate: a version whose portal review still carries an
 * edit or removal request cannot be approved or measured on. */
async function assertNoOpenPortalRequests(versionId: string): Promise<void> {
  const { openPortalRequests } = await import("@/lib/engagements/client-question-review");
  const open = await openPortalRequests(versionId);
  if (open > 0) {
    throw new ClassifiedError("validation", `The client asked for changes to ${open} question(s) in the portal. Import a revised version instead of approving this one.`);
  }
}

const decisionSchema = z.object({
  engagementId: idSchema,
  subjectKind: z.enum(DECISION_SUBJECTS),
  subjectRef: z.string().trim().max(200).default(""),
  decision: z.enum(SUBJECT_DECISIONS),
  channel: z.enum(DECISION_CHANNELS),
  clientActor: z.string().trim().min(1, "Who decided on the client side?").max(200),
  note: z.string().trim().max(2000).default(""),
}).refine((v) => !["question_set", "protocol", "roadmap"].includes(v.subjectKind) || idSchema.safeParse(v.subjectRef).success, {
  message: "This decision must reference the exact version it is about.",
});

/**
 * Record a client decision made through a channel (email, call, meeting).
 * Append-only. The snapshot pins exactly what was decided on, so a later
 * edit can never inherit an earlier approval.
 */
export async function recordSubjectDecision(user: CurrentUser, raw: unknown): Promise<ActionResult<{ decisionId: string }>> {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await loadEngagement(i.engagementId);
    let snapshot: Record<string, unknown> = {};
    if (i.subjectKind === "question_set") {
      const pinned = await questionSetSnapshot(e, i.subjectRef);
      if (!pinned) throw new ClassifiedError("not_found", "Question set version not found for this client.");
      if (i.decision === "approved") await assertNoOpenPortalRequests(i.subjectRef);
      snapshot = pinned;
    } else if (i.subjectKind === "protocol") {
      if (i.decision === "approved") throw new ClassifiedError("validation", "Use \"Record acceptance\" on the protocol — acceptance freezes it.");
      const [p] = await sql`select id, version from engagement_protocols where id = ${i.subjectRef} and engagement_id = ${e.id}`;
      if (!p) throw new ClassifiedError("not_found", "Protocol not found for this engagement.");
      snapshot = { protocolId: p.id, version: Number(p.version) };
    } else if (i.subjectKind === "roadmap") {
      const [p] = await sql`select id, composition_hash from program_plans where id = ${i.subjectRef} and project_id = ${e.projectId}`;
      if (!p) throw new ClassifiedError("not_found", "Plan not found for this client.");
      snapshot = { planId: p.id, compositionHash: p.compositionHash };
    }
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into engagement_client_decisions (engagement_id, project_id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by)
        values (${e.id}, ${e.projectId}, ${i.subjectKind}, ${i.subjectRef}, ${i.decision}, ${i.channel}, ${i.clientActor}, ${i.note}, ${tx.json(snapshot as never)}, ${user.id})
        returning id
      `;
      await audit(tx, user, e, "engagement.client_decision", { ...i, snapshot });
      return row!.id as string;
    });
    return ok({ decisionId: id });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------- protocol

export interface ProtocolRow {
  id: string;
  version: number;
  promptSetVersionId: string;
  provider: string;
  model: string;
  geographicContext: string;
  repetitions: number;
  baselineWindow: string;
  finalWindow: string;
  recommendationRubric: string;
  comparisonRules: string;
  caveats: string;
  adjudication: string;
  successCriteria: string;
  entityAliases: string[];
  externalSources: string;
  status: "draft" | "accepted" | "superseded";
  acceptedAt: Date | null;
  acceptedByName: string | null;
  acceptedChannel: string | null;
  createdAt: Date;
}

function mapProtocol(r: Record<string, unknown>): ProtocolRow {
  return {
    id: r.id as string,
    version: Number(r.version),
    promptSetVersionId: r.promptSetVersionId as string,
    provider: r.provider as string,
    model: r.model as string,
    geographicContext: (r.geographicContext as string) ?? "",
    repetitions: Number(r.repetitions),
    baselineWindow: (r.baselineWindow as string) ?? "",
    finalWindow: (r.finalWindow as string) ?? "",
    recommendationRubric: (r.recommendationRubric as string) ?? "",
    comparisonRules: (r.comparisonRules as string) ?? "",
    caveats: (r.caveats as string) ?? "",
    adjudication: (r.adjudication as string) ?? "",
    successCriteria: (r.successCriteria as string) ?? "",
    entityAliases: (r.entityAliases as string[]) ?? [],
    externalSources: (r.externalSources as string) ?? "",
    status: r.status as ProtocolRow["status"],
    acceptedAt: (r.acceptedAt as Date | null) ?? null,
    acceptedByName: (r.acceptedByName as string | null) ?? null,
    acceptedChannel: (r.acceptedChannel as string | null) ?? null,
    createdAt: r.createdAt as Date,
  };
}

export async function listProtocols(engagementId: string): Promise<ProtocolRow[]> {
  const rows = await sql`select * from engagement_protocols where engagement_id = ${engagementId} order by version desc`;
  return rows.map(mapProtocol);
}

const protocolSchema = z.object({
  engagementId: idSchema,
  promptSetVersionId: idSchema,
  provider: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(120),
  geographicContext: z.string().trim().max(1000).default(""),
  repetitions: z.number().int().min(1).max(20),
  baselineWindow: z.string().trim().max(500).default(""),
  finalWindow: z.string().trim().max(500).default(""),
  recommendationRubric: z.string().trim().max(4000).default(PROTOCOL_DEFAULTS.recommendationRubric),
  comparisonRules: z.string().trim().max(4000).default(PROTOCOL_DEFAULTS.comparisonRules),
  caveats: z.string().trim().max(4000).default(PROTOCOL_DEFAULTS.caveats),
  adjudication: z.string().trim().max(4000).default(PROTOCOL_DEFAULTS.adjudication),
  successCriteria: z.string().trim().max(4000).default(""),
  entityAliases: z.array(z.string().trim().min(2).max(200)).max(30).default([]),
  externalSources: z.string().trim().max(2000).default(PROTOCOL_DEFAULTS.externalSources),
});

/** Create the next draft version, or update the existing draft. Accepted
 * versions are frozen by the database; this never touches them. */
export async function saveProtocolDraft(user: CurrentUser, raw: unknown): Promise<ActionResult<{ protocolId: string; version: number }>> {
  const parsed = protocolSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await loadEngagement(i.engagementId);
    if (!(await versionAllowed(e, i.promptSetVersionId))) {
      return fail(new ClassifiedError("validation", "The question set version must belong to this client's project (or its linked pre-sale benchmark)."));
    }
    const result = await sql.begin(async (tx) => {
      await tx`select id from client_engagements where id = ${e.id} for update`;
      const [draft] = await tx`select id, version from engagement_protocols where engagement_id = ${e.id} and status = 'draft' order by version desc limit 1`;
      const aliases = [...new Set(i.entityAliases)];
      if (draft) {
        await tx`
          update engagement_protocols set prompt_set_version_id = ${i.promptSetVersionId}, provider = ${i.provider}, model = ${i.model},
            geographic_context = ${i.geographicContext}, repetitions = ${i.repetitions}, baseline_window = ${i.baselineWindow},
            final_window = ${i.finalWindow}, recommendation_rubric = ${i.recommendationRubric}, comparison_rules = ${i.comparisonRules},
            caveats = ${i.caveats}, adjudication = ${i.adjudication}, success_criteria = ${i.successCriteria},
            entity_aliases = ${aliases}, external_sources = ${i.externalSources}, updated_at = now()
          where id = ${draft.id as string}
        `;
        await audit(tx, user, e, "engagement.protocol_draft_saved", { protocolId: draft.id, version: draft.version });
        return { protocolId: draft.id as string, version: Number(draft.version) };
      }
      const [max] = await tx`select coalesce(max(version), 0)::int as v from engagement_protocols where engagement_id = ${e.id}`;
      const version = Number(max?.v ?? 0) + 1;
      const [row] = await tx`
        insert into engagement_protocols (engagement_id, project_id, version, prompt_set_version_id, provider, model, geographic_context,
          repetitions, baseline_window, final_window, recommendation_rubric, comparison_rules, caveats, adjudication,
          success_criteria, entity_aliases, external_sources, created_by)
        values (${e.id}, ${e.projectId}, ${version}, ${i.promptSetVersionId}, ${i.provider}, ${i.model}, ${i.geographicContext},
          ${i.repetitions}, ${i.baselineWindow}, ${i.finalWindow}, ${i.recommendationRubric}, ${i.comparisonRules}, ${i.caveats},
          ${i.adjudication}, ${i.successCriteria}, ${aliases}, ${i.externalSources}, ${user.id})
        returning id
      `;
      await audit(tx, user, e, "engagement.protocol_draft_created", { protocolId: row!.id, version });
      return { protocolId: row!.id as string, version };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

const acceptSchema = z.object({
  protocolId: idSchema,
  clientActor: z.string().trim().min(1, "Who accepted on the client side?").max(200),
  channel: z.enum(DECISION_CHANNELS),
  note: z.string().trim().max(2000).default(""),
});

/**
 * The client accepts the protocol → it freezes. Requires: the cited
 * question-set version approved by the client (latest decision on it), every
 * required field stated, and no locked baseline (success criteria never
 * change after the starting point is measured).
 */
export async function acceptProtocol(user: CurrentUser, raw: unknown): Promise<ActionResult<{ protocolId: string }>> {
  const parsed = acceptSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const [row] = await sql`select * from engagement_protocols where id = ${i.protocolId}`;
    if (!row) return fail(new ClassifiedError("not_found", "Protocol not found."));
    const p = mapProtocol(row);
    if (p.status !== "draft") return fail(new ClassifiedError("conflict", `Protocol v${p.version} is already ${p.status}.`));
    const e = await loadEngagement(row.engagementId as string);
    const baseline = (await listMeasurements(e.id)).find((m) => m.role === "baseline" && m.status === "frozen");
    if (baseline) return fail(new ClassifiedError("conflict", "The baseline is locked. The agreed protocol cannot change during this term."));
    const latestOnSet = (await listSubjectDecisions(e.id, "question_set")).find((d) => d.subjectRef === p.promptSetVersionId);
    if (latestOnSet?.decision !== "approved") {
      return fail(new ClassifiedError("validation", "The client has not approved the question set this protocol cites. Record that approval first."));
    }
    await assertNoOpenPortalRequests(p.promptSetVersionId);
    const missing = protocolMissing(p);
    if (missing.length > 0) return fail(new ClassifiedError("validation", `The protocol still needs: ${missing.join(", ")}.`));
    await sql.begin(async (tx) => {
      await tx`update engagement_protocols set status = 'superseded' where engagement_id = ${e.id} and status = 'accepted'`;
      await tx`
        update engagement_protocols set status = 'accepted', accepted_at = now(), accepted_by_name = ${i.clientActor},
          accepted_channel = ${i.channel}, accepted_recorded_by = ${user.id}, updated_at = now()
        where id = ${p.id}
      `;
      await tx`
        insert into engagement_client_decisions (engagement_id, project_id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by)
        values (${e.id}, ${e.projectId}, 'protocol', ${p.id}, 'approved', ${i.channel}, ${i.clientActor}, ${i.note},
          ${tx.json({ protocolId: p.id, version: p.version, promptSetVersionId: p.promptSetVersionId, successCriteria: p.successCriteria } as never)}, ${user.id})
      `;
      await audit(tx, user, e, "engagement.protocol_accepted", { protocolId: p.id, version: p.version, clientActor: i.clientActor, channel: i.channel });
    });
    return ok({ protocolId: p.id });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------ updates

export interface UpdateRow {
  id: string;
  kind: string;
  periodStart: string | null;
  periodEnd: string | null;
  body: UpdateBody;
  status: string;
  channel: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

function mapUpdate(r: Record<string, unknown>): UpdateRow {
  return {
    id: r.id as string,
    kind: r.kind as string,
    periodStart: r.periodStart ? toIso(r.periodStart) : null,
    periodEnd: r.periodEnd ? toIso(r.periodEnd) : null,
    body: r.body as UpdateBody,
    status: r.status as string,
    channel: (r.channel as string | null) ?? null,
    sentAt: (r.sentAt as Date | null) ?? null,
    createdAt: r.createdAt as Date,
  };
}

export async function listUpdates(engagementId: string, opts: { sentOnly?: boolean } = {}): Promise<UpdateRow[]> {
  const rows = await sql`
    select * from engagement_updates where engagement_id = ${engagementId}
      ${opts.sentOnly ? sql`and status = 'sent'` : sql`and status <> 'discarded'`}
    order by coalesce(sent_at, created_at) desc
  `;
  return rows.map(mapUpdate);
}

async function upsertDraft(user: CurrentUser, e: EngagementRow, kind: string, body: UpdateBody, periodStart: string | null, periodEnd: string | null): Promise<string> {
  return sql.begin(async (tx) => {
    const [draft] = await tx`select id from engagement_updates where engagement_id = ${e.id} and kind = ${kind} and status = 'draft' for update`;
    let id: string;
    if (draft) {
      id = draft.id as string;
      await tx`update engagement_updates set body = ${tx.json(body as never)}, period_start = ${periodStart}, period_end = ${periodEnd}, updated_at = now() where id = ${id}`;
    } else {
      const [row] = await tx`
        insert into engagement_updates (engagement_id, project_id, kind, period_start, period_end, body, created_by)
        values (${e.id}, ${e.projectId}, ${kind}, ${periodStart}, ${periodEnd}, ${tx.json(body as never)}, ${user.id}) returning id
      `;
      id = row!.id as string;
    }
    await audit(tx, user, e, "engagement.update_drafted", { updateId: id, kind, periodStart, periodEnd, refs: body.refs.length });
    return id;
  });
}

const welcomeSchema = z.object({
  engagementId: idSchema,
  agencyContactName: z.string().trim().min(1).max(200),
  firstCheckinOn: dateSchema.nullable().default(null),
});

/** The one welcome message. Built from the engagement record; the operator
 * sends it from their own mailbox, then marks it sent. */
export async function generateWelcomeDraft(user: CurrentUser, raw: unknown): Promise<ActionResult<{ updateId: string; body: UpdateBody }>> {
  const parsed = welcomeSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await loadEngagement(i.engagementId);
    if (e.stage === "signed") return fail(new ClassifiedError("validation", "Clear the commercial gate (start onboarding) before welcoming the client."));
    const { portalLoginUrl } = await import("@/lib/portal/delivery");
    const body = composeWelcome({
      clientName: e.clientLegalName || e.marketName,
      contactName: e.primaryContactName || "there",
      agencyContactName: i.agencyContactName,
      marketName: e.marketName,
      scopeSummary: e.scopeSummary,
      startsOn: e.startsOn,
      endsOn: e.endsOn,
      portalUrl: portalLoginUrl(),
      nextAction: "Please look over the business details we have on file and the questions we propose to measure; we will walk through both together on our first call.",
      firstCheckinOn: i.firstCheckinOn,
    });
    const id = await upsertDraft(user, e, "welcome", body, null, null);
    return ok({ updateId: id, body });
  } catch (err) {
    return fail(err);
  }
}

/** Canonical inputs for the weekly update — rows only, nothing generated. */
export async function weeklyInputs(e: EngagementRow, periodEnd: string): Promise<Parameters<typeof composeWeeklyBody>[0]> {
  const periodStart = addDays(periodEnd, -(WEEKLY_WINDOW_DAYS - 1));
  const tasks = await sql`
    select id, title, status, client_approval, blocked_reason, blocked_note, target_url, after_state,
      cardinality(evidence_ids) as evidence_count, coalesce(implemented_at, updated_at) as at
    from tasks where project_id = ${e.projectId} and client_visible and status <> 'rejected'
    order by updated_at desc
  `;
  const inWindow = (d: Date) => {
    const iso = d.toISOString().slice(0, 10);
    return iso >= periodStart && iso <= periodEnd;
  };
  const measurements = (await listMeasurements(e.id)).filter((m) => m.role !== "baseline" && m.frozenAt && inWindow(m.frozenAt) && (m.status === "frozen" || m.status === "non_comparable"));
  const plan = await planForProject(e.projectId, { publishedOnly: true });
  const nextWeekEnd = addDays(periodEnd, WEEKLY_WINDOW_DAYS);
  const meetings = await listMeetings(e.id);
  const nextMeeting = meetings.filter((m) => m.status === "planned" && toIso(m.scheduledFor) > periodEnd).sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0];
  const clientBlock = new Set(["client_access", "client_approval", "client_input"]);
  return {
    clientName: e.clientLegalName || e.marketName,
    periodStart,
    periodEnd,
    intro: "",
    done: tasks.filter((t) => t.status === "done" && inWindow(t.at as Date)).map((t) => ({ taskId: t.id as string, title: t.title as string, targetUrl: (t.targetUrl as string | null) ?? null, after: (t.afterState as string | null) ?? null, evidenceCount: Number(t.evidenceCount ?? 0) })),
    inProgress: tasks.filter((t) => (t.status === "in_progress" || t.status === "approved") && !t.blockedReason && t.clientApproval !== "required").map((t) => ({ taskId: t.id as string, title: t.title as string })),
    blocked: tasks.filter((t) => t.blockedReason && t.status !== "done").map((t) => ({ taskId: t.id as string, title: t.title as string, reason: t.blockedReason as string, note: (t.blockedNote as string | null) ?? null, onClient: clientBlock.has(t.blockedReason as string) })),
    approvals: tasks.filter((t) => t.clientApproval === "required" && t.status !== "done").map((t) => ({ taskId: t.id as string, title: t.title as string })),
    measurements: measurements.map((m) => ({ measurementId: m.id, role: m.role, statement: m.comparison?.statement ?? "", grade: m.comparability?.grade ?? "not_comparable" })),
    baselineFrozen: (await listMeasurements(e.id)).some((m) => m.role === "baseline" && m.status === "frozen"),
    dueNext: (plan?.items ?? []).filter((it) => it.dueOn && it.dueOn > periodEnd && it.dueOn <= nextWeekEnd && it.state !== "completed" && it.state !== "dropped").map((it) => ({ itemId: it.id, title: it.title, dueOn: it.dueOn!, owner: it.owner })),
    nextCheckinOn: nextMeeting ? toIso(nextMeeting.scheduledFor) : null,
  };
}

const weeklySchema = z.object({
  engagementId: idSchema,
  periodEnd: dateSchema.optional(),
  intro: z.string().trim().max(1500).default(""),
});

export async function generateWeeklyDraft(user: CurrentUser, raw: unknown): Promise<ActionResult<{ updateId: string; body: UpdateBody }>> {
  const parsed = weeklySchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const issues = operatorNoteIssues(i.intro);
    if (issues.length > 0) return fail(new ClassifiedError("validation", issues.join(" ")));
    const e = await loadEngagement(i.engagementId);
    if (e.stage === "signed") return fail(new ClassifiedError("validation", "Weekly updates start once onboarding has begun."));
    const input = await weeklyInputs(e, i.periodEnd ?? todayIso());
    const body = composeWeeklyBody({ ...input, intro: i.intro });
    const id = await upsertDraft(user, e, "weekly", body, input.periodStart, input.periodEnd);
    return ok({ updateId: id, body });
  } catch (err) {
    return fail(err);
  }
}

export async function generateFinalReviewDraft(user: CurrentUser, raw: unknown): Promise<ActionResult<{ updateId: string; body: UpdateBody }>> {
  const parsed = z.object({ engagementId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid engagement id."));
  try {
    assertCanWrite(user);
    const e = await loadEngagement(parsed.data.engagementId);
    const ms = await listMeasurements(e.id);
    const baselineRow = ms.find((m) => m.role === "baseline" && m.status === "frozen");
    if (!baselineRow?.snapshot) return fail(new ClassifiedError("validation", "No locked baseline — there is nothing to review against."));
    const finalRow = ms.filter((m) => m.role === "final" && (m.status === "frozen" || m.status === "non_comparable")).sort((a, b) => (b.frozenAt?.getTime() ?? 0) - (a.frozenAt?.getTime() ?? 0))[0];
    const baseline = rateView(baselineRow.snapshot)!;
    const final = finalRow?.snapshot ? rateView(finalRow.snapshot) : null;
    const textOf = new Map(baselineRow.snapshot.questions.map((q) => [q.promptId, q.text]));
    const changes = finalRow?.snapshot && finalRow.status === "frozen" ? questionChanges(baselineRow.snapshot, finalRow.snapshot) : { gained: [], lost: [], steady: 0 };
    const [protocol] = (await listProtocols(e.id)).filter((p) => p.status === "accepted");
    const done = await sql`select title from tasks where project_id = ${e.projectId} and client_visible and status = 'done' order by implemented_at asc nulls last`;
    const external = (await listExternalMeasurements(e.id)).filter((x) => x.qaStatus === "verified" && x.clientVisible);
    const body = composeFinalReviewBody({
      clientName: e.clientLegalName || e.marketName,
      baseline,
      final,
      comparability: finalRow?.comparability ?? null,
      gainedQuestions: changes.gained.map((id) => textOf.get(id) ?? id),
      lostQuestions: changes.lost.map((id) => textOf.get(id) ?? id),
      deliveredWork: done.map((t) => t.title as string),
      successCriteria: protocol?.successCriteria ?? "",
      externalNote: external.length > 0 ? `${external.length} verified external measurement(s) are shown separately in your portal. They use a different instrument and are not combined with the numbers above.` : null,
    });
    const id = await upsertDraft(user, e, "final_review", body, e.startsOn, todayIso());
    return ok({ updateId: id, body });
  } catch (err) {
    return fail(err);
  }
}

const sendSchema = z.object({ updateId: idSchema, channel: z.enum(DECISION_CHANNELS) });

/** The operator sent it (from their mailbox, on a call…). Freezes the update,
 * publishes it to the portal archive, and feeds the cadence signal. */
export async function markUpdateSent(user: CurrentUser, raw: unknown): Promise<ActionResult<{ updateId: string }>> {
  const parsed = sendSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [u] = await tx`select id, engagement_id, kind, status, body from engagement_updates where id = ${parsed.data.updateId} for update`;
      if (!u) throw new ClassifiedError("not_found", "Update not found.");
      if (u.status !== "draft") throw new ClassifiedError("conflict", `Update is already ${u.status}.`);
      const e = await loadEngagement(u.engagementId as string);
      await tx`update engagement_updates set status = 'sent', sent_at = now(), sent_by = ${user.id}, channel = ${parsed.data.channel}, updated_at = now() where id = ${u.id as string}`;
      // Same audit action the spec-131 cadence signal reads.
      await audit(tx, user, e, "engagement.client_update_sent", { channel: parsed.data.channel, summary: `${u.kind} update ${u.id as string}`, updateId: u.id, kind: u.kind });
    });
    return ok({ updateId: parsed.data.updateId });
  } catch (err) {
    return fail(err);
  }
}

export async function discardUpdate(user: CurrentUser, raw: unknown): Promise<ActionResult<{ updateId: string }>> {
  const parsed = z.object({ updateId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid update id."));
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [u] = await tx`select id, engagement_id, status from engagement_updates where id = ${parsed.data.updateId} for update`;
      if (!u) throw new ClassifiedError("not_found", "Update not found.");
      if (u.status !== "draft") throw new ClassifiedError("conflict", "Only a draft can be discarded.");
      await tx`update engagement_updates set status = 'discarded', updated_at = now() where id = ${u.id as string}`;
      await audit(tx, user, await loadEngagement(u.engagementId as string), "engagement.update_discarded", { updateId: u.id });
    });
    return ok({ updateId: parsed.data.updateId });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------ meetings

export interface MeetingRow {
  id: string;
  kind: string;
  scheduledFor: Date;
  agenda: string;
  status: string;
  notes: string;
  actionItems: { text: string; owner: string; dueOn: string | null }[];
  clientVisible: boolean;
  heldAt: Date | null;
}

export async function listMeetings(engagementId: string, opts: { clientVisibleOnly?: boolean } = {}): Promise<MeetingRow[]> {
  const rows = await sql`
    select * from engagement_meetings where engagement_id = ${engagementId}
      ${opts.clientVisibleOnly ? sql`and client_visible` : sql``}
    order by scheduled_for desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    scheduledFor: r.scheduledFor as Date,
    agenda: (r.agenda as string) ?? "",
    status: r.status as string,
    notes: (r.notes as string) ?? "",
    actionItems: (r.actionItems as MeetingRow["actionItems"]) ?? [],
    clientVisible: Boolean(r.clientVisible),
    heldAt: (r.heldAt as Date | null) ?? null,
  }));
}

const scheduleSchema = z.object({
  engagementId: idSchema,
  kind: z.enum(MEETING_KINDS).default("checkin"),
  scheduledFor: z.string().datetime({ offset: true }).or(dateSchema),
  agenda: z.string().trim().max(4000).optional(),
});

/** Manual scheduling (no calendar connector). The default agenda is built
 * from canonical rows; the operator may replace it. */
export async function scheduleMeeting(user: CurrentUser, raw: unknown): Promise<ActionResult<{ meetingId: string }>> {
  const parsed = scheduleSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await loadEngagement(i.engagementId);
    let agenda = i.agenda;
    if (!agenda) {
      const inputs = await weeklyInputs(e, todayIso());
      agenda = defaultCheckinAgenda({
        approvalsWaiting: inputs.approvals.length,
        blockedOnClient: inputs.blocked.filter((b) => b.onClient).length,
        dueNext: inputs.dueNext.map((d) => d.title),
        measurementPending: !inputs.baselineFrozen,
      });
    }
    const at = i.scheduledFor.length === 10 ? `${i.scheduledFor}T16:00:00Z` : i.scheduledFor;
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into engagement_meetings (engagement_id, project_id, kind, scheduled_for, agenda, created_by)
        values (${e.id}, ${e.projectId}, ${i.kind}, ${at}, ${agenda}, ${user.id}) returning id
      `;
      await audit(tx, user, e, "engagement.meeting_scheduled", { meetingId: row!.id, kind: i.kind, scheduledFor: at });
      return row!.id as string;
    });
    return ok({ meetingId: id });
  } catch (err) {
    return fail(err);
  }
}

const meetingNotesSchema = z.object({
  meetingId: idSchema,
  status: z.enum(["planned", "held", "cancelled"]),
  notes: z.string().trim().max(8000).default(""),
  actionItems: z.array(z.object({ text: z.string().trim().min(1).max(500), owner: z.enum(["client", "agency"]), dueOn: dateSchema.nullable().default(null) })).max(30).default([]),
  clientVisible: z.boolean().default(true),
});

export async function recordMeetingNotes(user: CurrentUser, raw: unknown): Promise<ActionResult<{ meetingId: string }>> {
  const parsed = meetingNotesSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [m] = await tx`select id, engagement_id, status, notes from engagement_meetings where id = ${i.meetingId} for update`;
      if (!m) throw new ClassifiedError("not_found", "Meeting not found.");
      if (m.status === "cancelled") throw new ClassifiedError("conflict", "A cancelled meeting is not edited — schedule a new one.");
      await tx`
        update engagement_meetings set status = ${i.status}, notes = ${i.notes}, action_items = ${tx.json(i.actionItems as never)},
          client_visible = ${i.clientVisible}, held_at = case when ${i.status === "held"} then coalesce(held_at, now()) else held_at end, updated_at = now()
        where id = ${i.meetingId}
      `;
      await audit(tx, user, await loadEngagement(m.engagementId as string), "engagement.meeting_recorded", { meetingId: i.meetingId, from: m.status, to: i.status, notesBefore: m.notes, notesAfter: i.notes, actionItems: i.actionItems.length });
    });
    return ok({ meetingId: i.meetingId });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------- external measurements

export interface ExternalMeasurementRow {
  id: string;
  providerLabel: string;
  instrument: string;
  referenceUrl: string | null;
  capturedFrom: string;
  capturedTo: string;
  promptCount: number | null;
  summary: string;
  rawSha256: string;
  rawBytes: number;
  distinguishesRecommendation: string;
  qaStatus: string;
  qaNote: string;
  clientVisible: boolean;
  createdAt: Date;
}

export async function listExternalMeasurements(engagementId: string, opts: { clientSafe?: boolean } = {}): Promise<ExternalMeasurementRow[]> {
  const rows = await sql`
    select id, provider_label, instrument, reference_url, captured_from, captured_to, prompt_count, summary, raw_sha256,
      octet_length(raw_export) as raw_bytes, distinguishes_recommendation, qa_status, qa_note, client_visible, created_at
    from external_measurements where engagement_id = ${engagementId}
      ${opts.clientSafe ? sql`and client_visible and qa_status = 'verified'` : sql``}
    order by created_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    providerLabel: r.providerLabel as string,
    instrument: (r.instrument as string) ?? "",
    referenceUrl: (r.referenceUrl as string | null) ?? null,
    capturedFrom: toIso(r.capturedFrom),
    capturedTo: toIso(r.capturedTo),
    promptCount: r.promptCount === null ? null : Number(r.promptCount),
    summary: (r.summary as string) ?? "",
    rawSha256: r.rawSha256 as string,
    rawBytes: Number(r.rawBytes ?? 0),
    distinguishesRecommendation: r.distinguishesRecommendation as string,
    qaStatus: r.qaStatus as string,
    qaNote: (r.qaNote as string) ?? "",
    clientVisible: Boolean(r.clientVisible),
    createdAt: r.createdAt as Date,
  }));
}

const externalSchema = z
  .object({
    engagementId: idSchema,
    providerLabel: z.string().trim().min(2).max(120),
    instrument: z.string().trim().max(200).default(""),
    referenceUrl: z.string().trim().url().max(1000).refine((u) => /^https:\/\//.test(u), "Reference URLs must be https.").nullable().default(null),
    capturedFrom: dateSchema,
    capturedTo: dateSchema,
    promptCount: z.number().int().min(0).max(10_000).nullable().default(null),
    summary: z.string().trim().max(4000).default(""),
    rawExport: z.string().min(1, "Paste the raw export (CSV or text) so the numbers stay inspectable.").max(EXTERNAL_RAW_EXPORT_MAX),
    distinguishesRecommendation: z.enum(RECOMMENDATION_DISTINCTION),
  })
  .refine((v) => v.capturedTo >= v.capturedFrom, { message: "The capture window ends before it starts." });

/** Manual import of an external instrument's export. Stored verbatim with
 * its hash; starts pending QA and invisible to the client. */
export async function importExternalMeasurement(user: CurrentUser, raw: unknown): Promise<ActionResult<{ id: string; sha256: string }>> {
  const parsed = externalSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await loadEngagement(i.engagementId);
    const sha256 = createHash("sha256").update(i.rawExport, "utf8").digest("hex");
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into external_measurements (engagement_id, project_id, provider_label, instrument, reference_url, captured_from, captured_to,
          prompt_count, summary, raw_export, raw_sha256, distinguishes_recommendation, imported_by)
        values (${e.id}, ${e.projectId}, ${i.providerLabel}, ${i.instrument}, ${i.referenceUrl}, ${i.capturedFrom}, ${i.capturedTo},
          ${i.promptCount}, ${i.summary}, ${i.rawExport}, ${sha256}, ${i.distinguishesRecommendation}, ${user.id})
        returning id
      `;
      await audit(tx, user, e, "engagement.external_measurement_imported", { id: row!.id, providerLabel: i.providerLabel, sha256, bytes: Buffer.byteLength(i.rawExport, "utf8") });
      return row!.id as string;
    });
    return ok({ id, sha256 });
  } catch (err) {
    return fail(err);
  }
}

const externalQaSchema = z.object({
  id: idSchema,
  qaStatus: z.enum(EXTERNAL_QA_STATUSES),
  qaNote: z.string().trim().min(5, "Say what was checked.").max(2000),
  clientVisible: z.boolean().default(false),
});

export async function setExternalMeasurementQa(user: CurrentUser, raw: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = externalQaSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    if (i.clientVisible && i.qaStatus !== "verified") return fail(new ClassifiedError("validation", "Only a verified external measurement can be shown to the client."));
    await sql.begin(async (tx) => {
      const [m] = await tx`select id, engagement_id, qa_status, client_visible from external_measurements where id = ${i.id} for update`;
      if (!m) throw new ClassifiedError("not_found", "External measurement not found.");
      await tx`update external_measurements set qa_status = ${i.qaStatus}, qa_note = ${i.qaNote}, client_visible = ${i.clientVisible}, qa_by = ${user.id}, qa_at = now() where id = ${i.id}`;
      await audit(tx, user, await loadEngagement(m.engagementId as string), "engagement.external_measurement_qa", { id: i.id, from: { qaStatus: m.qaStatus, clientVisible: m.clientVisible }, to: { qaStatus: i.qaStatus, clientVisible: i.clientVisible }, note: i.qaNote });
    });
    return ok({ id: i.id });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------- roadmap

export interface RoadmapItem {
  id: string;
  phase: string;
  position: number;
  title: string;
  rationale: string;
  owner: string;
  dueOn: string | null;
  dependsOn: string[];
  proofUrl: string | null;
  measurement: string;
  status: string;
  taskId: string | null;
  state: WorkState;
  task: { status: string; blockedReason: string | null; blockedNote: string | null; clientApproval: string; targetUrl: string | null; afterState: string | null; evidenceCount: number; clientVisible: boolean } | null;
}

export interface Roadmap {
  planId: string;
  title: string;
  status: string;
  approvedAt: Date | null;
  createdAt: Date;
  items: RoadmapItem[];
}

/** The client's plan: the project's live program plan with each item's state
 * derived from its task. `publishedOnly` = approved/active (what clients see). */
export async function planForProject(projectId: string, opts: { publishedOnly?: boolean } = {}): Promise<Roadmap | null> {
  const [plan] = await sql`
    select id, title, status, approved_at, created_at from program_plans
    where project_id = ${projectId} and status <> 'superseded'
      ${opts.publishedOnly ? sql`and status in ('approved', 'active', 'completed')` : sql``}
    order by created_at desc limit 1
  `;
  if (!plan) return null;
  const rows = await sql`
    select i.id, i.phase, i.position, i.title, i.rationale, i.owner, i.due_on, i.depends_on, i.proof_url, i.measurement,
      i.status, i.task_id, t.status as task_status, t.blocked_reason, t.blocked_note, t.client_approval, t.target_url,
      t.after_state, cardinality(t.evidence_ids) as evidence_count, t.client_visible
    from plan_items i left join tasks t on t.id = i.task_id
    where i.plan_id = ${plan.id as string} and i.status <> 'excluded'
    order by case i.phase when 'foundation' then 0 when 'authority' then 1 else 2 end, i.due_on nulls last, i.position
  `;
  return {
    planId: plan.id as string,
    title: plan.title as string,
    status: plan.status as string,
    approvedAt: (plan.approvedAt as Date | null) ?? null,
    createdAt: plan.createdAt as Date,
    items: rows.map((r) => {
      const task = r.taskId
        ? { status: r.taskStatus as string, blockedReason: (r.blockedReason as string | null) ?? null, blockedNote: (r.blockedNote as string | null) ?? null, clientApproval: r.clientApproval as string, targetUrl: (r.targetUrl as string | null) ?? null, afterState: (r.afterState as string | null) ?? null, evidenceCount: Number(r.evidenceCount ?? 0), clientVisible: Boolean(r.clientVisible) }
        : null;
      return {
        id: r.id as string,
        phase: r.phase as string,
        position: Number(r.position),
        title: r.title as string,
        rationale: r.rationale as string,
        owner: r.owner as string,
        dueOn: r.dueOn ? toIso(r.dueOn) : null,
        dependsOn: (r.dependsOn as string[]) ?? [],
        proofUrl: (r.proofUrl as string | null) ?? null,
        measurement: (r.measurement as string) ?? "",
        status: r.status as string,
        taskId: (r.taskId as string | null) ?? null,
        state: planItemState({ status: r.status as string, task }),
        task,
      };
    }),
  };
}

/** A blank draft plan the operator fills by hand — the fallback when no gap
 * findings exist yet for the composer. Supersedes nothing published. */
export async function createManualPlan(user: CurrentUser, raw: unknown): Promise<ActionResult<{ planId: string }>> {
  const parsed = z.object({ projectId: idSchema, title: z.string().trim().min(1).max(160).default("90-day plan") }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const e = await engagementForProject(parsed.data.projectId);
    if (!e) return fail(new ClassifiedError("not_found", "No engagement for this project."));
    const id = await sql.begin(async (tx) => {
      const [live] = await tx`select id, status from program_plans where project_id = ${e.projectId} and status in ('draft', 'approved', 'active') limit 1`;
      if (live) throw new ClassifiedError("conflict", `A ${live.status as string} plan already exists — edit it instead.`);
      const [row] = await tx`
        insert into program_plans (project_id, title, horizon_days, status, baseline, composer_version, composition_hash, created_by)
        values (${e.projectId}, ${parsed.data.title}, 90, 'draft', ${tx.json({ composedAt: todayIso(), manual: true } as never)},
          ${MANUAL_PLAN_COMPOSER}, ${createHash("sha256").update(`${e.projectId}:${randomUUID()}`).digest("hex")}, ${user.id})
        returning id
      `;
      await writeAudit(tx, { userId: user.id, action: "plan.create_manual", entity: "program_plan", entityId: row!.id as string, projectId: e.projectId, detail: { title: parsed.data.title } });
      return row!.id as string;
    });
    return ok({ planId: id });
  } catch (err) {
    return fail(err);
  }
}

const phaseEnum = z.enum(PLAN_PHASES.map((p) => p.key) as [string, ...string[]]);
const ownerEnum = z.enum(["operator", "client", "shared"]);

const addItemSchema = z.object({
  planId: idSchema,
  phase: phaseEnum,
  title: z.string().trim().min(3).max(160),
  rationale: z.string().trim().min(10, "Say why this item is in the plan (the observation behind it).").max(2000),
  owner: ownerEnum.default("operator"),
  dueOn: dateSchema.nullable().default(null),
  dependsOn: z.array(idSchema).max(10).default([]),
  measurement: z.string().trim().max(500).default(""),
  /** Stored answers behind the item; must be evidence this client owns. */
  evidenceResponseIds: z.array(idSchema).max(10).default([]),
});

/** Evidence rows for stored answers this project may cite: answers inside a
 * frozen snapshot of its engagement, or captured in its own runs. */
async function responseEvidence(tx: TransactionSql, user: CurrentUser, projectId: string, responseIds: string[], note: string): Promise<string[]> {
  const ids: string[] = [];
  for (const rid of [...new Set(responseIds)]) {
    const [okRow] = await tx`
      select 1 as ok from engagement_measurements m
      where m.project_id = ${projectId} and m.status in ('frozen', 'non_comparable') and m.snapshot is not null
        and exists (select 1 from jsonb_array_elements(m.snapshot -> 'questions') q, jsonb_array_elements_text(q -> 'responseIds') x where x = ${rid})
      union all
      select 1 from responses r join runs x on x.id = r.run_id where r.id = ${rid} and x.project_id = ${projectId}
      limit 1
    `;
    if (!okRow) throw new ClassifiedError("validation", "Evidence must be an answer from this client's own measurements.");
    const [row] = await tx`insert into evidence (project_id, kind, ref_id, note, created_by) values (${projectId}, 'response', ${rid}, ${note}, ${user.id}) returning id`;
    ids.push(row!.id as string);
  }
  return ids;
}

async function assertEditablePlan(tx: TransactionSql, planId: string): Promise<{ projectId: string; status: string }> {
  const [plan] = await tx`select project_id, status from program_plans where id = ${planId} for update`;
  if (!plan) throw new ClassifiedError("not_found", "Plan not found.");
  if (!["draft", "approved", "active"].includes(plan.status as string)) throw new ClassifiedError("conflict", `A ${plan.status as string} plan is historical.`);
  return { projectId: plan.projectId as string, status: plan.status as string };
}

export async function addPlanItem(user: CurrentUser, raw: unknown): Promise<ActionResult<{ planItemId: string }>> {
  const parsed = addItemSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const id = await sql.begin(async (tx) => {
      const plan = await assertEditablePlan(tx, i.planId);
      if (i.dependsOn.length > 0) {
        const deps = await tx`select id from plan_items where plan_id = ${i.planId} and id = any(${i.dependsOn}::uuid[])`;
        if (deps.length !== new Set(i.dependsOn).size) throw new ClassifiedError("validation", "Dependencies must be items of the same plan.");
      }
      const [pos] = await tx`select coalesce(max(position), 0)::int + 1 as p from plan_items where plan_id = ${i.planId} and phase = ${i.phase}`;
      const evidenceIds = await responseEvidence(tx, user, plan.projectId, i.evidenceResponseIds, `Plan item: ${i.title}`.slice(0, 500));
      const [row] = await tx`
        insert into plan_items (plan_id, phase, position, play_key, title, rationale, steps, owner, measurement, due_on, depends_on, evidence_ids)
        values (${i.planId}, ${i.phase}, ${Number(pos!.p)}, ${`manual-${randomUUID().slice(0, 8)}`}, ${i.title}, ${i.rationale}, ${[] as string[]},
          ${i.owner}, ${i.measurement}, ${i.dueOn}, ${i.dependsOn}::uuid[], ${evidenceIds}::uuid[])
        returning id
      `;
      await writeAudit(tx, { userId: user.id, action: "plan.item_add", entity: "program_plan", entityId: i.planId, projectId: plan.projectId, detail: plain({ itemId: row!.id, ...i, planStatus: plan.status }) });
      return row!.id as string;
    });
    return ok({ planItemId: id });
  } catch (err) {
    return fail(err);
  }
}

const updateItemSchema = z
  .object({
    planItemId: idSchema,
    phase: phaseEnum.optional(),
    title: z.string().trim().min(3).max(160).optional(),
    rationale: z.string().trim().min(10).max(2000).optional(),
    owner: ownerEnum.optional(),
    dueOn: dateSchema.nullable().optional(),
    dependsOn: z.array(idSchema).max(10).optional(),
    proofUrl: z.string().trim().url().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: "Nothing to update." });

/** Edits are allowed on draft and published plans; every edit is audited
 * with before/after, so a published date change is never silent. */
export async function updatePlanItem(user: CurrentUser, raw: unknown): Promise<ActionResult<{ planItemId: string }>> {
  const parsed = updateItemSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [item] = await tx`select id, plan_id, phase, title, rationale, owner, due_on, depends_on, proof_url from plan_items where id = ${i.planItemId} for update`;
      if (!item) throw new ClassifiedError("not_found", "Plan item not found.");
      const plan = await assertEditablePlan(tx, item.planId as string);
      if (i.dependsOn?.includes(i.planItemId)) throw new ClassifiedError("validation", "An item cannot depend on itself.");
      if (i.dependsOn && i.dependsOn.length > 0) {
        const deps = await tx`select id from plan_items where plan_id = ${item.planId as string} and id = any(${i.dependsOn}::uuid[])`;
        if (deps.length !== new Set(i.dependsOn).size) throw new ClassifiedError("validation", "Dependencies must be items of the same plan.");
      }
      const pick = <T,>(next: T | undefined, cur: T): T => (next === undefined ? cur : next);
      await tx`
        update plan_items set
          phase = ${pick(i.phase, item.phase as string)}, title = ${pick(i.title, item.title as string)},
          rationale = ${pick(i.rationale, item.rationale as string)}, owner = ${pick(i.owner, item.owner as string)},
          due_on = ${pick(i.dueOn, item.dueOn ? toIso(item.dueOn) : null)}, depends_on = ${pick(i.dependsOn, (item.dependsOn as string[]) ?? [])}::uuid[],
          proof_url = ${pick(i.proofUrl, (item.proofUrl as string | null) ?? null)}
        where id = ${i.planItemId}
      `;
      await writeAudit(tx, { userId: user.id, action: "plan.item_update", entity: "program_plan", entityId: item.planId as string, projectId: plan.projectId, detail: plain({ itemId: i.planItemId, planStatus: plan.status, before: { phase: item.phase, title: item.title, owner: item.owner, dueOn: item.dueOn ? toIso(item.dueOn) : null, dependsOn: item.dependsOn, proofUrl: item.proofUrl }, after: i }) });
    });
    return ok({ planItemId: i.planItemId });
  } catch (err) {
    return fail(err);
  }
}

/** Answers per segment where the subject trails a tracked competitor in the
 * frozen baseline — the observations a first plan draft is built from. */
export interface BaselineGap {
  segment: string;
  questions: number;
  answers: number;
  subjectRecommended: number;
  leader: string;
  leaderRecommended: number;
  responseIds: string[];
}

export function baselineGaps(snapshot: import("@/lib/engagements/rules").MeasurementSnapshot): BaselineGap[] {
  const names = new Map(snapshot.competitors.map((c) => [c.companyId, c.name]));
  const bySeg = new Map<string, BaselineGap & { comp: Map<string, number> }>();
  for (const q of snapshot.questions) {
    const key = q.segment?.priceTier || q.segment?.neighborhood || q.category || "All questions";
    const g = bySeg.get(key) ?? { segment: key, questions: 0, answers: 0, subjectRecommended: 0, leader: "", leaderRecommended: 0, responseIds: [] as string[], comp: new Map<string, number>() };
    g.questions += 1;
    g.answers += q.answerCount;
    g.subjectRecommended += q.subjectRecommended;
    for (const [c, n] of Object.entries(q.competitorRecommended)) g.comp.set(c, (g.comp.get(c) ?? 0) + n);
    if (q.subjectRecommended === 0 && Object.values(q.competitorRecommended).some((n) => n > 0)) g.responseIds.push(...q.responseIds.slice(0, 1));
    bySeg.set(key, g);
  }
  return [...bySeg.values()]
    .map(({ comp, ...g }) => {
      const [leaderId, leaderN] = [...comp.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      return { ...g, leader: names.get(leaderId) ?? "", leaderRecommended: leaderN, responseIds: g.responseIds.slice(0, 3) };
    })
    .filter((g) => g.leaderRecommended > g.subjectRecommended)
    .sort((a, b) => (b.leaderRecommended - b.subjectRecommended) / Math.max(1, b.answers) - (a.leaderRecommended - a.subjectRecommended) / Math.max(1, a.answers));
}

/**
 * A first plan DRAFT from the locked baseline: one item per segment where a
 * tracked competitor is recommended more often than the client, rationale
 * stated as observed counts, evidence = the answers themselves. Biggest gaps
 * land in Days 1–30. The operator edits, adds and publishes; nothing here
 * reaches the client until the plan is approved.
 */
export async function draftPlanFromBaseline(user: CurrentUser, raw: unknown): Promise<ActionResult<{ planId: string; items: number }>> {
  const parsed = z.object({ projectId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid project id."));
  try {
    assertCanWrite(user);
    const e = await engagementForProject(parsed.data.projectId);
    if (!e) return fail(new ClassifiedError("not_found", "No engagement for this project."));
    const baseline = (await listMeasurements(e.id)).find((m) => m.role === "baseline" && m.status === "frozen");
    if (!baseline?.snapshot) return fail(new ClassifiedError("validation", "Lock the baseline first — the draft is built from its observations."));
    const gaps = baselineGaps(baseline.snapshot);
    const created = await createManualPlan(user, { projectId: e.projectId, title: "90-day plan" });
    if (!created.ok) return created;
    const windows = phaseWindows(e.startsOn);
    const subjectName = baseline.snapshot.subject.name;
    let n = 0;
    for (const [idx, g] of gaps.entries()) {
      const phase = idx < 2 ? "foundation" : idx < 4 ? "authority" : "compounding";
      const added = await addPlanItem(user, {
        planId: created.data.planId,
        phase,
        title: `Close the seller-evidence gap: ${g.segment}`.slice(0, 160),
        rationale: `In the locked baseline, ${g.leader} was recommended in ${g.leaderRecommended} of ${g.answers} answers to ${g.questions} ${g.segment} question(s); ${subjectName} in ${g.subjectRecommended}. This is an observation, not a diagnosis — confirm the cause before changing anything public.`,
        owner: "operator",
        dueOn: windows.find((w) => w.key === phase)!.to,
        measurement: `Recommendations in ${g.segment} questions at the next comparable measurement.`,
        evidenceResponseIds: g.responseIds,
      });
      if (!added.ok) return added;
      n += 1;
    }
    return ok({ planId: created.data.planId, items: n });
  } catch (err) {
    return fail(err);
  }
}

/** Give every undated item its phase's last day (from the engagement start). */
export async function applyPhaseDueDates(user: CurrentUser, raw: unknown): Promise<ActionResult<{ dated: number }>> {
  const parsed = z.object({ planId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", "Invalid plan id."));
  try {
    assertCanWrite(user);
    const dated = await sql.begin(async (tx) => {
      const plan = await assertEditablePlan(tx, parsed.data.planId);
      const e = await engagementForProject(plan.projectId);
      if (!e) throw new ClassifiedError("not_found", "No engagement for this plan's project.");
      let n = 0;
      for (const w of phaseWindows(e.startsOn)) {
        const rows = await tx`update plan_items set due_on = ${w.to} where plan_id = ${parsed.data.planId} and phase = ${w.key} and due_on is null and status not in ('excluded', 'dropped') returning id`;
        n += rows.length;
      }
      await writeAudit(tx, { userId: user.id, action: "plan.phase_due_dates", entity: "program_plan", entityId: parsed.data.planId, projectId: plan.projectId, detail: { dated: n, startsOn: e.startsOn } });
      return n;
    });
    return ok({ dated });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------ operator read model

export interface DeliveryState {
  engagement: EngagementRow;
  journey: JourneyStep[];
  /** The inputs the journey was derived from (the portal re-derives its own view). */
  journeyInput: JourneyInput;
  protocols: ProtocolRow[];
  questionSet: ProposedQuestionSet | null;
  decisions: SubjectDecisionRow[];
  updates: UpdateRow[];
  meetings: MeetingRow[];
  nextCheckin: { date: string; scheduled: boolean };
  external: ExternalMeasurementRow[];
  roadmap: Roadmap | null;
  measurements: MeasurementRow[];
  portalGrants: number;
  offboarding: OffboardingItem[];
  minPropertyValueUsd: number | null;
  candidateRuns: { id: string; label: string; status: string; startedAt: Date; matchesProtocol: boolean }[];
}

export async function deliveryState(projectId: string, today = todayIso()): Promise<DeliveryState | null> {
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const [protocols, questionSet, decisions, updates, meetings, external, roadmap, measurements, context] = await Promise.all([
    listProtocols(e.id),
    proposedQuestionSet(e.id, e.projectId),
    listSubjectDecisions(e.id),
    listUpdates(e.id),
    listMeetings(e.id),
    listExternalMeasurements(e.id),
    planForProject(projectId),
    listMeasurements(e.id),
    listContextItems(e.id),
  ]);
  const [grants] = await sql`
    select count(*)::int as n from user_project_access a join users u on u.id = a.user_id
    where a.project_id = ${projectId} and u.role in ('client_viewer', 'client_validator') and u.active
  `;
  const [paid] = await sql`
    select coalesce(sum(amount_cents), 0)::bigint as cents from billing_events
    where project_id = ${projectId} and kind = 'payment_received' and contract_ref = ${`engagement:${e.id}`}
  `;
  const gate = commercialGate({ contractStatus: e.contractStatus, paymentsReceivedCents: Number(paid?.cents ?? 0), activationPaymentCents: usdToCents(e.monthlyFeeUsd), activationOverrideReason: e.activationOverrideReason });
  const accepted = protocols.find((p) => p.status === "accepted") ?? null;
  const draft = protocols.find((p) => p.status === "draft") ?? null;
  const sentWeekly = updates.filter((u) => u.kind === "weekly" && u.status === "sent" && u.sentAt);
  const held = meetings.filter((m) => m.status === "held").map((m) => toIso(m.scheduledFor)).sort().at(-1) ?? null;
  const planned = meetings.filter((m) => m.status === "planned").map((m) => toIso(m.scheduledFor)).filter((d) => d >= today);
  const nextCheckin = nextCheckinDue({ startsOn: e.startsOn, planned, lastHeld: held });
  const final = measurements.some((m) => m.role === "final" && (m.status === "frozen" || m.status === "non_comparable"));
  const intakeConfirmed = context.some((c) => c.kind === "identity" && c.provenance === "client_confirmed") && context.some((c) => c.provenance === "client_priority");
  const qsDecision = questionSet?.decision ?? null;
  const journeyInput: JourneyInput = {
    stage: e.stage,
    commercialReady: gate.ready,
    commercialReasons: gate.reasons,
    portalGrants: Number(grants?.n ?? 0),
    welcomeSent: updates.some((u) => u.kind === "welcome" && u.status === "sent"),
    intakeConfirmed,
    questionSet: questionSet ? { versionId: questionSet.versionId, questionCount: questionSet.questions.length, approved: qsDecision?.decision === "approved", changesRequested: qsDecision?.decision === "changes_requested" || qsDecision?.decision === "rejected" } : null,
    protocol: accepted ? { status: "accepted", questionSetApproved: true } : draft ? { status: "draft", questionSetApproved: qsDecision?.decision === "approved" } : null,
    baselineFrozen: measurements.some((m) => m.role === "baseline" && m.status === "frozen"),
    roadmapPublished: Boolean(roadmap && ["approved", "active", "completed"].includes(roadmap.status)),
    lastWeeklySentOn: sentWeekly[0]?.sentAt ? sentWeekly[0].sentAt.toISOString().slice(0, 10) : null,
    nextCheckinOn: nextCheckin.scheduled ? nextCheckin.date : null,
    finalMeasured: final,
    finalReviewSent: updates.some((u) => u.kind === "final_review" && u.status === "sent"),
    today,
  };
  const journey = deliveryJourney(journeyInput);
  const [open] = await sql`select count(*)::int as n from tasks where project_id = ${projectId} and status in ('suggested', 'approved', 'in_progress')`;
  const offboarding = offboardingChecklist({
    openTasks: Number(open?.n ?? 0),
    finalMeasured: final,
    finalReviewSent: updates.some((u) => u.kind === "final_review" && u.status === "sent"),
    portalGrants: Number(grants?.n ?? 0),
    stage: e.stage,
    openMeetings: meetings.filter((m) => m.status === "planned").length,
  });
  const runs = await sql`
    select id, label, status, started_at, prompt_set_version_id from runs
    where project_id = ${projectId} and status in ('completed', 'partial', 'running', 'pending')
    order by started_at desc limit 10
  `;
  return {
    engagement: e,
    journey,
    journeyInput,
    protocols,
    questionSet,
    decisions,
    updates,
    meetings,
    nextCheckin,
    external,
    roadmap,
    measurements,
    portalGrants: Number(grants?.n ?? 0),
    offboarding,
    minPropertyValueUsd: minPropertyValueFrom(context),
    candidateRuns: runs.map((r) => ({ id: r.id as string, label: (r.label as string) ?? "", status: r.status as string, startedAt: r.startedAt as Date, matchesProtocol: Boolean(accepted && r.promptSetVersionId === accepted.promptSetVersionId) })),
  };
}
