/**
 * The instructions layer (spec 020 Phase 2).
 *
 * The distinction this module exists to enforce:
 *
 *   FACT:        "Northvale Demo operates in Jersey City."
 *   INSTRUCTION: "For seller-facing content, lead with Jersey City before Hoboken."
 *
 * Today the second kind can only be expressed as a string array hanging off an
 * individual claim, which means rules and facts arrive fused in one blob and an
 * agent cannot tell which is which. Instructions get their own versioned,
 * scoped, effective-dated records so a packet can carry them separately and
 * label them as rules.
 *
 * Versions are immutable. Changing an instruction creates a new version and
 * repoints `active_version_id`; the old text stays readable, so a packet built
 * last month still explains the wording it produced.
 */
import { z } from "zod";
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { publishEvent } from "@/lib/events/bus";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";

type Tx = TransactionSql | typeof sql;

export const INSTRUCTION_TYPES = [
  "evidence_policy",
  "privacy_policy",
  "attribution_policy",
  "content_quality",
  "escalation_policy",
  "workflow",
  "agent",
  "brand_voice",
  "approval_rule",
  "confidentiality",
  "prohibited_claim",
  "preferred_positioning",
  "tone",
  "connector_usage",
] as const;
export type InstructionType = (typeof INSTRUCTION_TYPES)[number];

export const INSTRUCTION_SCOPES = ["global", "project", "workflow", "agent"] as const;
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number];

/**
 * Types whose content is a safety or privacy rule. These are never truncated
 * out of a packet by the token budget (spec 022).
 */
export const SAFETY_INSTRUCTION_TYPES: InstructionType[] = [
  "privacy_policy",
  "confidentiality",
  "prohibited_claim",
  "approval_rule",
  "escalation_policy",
];

export interface ResolvedInstruction {
  id: string;
  versionId: string;
  version: number;
  instructionType: InstructionType;
  scope: InstructionScope;
  scopeRef: string | null;
  title: string;
  body: string;
  priority: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  isSafety: boolean;
}

const createSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  instructionType: z.enum(INSTRUCTION_TYPES),
  scope: z.enum(INSTRUCTION_SCOPES).default("project"),
  scopeRef: z.string().max(200).optional(),
  title: z.string().trim().min(1, "An instruction needs a title.").max(200),
  body: z.string().trim().min(1, "An instruction needs a body.").max(5000),
  priority: z.number().int().min(0).max(1000).default(100),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  requiresApproval: z.boolean().default(false),
  owner: z.string().max(200).default(""),
});

export async function createInstruction(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ instructionId: string; versionId: string; version: number }>> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  if ((input.scope === "workflow" || input.scope === "agent") && !input.scopeRef) {
    return fail(
      new ClassifiedError(
        "validation",
        `A ${input.scope}-scoped instruction must name the ${input.scope} it applies to.`
      )
    );
  }
  if (input.scope === "project" && !input.projectId) {
    return fail(
      new ClassifiedError("validation", "A project-scoped instruction needs a client.")
    );
  }

  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [instruction] = await tx`
        insert into knowledge_instructions (
          project_id, instruction_type, scope, scope_ref, title, owner, created_by
        ) values (
          ${input.projectId ?? null}, ${input.instructionType}, ${input.scope},
          ${input.scopeRef ?? null}, ${input.title}, ${input.owner}, ${user.id}
        )
        returning id
      `;
      const instructionId = instruction!.id as string;
      const version = await insertVersion(tx, {
        instructionId,
        version: 1,
        input,
        userId: user.id,
        changeReason: "initial",
      });
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.instruction.create",
        entity: "knowledge_instruction",
        entityId: instructionId,
        detail: { instructionType: input.instructionType, scope: input.scope },
      });
      await publishEvent(tx, {
        type: "instruction.created",
        projectId: input.projectId ?? null,
        payload: {
          instructionId,
          instructionType: input.instructionType,
          scope: input.scope,
          version: 1,
        },
      });
      return { instructionId, versionId: version.id, version: version.version };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

const reviseSchema = z.object({
  instructionId: z.string().uuid(),
  body: z.string().trim().min(1).max(5000),
  priority: z.number().int().min(0).max(1000).optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  requiresApproval: z.boolean().optional(),
  changeReason: z.string().trim().min(1, "Say why the instruction changed.").max(500),
});

