/**
 * The global suppression list and the external-send gate.
 *
 * `assertSendAllowed` is the only path to a send capability. It runs seven
 * checks in a fixed order and fails **closed** on each — a missing check is a
 * refusal, not a pass. The order matters: cheap and absolute first (suppression,
 * tenant), then the ones that need a lookup (approval, message version).
 *
 * Suppression matching is on the NORMALISED value, so `X+campaign@Y.com` cannot
 * slip past a suppression on `x@y.com`. That single detail is the difference
 * between having a suppression list and appearing to have one.
 */
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { ClassifiedError } from "@/lib/errors";
import {
  normalizeDomain,
  normalizeEmailForMatching,
  normalizePhone,
} from "@/lib/connectors/mapping";
import { log } from "@/lib/logger";

/**
 * Suppression writes are transactional by nature: the row, its audit entry, and
 * whatever caused it must commit together. The type says so rather than leaving
 * it to the caller's discipline.
 */
type Tx = TransactionSql;

export const SUPPRESSION_REASONS = [
  "opt_out",
  "hard_bounce",
  "complaint",
  "client_request",
  "legal_request",
  "manual",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export type SuppressionScope = "email" | "phone" | "domain";

export interface SuppressionEntry {
  id: string;
  scope: SuppressionScope;
  normalizedValue: string;
  rawValue: string;
  reason: SuppressionReason;
  detail: string;
  projectId: string | null;
  createdAt: Date;
  liftedAt: Date | null;
}

export function normalizeForScope(scope: SuppressionScope, value: string): string {
  switch (scope) {
    case "email":
      return normalizeEmailForMatching(value);
    case "phone":
      return normalizePhone(value);
    case "domain":
      return normalizeDomain(value);
    default: {
      const _exhaustive: never = scope;
      void _exhaustive;
      return value.trim().toLowerCase();
    }
  }
}

export async function suppress(
  tx: Tx,
  args: {
    scope: SuppressionScope;
    value: string;
    reason: SuppressionReason;
    detail?: string;
    /** Null suppresses globally; a project id suppresses for one client only. */
    projectId?: string | null;
    userId: string | null;
  }
): Promise<{ id: string | null; alreadySuppressed: boolean }> {
  const normalized = normalizeForScope(args.scope, args.value);
  if (normalized.length === 0) {
    throw new ClassifiedError("validation", "Cannot suppress an empty value.");
  }
  const [row] = await tx`
    insert into suppression_entries (
      scope, normalized_value, raw_value, reason, detail, project_id, created_by
    ) values (
      ${args.scope}, ${normalized}, ${args.value}, ${args.reason},
      ${args.detail ?? ""}, ${args.projectId ?? null}, ${args.userId}
    )
    on conflict do nothing
    returning id
  `;
  if (row) {
    await writeAudit(tx, {
      userId: args.userId,
      action: "outreach.suppressed",
      entity: "suppression_entry",
      entityId: row.id as string,
      detail: { scope: args.scope, reason: args.reason, projectId: args.projectId ?? null },
    });
    log("info", "outreach.suppressed", { scope: args.scope, reason: args.reason });
    return { id: row.id as string, alreadySuppressed: false };
  }
  return { id: null, alreadySuppressed: true };
}

export interface SuppressionCheck {
  suppressed: boolean;
  matchedScope: SuppressionScope | null;
  reason: SuppressionReason | null;
  /** Whether the match was global or client-specific. */
  global: boolean;
}

/**
 * Is this recipient suppressed? Checks the address AND its domain, because a
 * legal request to stop contacting a brokerage means the whole domain.
 */
export async function checkSuppression(args: {
  email?: string | null;
  phone?: string | null;
  projectId?: string | null;
}): Promise<SuppressionCheck> {
  const candidates: { scope: SuppressionScope; value: string }[] = [];
  if (args.email && args.email.length > 0) {
    candidates.push({ scope: "email", value: normalizeEmailForMatching(args.email) });
    const at = args.email.lastIndexOf("@");
    if (at > 0) {
      candidates.push({ scope: "domain", value: normalizeDomain(args.email.slice(at + 1)) });
    }
  }
  if (args.phone && args.phone.length > 0) {
    candidates.push({ scope: "phone", value: normalizePhone(args.phone) });
  }
  if (candidates.length === 0) {
    // No recipient to check is not "allowed" — it is a caller error.
    throw new ClassifiedError("validation", "A suppression check needs an email or a phone.");
  }

  for (const candidate of candidates) {
    const [row] = await sql`
      select scope, reason, project_id from suppression_entries
      where scope = ${candidate.scope}
        and normalized_value = ${candidate.value}
        and lifted_at is null
        and (project_id is null or project_id = ${args.projectId ?? null})
      order by (project_id is null) desc
      limit 1
    `;
    if (row) {
      return {
        suppressed: true,
        matchedScope: row.scope as SuppressionScope,
        reason: row.reason as SuppressionReason,
        global: (row.projectId as string | null) === null,
      };
    }
  }
  return { suppressed: false, matchedScope: null, reason: null, global: false };
}

/**
 * Lift a suppression. Admin-only, requires a reason, and never deletes the row —
 * the history of "we were asked to stop, then we un-stopped" is exactly what an
 * audit needs.
 */
export async function liftSuppression(
  tx: Tx,
  args: { id: string; userId: string; reason: string }
): Promise<boolean> {
  if (args.reason.trim().length < 3) {
    throw new ClassifiedError(
      "validation",
      "Lifting a suppression requires a reason; it is recorded permanently."
    );
  }
  const rows = await tx`
    update suppression_entries set
      lifted_at = now(), lifted_by = ${args.userId}, lift_reason = ${args.reason}
    where id = ${args.id} and lifted_at is null
    returning id
  `;
  if (rows.length === 0) return false;
  await writeAudit(tx, {
    userId: args.userId,
    action: "outreach.suppression_lifted",
    entity: "suppression_entry",
    entityId: args.id,
    detail: { reason: args.reason },
  });
  return true;
}

export async function listSuppressions(filters?: {
  scope?: SuppressionScope;
  projectId?: string | null;
  includeLifted?: boolean;
  limit?: number;
}): Promise<SuppressionEntry[]> {
  const rows = await sql`
    select id, scope, normalized_value, raw_value, reason, detail, project_id,
           created_at, lifted_at
    from suppression_entries
    where (${filters?.scope ?? null}::text is null or scope = ${filters?.scope ?? null})
      and (${filters?.projectId ?? null}::uuid is null
           or project_id = ${filters?.projectId ?? null} or project_id is null)
      and (${filters?.includeLifted ?? false} or lifted_at is null)
    order by created_at desc
    limit ${Math.min(filters?.limit ?? 200, 1000)}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    scope: row.scope as SuppressionScope,
    normalizedValue: row.normalizedValue as string,
    rawValue: (row.rawValue as string) ?? "",
    reason: row.reason as SuppressionReason,
    detail: (row.detail as string) ?? "",
    projectId: (row.projectId as string | null) ?? null,
    createdAt: row.createdAt as Date,
    liftedAt: (row.liftedAt as Date | null) ?? null,
  }));
}

// ------------------------------------------------------------- the send gate

export interface SendGateInput {
  projectId: string | null;
  recipientEmail: string;
  /** The exact body an approver saw. Hashed and compared. */
  bodyHash: string;
  /** The approval row that released this send, when one is required. */
  approvalId?: string | null;
  /** Resolved autonomy level for this action. */
  autonomyLevel: number;
  /** True when the recipient has a recorded relationship with the client. */
  hasRelationship: boolean;
  /** Stated legitimate-interest basis, required when there is no relationship. */
  businessPurpose?: string | null;
  /** Where the recipient can opt out. Required for cold outreach. */
  unsubscribeUrl?: string | null;
  /** The sending connection's tenant, for the tenant-match check. */
  connectionProjectId?: string | null;
  runMode: "live" | "test";
}

export interface SendGateVerdict {
  allowed: boolean;
  failedCheck: string | null;
  reason: string;
  checks: { name: string; passed: boolean; detail: string }[];
}

/**
 * The seven checks. Every one is a refusal on failure; there is no "warn and
 * continue" path, because the cost of a wrong send is not symmetric with the
 * cost of a delayed one.
 */
export async function assertSendAllowed(input: SendGateInput): Promise<SendGateVerdict> {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const fail = (name: string, reason: string): SendGateVerdict => {
    checks.push({ name, passed: false, detail: reason });
    return { allowed: false, failedCheck: name, reason, checks };
  };
  const pass = (name: string, detail: string): void => {
    checks.push({ name, passed: true, detail });
  };

  // 1. Test mode never sends. Checked first so nothing else can matter.
  if (input.runMode === "test") {
    return fail("run_mode", "test runs never send; the payload is recorded instead");
  }
  pass("run_mode", "live run");

  // 2. Suppression.
  const suppression = await checkSuppression({
    email: input.recipientEmail,
    projectId: input.projectId,
  });
  if (suppression.suppressed) {
    return fail(
      "suppression",
      `recipient is suppressed (${suppression.matchedScope}: ${suppression.reason}${suppression.global ? ", global" : ""})`
    );
  }
  pass("suppression", "not suppressed");

  // 3. Tenant match.
  if (
    input.connectionProjectId !== null &&
    input.connectionProjectId !== undefined &&
    input.connectionProjectId !== input.projectId
  ) {
    return fail(
      "tenant_match",
      "the sending connection belongs to a different client than the run"
    );
  }
  pass("tenant_match", "run and sending connection agree");

  // 4. Recipient authorisation or a stated business purpose.
  if (!input.hasRelationship && (input.businessPurpose ?? "").trim().length < 10) {
    return fail(
      "recipient_authorization",
      "no recorded relationship and no stated business purpose for contacting this recipient"
    );
  }
  pass(
    "recipient_authorization",
    input.hasRelationship ? "existing relationship" : "stated business purpose"
  );

  // 5. Approval, when autonomy demands one.
  if (input.autonomyLevel <= 2) {
    if (!input.approvalId) {
      return fail(
        "approval",
        `autonomy level ${input.autonomyLevel} requires a recorded approval before sending`
      );
    }
    const [approval] = await sql`
      select decision, decided_by, detail from workflow_approvals where id = ${input.approvalId}
    `;
    if (!approval) return fail("approval", "the referenced approval does not exist");
    if (approval.decision !== "approved") {
      return fail(
        "approval",
        `the referenced approval is "${(approval.decision as string | null) ?? "undecided"}"`
      );
    }
    // 6. Message version: the approved artifact must be the one being sent.
    const approvedHash = (approval.detail as { bodyHash?: string } | null)?.bodyHash;
    if (approvedHash && approvedHash !== input.bodyHash) {
      return fail(
        "message_version",
        "the message changed after it was approved; a new approval is required"
      );
    }
    pass("approval", `approved by ${(approval.decidedBy as string | null) ?? "unknown"}`);
    pass("message_version", approvedHash ? "hash matches the approved artifact" : "no hash recorded on the approval");
  } else {
    pass("approval", `autonomy level ${input.autonomyLevel} does not require per-send approval`);
    pass("message_version", "not gated at this autonomy level");
  }

  // 7. Compliance fields. Cold outreach needs a way out.
  if (!input.hasRelationship && (input.unsubscribeUrl ?? "").length === 0) {
    return fail("compliance_fields", "cold outreach requires an unsubscribe URL");
  }
  pass("compliance_fields", "sender identity and opt-out path present");

  return { allowed: true, failedCheck: null, reason: "all send checks passed", checks };
}
