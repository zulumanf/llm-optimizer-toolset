/**
 * Client self-service onboarding (spec 155). Two audiences, two gates:
 *
 * - Operator (assertCanWrite): prepare the draft from records, mark it ready.
 *   Ready is refused before the commercial gate (stage onboarding/active).
 * - Client (assertClientApprover): save corrections, confirm priorities,
 *   confirm contacts. The engagement is always resolved from the project the
 *   client is granted — never from client-supplied ids.
 *
 * The outcome is recorded in the existing ledgers (context items with client
 * provenance + one `intake` decision via the portal channel), so spec 154's
 * journey sees "details confirmed" with no second rule.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany } from "@/db/companies";
import { assertCanWrite, assertClientApprover, assertProjectAccess, isClient, isClientApprover, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  engagementForProject,
  getEngagement,
  insertContextItem,
  listContextItems,
  type EngagementRow,
} from "@/lib/engagements/service";
import { minPropertyValueFrom, onboardingPrefill } from "@/lib/engagements/onboarding-intake";
import {
  CLIENT_ONBOARDING_VERSION,
  EMPTY_CONTACTS,
  EMPTY_PRIORITIES,
  ONBOARDING_OPEN_STAGES,
  changedFields,
  contactsSchema,
  defaultPrimaryFocus,
  effective,
  marketDiffers,
  missingContactFields,
  onboardingContextItems,
  onboardingStep,
  preparedMissing,
  preparedPrioritiesSchema,
  prioritiesSchema,
  validateFinalContacts,
  type ContactField,
  type OnboardingContacts,
  type OnboardingPriorities,
  type OnboardingStatus,
  type OnboardingStep,
  type PreparedPriorities,
} from "@/lib/engagements/client-onboarding-rules";

const idSchema = z.string().uuid();

export interface OnboardingRow {
  id: string;
  engagementId: string;
  projectId: string;
  status: OnboardingStatus;
  preparedPriorities: PreparedPriorities;
  preparedContacts: OnboardingContacts;
  clientPriorities: OnboardingPriorities | null;
  clientContacts: OnboardingContacts | null;
  readyAt: Date | null;
  prioritiesConfirmedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

function mapRow(r: Record<string, unknown>): OnboardingRow {
  return {
    id: r.id as string,
    engagementId: r.engagementId as string,
    projectId: r.projectId as string,
    status: r.status as OnboardingStatus,
    preparedPriorities: { ...EMPTY_PRIORITIES, ...((r.preparedPriorities as Partial<PreparedPriorities>) ?? {}) },
    preparedContacts: { ...EMPTY_CONTACTS, ...((r.preparedContacts as Partial<OnboardingContacts>) ?? {}) },
    clientPriorities: (r.clientPriorities as OnboardingPriorities | null) ?? null,
    clientContacts: (r.clientContacts as OnboardingContacts | null) ?? null,
    readyAt: (r.readyAt as Date | null) ?? null,
    prioritiesConfirmedAt: (r.prioritiesConfirmedAt as Date | null) ?? null,
    completedAt: (r.completedAt as Date | null) ?? null,
    updatedAt: r.updatedAt as Date,
  };
}

export async function onboardingForEngagement(engagementId: string): Promise<OnboardingRow | null> {
  const [r] = await sql`select * from client_onboardings where engagement_id = ${engagementId}`;
  return r ? mapRow(r) : null;
}

async function lockOnboarding(tx: TransactionSql, engagementId: string): Promise<OnboardingRow | null> {
  const [r] = await tx`select * from client_onboardings where engagement_id = ${engagementId} for update`;
  return r ? mapRow(r) : null;
}

async function audit(tx: TransactionSql, actorId: string, e: EngagementRow, action: string, detail: Record<string, unknown>): Promise<void> {
  await writeAudit(tx, { userId: actorId, action, entity: "client_engagement", entityId: e.id, projectId: e.projectId, detail: JSON.parse(JSON.stringify(detail)) as Record<string, never> });
}

const stageOpen = (e: EngagementRow) => (ONBOARDING_OPEN_STAGES as readonly string[]).includes(e.stage);

// ------------------------------------------------------------- operator

/** The operator's starting draft, from what records already say. */
export async function onboardingDefaults(engagementId: string): Promise<{ priorities: PreparedPriorities; contacts: OnboardingContacts } | null> {
  const e = await getEngagement(engagementId);
  if (!e) return null;
  const [prefill, context] = await Promise.all([onboardingPrefill(engagementId), listContextItems(engagementId)]);
  const approver = context
    .filter((c) => c.kind === "identity" && c.value.role === "approver" && typeof c.value.name === "string")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const focusLabels = context.filter((c) => c.kind === "client_focus" || c.kind === "priority_area").map((c) => c.label);
  const primaryName = prefill?.primaryContactName ?? e.primaryContactName ?? "";
  const approverName = (approver?.value.name as string | undefined) ?? "";
  return {
    priorities: {
      primaryFocus: defaultPrimaryFocus(focusLabels),
      minPropertyValueUsd: minPropertyValueFrom(context),
      additionalOpportunity: "",
      market: e.marketName ?? "",
    },
    contacts: {
      primaryName,
      primaryEmail: prefill?.contactEmail ?? "",
      approverIsPrimary: approverName !== "" && approverName.toLowerCase() === primaryName.toLowerCase(),
      approverName,
      approverEmail: (approver?.value.email as string | null | undefined) ?? "",
    },
  };
}