/** Revise an instruction. The previous version is preserved, never edited. */
export async function reviseInstruction(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ instructionId: string; versionId: string; version: number }>> {
  const parsed = reviseSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [instruction] = await tx`
        select i.id, i.project_id, i.instruction_type, i.scope, i.status,
          v.version, v.priority, v.requires_approval, v.effective_until
        from knowledge_instructions i
        left join knowledge_instruction_versions v on v.id = i.active_version_id
        where i.id = ${input.instructionId} for update of i
      `;
      if (!instruction) throw new ClassifiedError("not_found", "Instruction not found.");
      if (instruction.status !== "active") {
        throw new ClassifiedError("conflict", "A retired instruction cannot be revised.");
      }
      const nextVersion = ((instruction.version as number | null) ?? 0) + 1;
      const version = await insertVersion(tx, {
        instructionId: input.instructionId,
        version: nextVersion,
        input: {
          body: input.body,
          priority: input.priority ?? (instruction.priority as number | null) ?? 100,
          effectiveFrom: input.effectiveFrom,
          effectiveUntil:
            input.effectiveUntil === undefined
              ? dateString(instruction.effectiveUntil)
              : input.effectiveUntil,
          requiresApproval:
            input.requiresApproval ?? Boolean(instruction.requiresApproval ?? false),
        },
        userId: user.id,
        changeReason: input.changeReason,
      });
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.instruction.revise",
        entity: "knowledge_instruction",
        entityId: input.instructionId,
        detail: { version: nextVersion, reason: input.changeReason },
      });
      await publishEvent(tx, {
        type: "instruction.updated",
        projectId: (instruction.projectId as string | null) ?? null,
        payload: {
          instructionId: input.instructionId,
          instructionType: instruction.instructionType as string,
          scope: instruction.scope as string,
          version: nextVersion,
        },
      });
      return { instructionId: input.instructionId, versionId: version.id, version: nextVersion };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

export async function approveInstructionVersion(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ versionId: string }>> {
  const parsed = z.object({ versionId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid version id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      // The version row is immutable, so approval is recorded on the parent and
      // the version's own approval columns are set at insert time. An approval
      // arriving later supersedes with an identical body and an approver.
      const [version] = await tx`
        select v.id, v.instruction_id, v.version, v.body, v.priority,
          to_char(v.effective_from, 'YYYY-MM-DD') as effective_from,
          to_char(v.effective_until, 'YYYY-MM-DD') as effective_until,
          v.approved_by, i.project_id, i.instruction_type, i.scope
        from knowledge_instruction_versions v
        join knowledge_instructions i on i.id = v.instruction_id
        where v.id = ${parsed.data.versionId}
      `;
      if (!version) throw new ClassifiedError("not_found", "Instruction version not found.");
      if (version.approvedBy) {
        throw new ClassifiedError("conflict", "That version is already approved.");
      }
      const nextVersion = (version.version as number) + 1;
      const [row] = await tx`
        insert into knowledge_instruction_versions (
          instruction_id, version, body, priority, effective_from, effective_until,
          requires_approval, approved_by, approved_at, change_reason, created_by
        ) values (
          ${version.instructionId}, ${nextVersion}, ${version.body}, ${version.priority},
          ${version.effectiveFrom}, ${version.effectiveUntil}, true, ${user.id}, now(),
          'approved', ${user.id}
        )
        returning id
      `;
      await tx`
        update knowledge_instructions
        set active_version_id = ${row!.id}, updated_at = now()
        where id = ${version.instructionId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.instruction.approve",
        entity: "knowledge_instruction",
        entityId: version.instructionId as string,
        detail: { version: nextVersion },
      });
    });
    return ok({ versionId: parsed.data.versionId });
  } catch (err) {
    return fail(err);
  }
}

async function insertVersion(
  tx: Tx,
  args: {
    instructionId: string;
    version: number;
    input: {
      body: string;
      priority?: number;
      effectiveFrom?: string;
      effectiveUntil?: string | null;
      requiresApproval?: boolean;
    };
    userId: string;
    changeReason: string;
  }
): Promise<{ id: string; version: number }> {
  const [row] = await tx`
    insert into knowledge_instruction_versions (
      instruction_id, version, body, priority, effective_from, effective_until,
      requires_approval, change_reason, created_by
    ) values (
      ${args.instructionId}, ${args.version}, ${args.input.body},
      ${args.input.priority ?? 100},
      ${args.input.effectiveFrom ?? new Date().toISOString().slice(0, 10)},
      ${args.input.effectiveUntil ?? null}, ${args.input.requiresApproval ?? false},
      ${args.changeReason}, ${args.userId}
    )
    returning id
  `;
  await tx`
    update knowledge_instructions
    set active_version_id = ${row!.id}, updated_at = now()
    where id = ${args.instructionId}
  `;
  return { id: row!.id as string, version: args.version };
}

// ----------------------------------------------------------------- resolution

export interface ResolveInstructionsArgs {
  projectId: string | null;
  workflowKey?: string | null;
  agentKey?: string | null;
  /** Point in time the instruction set is resolved for. Defaults to now. */
  at?: Date;
  types?: InstructionType[];
}

/**
 * The effective instruction set for one task.
 *
 * An instruction whose active version `requires_approval` and has no approver
 * is **excluded** — an unapproved rule is a draft, and drafts do not govern
 * agent behaviour. Callers surface the exclusion in the packet's missing-context
 * list rather than pretending the rule was applied.
 */
export async function resolveInstructions(
  args: ResolveInstructionsArgs
): Promise<{ instructions: ResolvedInstruction[]; excluded: { title: string; reason: string }[] }> {
  const at = args.at ?? new Date();
  const isoAt = at.toISOString().slice(0, 10);

  const rows = await sql`
    select i.id, i.instruction_type, i.scope, i.scope_ref, i.title, i.project_id,
      v.id as version_id, v.version, v.body, v.priority,
      to_char(v.effective_from, 'YYYY-MM-DD') as effective_from,
      to_char(v.effective_until, 'YYYY-MM-DD') as effective_until,
      v.requires_approval, v.approved_by
    from knowledge_instructions i
    join knowledge_instruction_versions v on v.id = i.active_version_id
    where i.status = 'active'
      and (
        i.scope = 'global'
        or (i.scope = 'project' and i.project_id = ${args.projectId})
        or (i.scope = 'workflow' and i.scope_ref = ${args.workflowKey ?? null})
        or (i.scope = 'agent' and i.scope_ref = ${args.agentKey ?? null})
      )
      ${args.types?.length ? sql`and i.instruction_type = any(${args.types})` : sql``}
    order by v.priority asc, i.instruction_type asc
  `;

  const instructions: ResolvedInstruction[] = [];
  const excluded: { title: string; reason: string }[] = [];

  for (const row of rows) {
    const from = row.effectiveFrom as string;
    const until = (row.effectiveUntil as string | null) ?? null;
    if (from > isoAt) {
      excluded.push({
        title: row.title as string,
        reason: `Not effective until ${from}.`,
      });
      continue;
    }
    if (until && until <= isoAt) {
      excluded.push({ title: row.title as string, reason: `Expired on ${until}.` });
      continue;
    }
    if (row.requiresApproval && !row.approvedBy) {
      excluded.push({
        title: row.title as string,
        reason: "Requires approval and has not been approved.",
      });
      continue;
    }
    const type = row.instructionType as InstructionType;
    instructions.push({
      id: row.id as string,
      versionId: row.versionId as string,
      version: row.version as number,
      instructionType: type,
      scope: row.scope as InstructionScope,
      scopeRef: (row.scopeRef as string | null) ?? null,
      title: row.title as string,
      body: row.body as string,
      priority: row.priority as number,
      effectiveFrom: from,
      effectiveUntil: until,
      isSafety: SAFETY_INSTRUCTION_TYPES.includes(type),
    });
  }

  return { instructions, excluded };
}

function dateString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export interface PendingInstructionVersion {
  versionId: string;
  instructionId: string;
  version: number;
  title: string;
  instructionType: InstructionType;
  body: string;
}

/** Active-version instructions gated on an approval nobody has given (D3) —
 * the rows behind the "requires approval" entries in the excluded list, with
 * the version id the approve button needs. */
export async function pendingInstructionApprovals(
  projectId: string | null
): Promise<PendingInstructionVersion[]> {
  return sql<PendingInstructionVersion[]>`
    select v.id as version_id, i.id as instruction_id, v.version, i.title,
      i.instruction_type, v.body
    from knowledge_instructions i
    join knowledge_instruction_versions v on v.id = i.active_version_id
    where i.status = 'active' and v.requires_approval and v.approved_by is null
      and (i.project_id = ${projectId} or i.project_id is null)
    order by i.title asc
  `;
}