const prepareSchema = z.object({
  engagementId: idSchema,
  priorities: preparedPrioritiesSchema,
  contacts: contactsSchema,
});

/** Create or edit the draft. Refused once the client has started confirming. */
export async function prepareClientOnboarding(user: CurrentUser, raw: unknown): Promise<ActionResult<{ onboardingId: string }>> {
  const parsed = prepareSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const i = parsed.data;
  try {
    assertCanWrite(user);
    const e = await getEngagement(i.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    const id = await sql.begin(async (tx) => {
      const existing = await lockOnboarding(tx, e.id);
      if (existing && (existing.status === "completed" || existing.prioritiesConfirmedAt || existing.clientPriorities || existing.clientContacts)) {
        throw new ClassifiedError("conflict", "The client has already started confirming. Their answers are kept; talk to them about further changes.");
      }
      const [row] = existing
        ? await tx`
            update client_onboardings set prepared_priorities = ${tx.json(i.priorities as never)}, prepared_contacts = ${tx.json(i.contacts as never)},
              prepared_by = ${user.id}, updated_at = now()
            where id = ${existing.id} returning id`
        : await tx`
            insert into client_onboardings (engagement_id, project_id, prepared_priorities, prepared_contacts, prepared_by)
            values (${e.id}, ${e.projectId}, ${tx.json(i.priorities as never)}, ${tx.json(i.contacts as never)}, ${user.id})
            returning id`;
      await audit(tx, user.id, e, "engagement.client_onboarding_prepared", { priorities: i.priorities, contacts: i.contacts });
      return row!.id as string;
    });
    return ok({ onboardingId: id });
  } catch (err) {
    return fail(err);
  }
}

/** Show the onboarding to the client. Behind the commercial gate. */
export async function markOnboardingReady(user: CurrentUser, raw: unknown): Promise<ActionResult<{ onboardingId: string }>> {
  const parsed = z.object({ engagementId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const e = await getEngagement(parsed.data.engagementId);
    if (!e) throw new ClassifiedError("not_found", "Engagement not found.");
    if (!stageOpen(e)) throw new ClassifiedError("conflict", `The engagement is ${e.stage}. Onboarding opens once the commercial gate passes (stage onboarding).`);
    const id = await sql.begin(async (tx) => {
      const row = await lockOnboarding(tx, e.id);
      if (!row) throw new ClassifiedError("not_found", "Prepare the onboarding first.");
      if (row.status !== "draft") throw new ClassifiedError("conflict", `Onboarding is already ${row.status}.`);
      const missing = preparedMissing(row.preparedPriorities);
      if (missing.length > 0) throw new ClassifiedError("validation", `Fill in the ${missing.join(" and ")} before sharing.`);
      await tx`update client_onboardings set status = 'ready', ready_at = now(), updated_at = now() where id = ${row.id}`;
      await audit(tx, user.id, e, "engagement.client_onboarding_ready", { onboardingId: row.id });
      return row.id;
    });
    return ok({ onboardingId: id });
  } catch (err) {
    return fail(err);
  }
}

// --------------------------------------------------------------- client

/** Resolve the client's engagement + open onboarding from the project. */
async function clientContext(user: CurrentUser, projectId: string): Promise<EngagementRow> {
  await assertClientApprover(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e || !stageOpen(e)) throw new ClassifiedError("not_found", "There is nothing to confirm right now.");
  return e;
}

function openRow(row: OnboardingRow | null): OnboardingRow {
  if (!row || row.status === "draft") throw new ClassifiedError("not_found", "There is nothing to confirm right now.");
  if (row.status === "completed") throw new ClassifiedError("conflict", "You've already confirmed these details.");
  return row;
}

export const clientActorOf = (user: CurrentUser): string => (user.name && user.name !== user.email ? `${user.name} <${user.email}>` : user.email);

const savePrioritiesSchema = z.object({ projectId: idSchema, priorities: prioritiesSchema });

/** Save the client's corrections (working copy). Not a confirmation. */
export async function saveOnboardingPriorities(user: CurrentUser, raw: unknown): Promise<ActionResult<{ saved: true }>> {
  const parsed = savePrioritiesSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    const e = await clientContext(user, parsed.data.projectId);
    await sql.begin(async (tx) => {
      const row = openRow(await lockOnboarding(tx, e.id));
      const before = effective<OnboardingPriorities | PreparedPriorities>(row.preparedPriorities, row.clientPriorities);
      await tx`update client_onboardings set client_priorities = ${tx.json(parsed.data.priorities as never)}, updated_at = now() where id = ${row.id}`;
      await audit(tx, user.id, e, "engagement.client_onboarding_priorities_saved", { before, after: parsed.data.priorities, channel: "portal" });
    });
    return ok({ saved: true });
  } catch (err) {
    return fail(err);
  }
}

/** "Looks good": the client confirms the priorities as currently shown. */
export async function confirmOnboardingPriorities(user: CurrentUser, raw: unknown): Promise<ActionResult<{ step: OnboardingStep }>> {
  const parsed = z.object({ projectId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    const e = await clientContext(user, parsed.data.projectId);
    await sql.begin(async (tx) => {
      const row = openRow(await lockOnboarding(tx, e.id));
      const current = effective<OnboardingPriorities | PreparedPriorities>(row.preparedPriorities, row.clientPriorities);
      const valid = prioritiesSchema.safeParse(current);
      if (!valid.success) throw new ClassifiedError("validation", firstZodMessage(valid.error));
      await tx`
        update client_onboardings set priorities_confirmed_at = now(), priorities_confirmed_by = ${user.id}, updated_at = now()
        where id = ${row.id}`;
      await audit(tx, user.id, e, "engagement.client_onboarding_priorities_confirmed", { priorities: valid.data, channel: "portal" });
    });
    return ok({ step: "contacts" });
  } catch (err) {
    return fail(err);
  }
}

/** Go back to the priorities step (keeps every saved value). */
export async function reopenOnboardingPriorities(user: CurrentUser, raw: unknown): Promise<ActionResult<{ step: OnboardingStep }>> {
  const parsed = z.object({ projectId: idSchema }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    const e = await clientContext(user, parsed.data.projectId);
    await sql.begin(async (tx) => {
      const row = openRow(await lockOnboarding(tx, e.id));
      await tx`update client_onboardings set priorities_confirmed_at = null, priorities_confirmed_by = null, updated_at = now() where id = ${row.id}`;
      await audit(tx, user.id, e, "engagement.client_onboarding_priorities_reopened", { channel: "portal" });
    });
    return ok({ step: "priorities" });
  } catch (err) {
    return fail(err);
  }
}

const completeSchema = z.object({ projectId: idSchema, contacts: contactsSchema });

/**
 * "Continue" on the contact step: confirms the contacts and completes the
 * onboarding — context items, the `intake` decision and the status change in
 * one transaction. What changed from the prepared draft is recorded in the
 * decision snapshot so the operator sees corrections, not just a final state.
 */
export async function completeClientOnboarding(user: CurrentUser, raw: unknown): Promise<ActionResult<{ step: OnboardingStep }>> {
  const parsed = completeSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    const e = await clientContext(user, parsed.data.projectId);
    const final: OnboardingContacts = { ...parsed.data.contacts };
    if (final.approverIsPrimary) {
      final.approverName = "";
      final.approverEmail = "";
    }
    const check = validateFinalContacts(final);
    if (!check.ok) throw new ClassifiedError("validation", check.message);
    await sql.begin(async (tx) => {
      const row = openRow(await lockOnboarding(tx, e.id));
      if (!row.prioritiesConfirmedAt) throw new ClassifiedError("conflict", "Please confirm your priorities first.");
      const priorities = prioritiesSchema.parse(effective<OnboardingPriorities | PreparedPriorities>(row.preparedPriorities, row.clientPriorities));
      const existing = await tx`select kind, label from engagement_context_items where engagement_id = ${e.id}`;
      const have = (kind: string, label: string) => existing.some((x) => x.kind === kind && (x.label as string).toLowerCase() === label.toLowerCase());
      const items = onboardingContextItems(priorities, final, e.marketName);
      let created = 0;
      for (const item of items) {
        if (have(item.kind, item.label)) continue;
        await insertContextItem(tx, user.id, { engagementId: e.id, ...item });
        created += 1;
      }
      const changedPriorities = changedFields(row.preparedPriorities as Record<string, unknown>, priorities as Record<string, unknown>);
      const changedContacts = changedFields(row.preparedContacts as Record<string, unknown>, final as Record<string, unknown>);
      const snapshot = {
        version: CLIENT_ONBOARDING_VERSION,
        detailsVersion: 1,
        priorities,
        contacts: final,
        changedFromPrepared: { priorities: changedPriorities, contacts: changedContacts },
        marketDiffersFromEngagement: marketDiffers(priorities.market, e.marketName),
      };
      await tx`
        insert into engagement_client_decisions (engagement_id, project_id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by)
        values (${e.id}, ${e.projectId}, 'intake', ${row.id}, 'approved', 'portal', ${clientActorOf(user)}, '', ${tx.json(snapshot as never)}, ${user.id})
      `;
      await tx`
        update client_onboardings set client_contacts = ${tx.json(final as never)}, status = 'completed',
          completed_at = now(), completed_by = ${user.id}, updated_at = now()
        where id = ${row.id}`;
      await audit(tx, user.id, e, "engagement.client_onboarding_completed", { onboardingId: row.id, itemsCreated: created, ...snapshot, channel: "portal" });
    });
    return ok({ step: "done" });
  } catch (err) {
    return fail(err);
  }
}

// -------------------------------------------- versioned corrections (R5)

export interface ConfirmedDetails {
  /** 1 = the onboarding confirmation; each correction adds one. */
  detailsVersion: number;
  priorities: OnboardingPriorities;
  contacts: OnboardingContacts;
  decidedAt: Date;
  clientActor: string;
  decisionId: string;
}

/** The client's current confirmed details: the latest `intake` decision. */
export async function currentClientDetails(engagementId: string): Promise<ConfirmedDetails | null> {
  const [d] = await sql`
    select id, snapshot, decided_at, client_actor from engagement_client_decisions
    where engagement_id = ${engagementId} and subject_kind = 'intake' and decision = 'approved'
      and snapshot ? 'priorities' and snapshot ? 'contacts'
    order by decided_at desc, id desc limit 1
  `;
  if (!d) return null;
  const snap = d.snapshot as { detailsVersion?: number; priorities: OnboardingPriorities; contacts: OnboardingContacts };
  return { detailsVersion: snap.detailsVersion ?? 1, priorities: snap.priorities, contacts: snap.contacts, decidedAt: d.decidedAt as Date, clientActor: d.clientActor as string, decisionId: d.id as string };
}

const correctionSchema = z.object({ projectId: idSchema, priorities: prioritiesSchema, contacts: contactsSchema });

/**
 * A correction after onboarding (spec 155 R5). The completed onboarding row
 * stays immutable; the correction is a NEW `intake` decision (portal) with
 * the next details version, the full corrected values and what changed,
 * plus client-provenance context items for the new values. The market is
 * recorded, never applied to the engagement.
 */
export async function submitDetailCorrection(user: CurrentUser, raw: unknown): Promise<ActionResult<{ detailsVersion: number; changed: string[] }>> {
  const parsed = correctionSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    const e = await clientContext(user, parsed.data.projectId);
    const row = await onboardingForEngagement(e.id);
    if (row?.status !== "completed") throw new ClassifiedError("conflict", "Please finish confirming your details first.");
    const final: OnboardingContacts = { ...parsed.data.contacts };
    if (final.approverIsPrimary) {
      final.approverName = "";
      final.approverEmail = "";
    }
    const check = validateFinalContacts(final);
    if (!check.ok) throw new ClassifiedError("validation", check.message);
    const priorities = parsed.data.priorities;
    const result = await sql.begin(async (tx) => {
      // Serialise corrections per engagement so versions never collide.
      await tx`select id from client_engagements where id = ${e.id} for update`;
      const current = await currentClientDetails(e.id);
      if (!current) throw new ClassifiedError("conflict", "Please finish confirming your details first.");
      const changedP = changedFields(current.priorities as Record<string, unknown>, priorities as Record<string, unknown>).map(String);
      const changedC = changedFields(current.contacts as Record<string, unknown>, final as Record<string, unknown>).map(String);
      if (changedP.length + changedC.length === 0) throw new ClassifiedError("validation", "Nothing changed.");
      const existing = await tx`select kind, label from engagement_context_items where engagement_id = ${e.id}`;
      const have = (kind: string, label: string) => existing.some((x) => x.kind === kind && (x.label as string).toLowerCase() === label.toLowerCase());
      for (const item of onboardingContextItems(priorities, final, e.marketName)) {
        if (!have(item.kind, item.label)) await insertContextItem(tx, user.id, { engagementId: e.id, ...item });
      }
      const detailsVersion = current.detailsVersion + 1;
      const snapshot = {
        version: CLIENT_ONBOARDING_VERSION,
        detailsVersion,
        priorities,
        contacts: final,
        changedFromPrevious: { priorities: changedP, contacts: changedC },
        previousDecisionId: current.decisionId,
        marketDiffersFromEngagement: marketDiffers(priorities.market, e.marketName),
      };
      await tx`
        insert into engagement_client_decisions (engagement_id, project_id, subject_kind, subject_ref, decision, channel, client_actor, note, snapshot, recorded_by)
        values (${e.id}, ${e.projectId}, 'intake', ${row.id}, 'approved', 'portal', ${clientActorOf(user)}, ${`Correction v${detailsVersion}`}, ${tx.json(snapshot as never)}, ${user.id})
      `;
      await audit(tx, user.id, e, "engagement.client_details_corrected", { ...snapshot, channel: "portal" });
      return { detailsVersion, changed: [...changedP, ...changedC] };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- reads

export interface OnboardingView {
  status: OnboardingStatus;
  step: OnboardingStep;
  businessName: string;
  priorities: PreparedPriorities;
  contacts: OnboardingContacts;
  /** Contact facts we do not have and must ask for. */
  missing: ContactField[];
  /** True only for the client's approver; staff previews and viewers read. */
  canRespond: boolean;
  /** Why the screens are read-only, when they are. */
  readOnlyReason: "staff_preview" | "viewer" | "closed" | null;
}

/**
 * The client's onboarding, or null when there is none to show (no
 * engagement, not prepared, or not yet ready). Re-asserts project access.
 */
export async function portalOnboarding(user: CurrentUser, projectId: string): Promise<OnboardingView | null> {
  await assertProjectAccess(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const row = await onboardingForEngagement(e.id);
  if (!row || row.status === "draft") return null;
  const subject = await getSubjectCompany(projectId);
  const [project] = await sql`select name from projects where id = ${projectId}`;
  const contacts = effective(row.preparedContacts, row.clientContacts);
  return {
    status: row.status,
    step: onboardingStep(row),
    businessName: subject?.name ?? (project?.name as string | undefined) ?? e.clientLegalName,
    priorities: effective<PreparedPriorities>(row.preparedPriorities, row.clientPriorities),
    contacts,
    missing: missingContactFields(row.preparedContacts),
    canRespond: isClientApprover(user) && stageOpen(e) && row.status === "ready",
    readOnlyReason: !isClient(user) ? "staff_preview" : !isClientApprover(user) ? "viewer" : stageOpen(e) && row.status === "ready" ? null : "closed",
  };
}

/** True when a client should be sent to the onboarding before the dashboard. */
export async function onboardingPending(user: CurrentUser, projectId: string): Promise<boolean> {
  // Only the approver is routed into onboarding; a viewer lands on the
  // dashboard (and can open the onboarding read-only).
  if (!isClientApprover(user)) return false;
  const v = await portalOnboarding(user, projectId);
  return Boolean(v && v.status === "ready");
}
