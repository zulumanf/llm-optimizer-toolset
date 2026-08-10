/**
 * Market exclusivity (spec 028). Agreements and markets are agency-level
 * data — staff see all of it; client roles get read-only denials via
 * assertCanWrite like every other write surface. The one admin-only path
 * is termination and overrides: ending a contractual protection or signing
 * past one is a decision the agency owner makes, not an operator.
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { z } from "zod";
import {
  assertCanWrite,
  assertProjectAccess,
  assertRole,
  type CurrentUser,
} from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  detectConflicts,
  wouldCreateCycle,
  type AgreementInput,
  type DetectionResult,
  type MarketNode,
} from "@/lib/exclusivity/detect";
import { MARKET_KINDS } from "@/lib/exclusivity/constants";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const marketSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(MARKET_KINDS),
  parentId: z.string().uuid().nullish(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});

const agreementSchema = z
  .object({
    projectId: z.string().uuid(),
    startsOn: dateSchema,
    endsOn: dateSchema.nullish(),
    gracePeriodDays: z.number().int().min(0).max(3650).default(0),
    notes: z.string().trim().max(2000).optional(),
    // reserved = pending-proposal hold (spec 052): occupies the territory in
    // conflict detection so a late-stage negotiation blocks parallel outreach.
    status: z.enum(["active", "reserved"]).default("active"),
    scopes: z
      .array(
        z.object({
          marketId: z.string().uuid(),
          serviceCategory: z.string().trim().min(1).max(120).nullish(),
          segment: z.string().trim().min(1).max(120).nullish(),
          notes: z.string().trim().max(500).optional(),
        })
      )
      .min(1, "An agreement protects at least one scope."),
  })
  .refine((a) => !a.endsOn || a.endsOn >= a.startsOn, {
    message: "endsOn must not precede startsOn.",
  });

const checkSchema = z.object({
  prospectName: z.string().trim().min(1).max(200),
  marketId: z.string().uuid(),
  serviceCategory: z.string().trim().min(1).max(120).nullish(),
  segment: z.string().trim().min(1).max(120).nullish(),
  decision: z.enum(["blocked", "override"]).optional(),
  overrideRationale: z.string().trim().max(2000).optional(),
});

export interface MarketRow extends MarketNode {
  kind: string;
  aliases: string[];
  parentName: string | null;
}

export async function listMarkets(): Promise<MarketRow[]> {
  return sql<MarketRow[]>`
    select m.id, m.name, m.kind, m.parent_id, m.aliases, p.name as parent_name
    from markets m left join markets p on p.id = m.parent_id
    order by m.name asc
  `;
}

export async function createMarket(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ marketId: string }>> {
  const parsed = marketSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    if (input.parentId) {
      const markets = await sql<MarketNode[]>`
        select id, name, parent_id from markets
      `;
      const parentExists = markets.some((m) => m.id === input.parentId);
      if (!parentExists) {
        return fail(new ClassifiedError("not_found", "Parent market not found."));
      }
    }
    const marketId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into markets (name, kind, parent_id, aliases, created_by)
        values (${input.name}, ${input.kind}, ${input.parentId ?? null},
          ${input.aliases}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "market.create",
        entity: "market",
        entityId: row?.id as string,
        detail: { name: input.name, kind: input.kind },
      });
      return row?.id as string;
    });
    return ok({ marketId });
  } catch (err) {
    return fail(err);
  }
}

export async function setMarketParent(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ marketId: string }>> {
  const parsed = z
    .object({ marketId: z.string().uuid(), parentId: z.string().uuid().nullable() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid market ids."));
  }
  const { marketId, parentId } = parsed.data;
  try {
    assertCanWrite(user);
    const markets = await sql<MarketNode[]>`select id, name, parent_id from markets`;
    if (parentId && wouldCreateCycle(marketId, parentId, markets)) {
      return fail(
        new ClassifiedError(
          "conflict",
          "That parent is the market itself or one of its descendants."
        )
      );
    }
    await sql.begin(async (tx) => {
      await tx`update markets set parent_id = ${parentId} where id = ${marketId}`;
      await writeAudit(tx, {
        userId: user.id,
        action: "market.set_parent",
        entity: "market",
        entityId: marketId,
        detail: { parentId },
      });
    });
    return ok({ marketId });
  } catch (err) {
    return fail(err);
  }
}

export async function createAgreement(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ agreementId: string }>> {
  const parsed = agreementSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await assertProjectAccess(user, input.projectId);
    const agreementId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into exclusivity_agreements
          (project_id, starts_on, ends_on, grace_period_days, notes, status,
           created_by)
        values (${input.projectId}, ${input.startsOn}, ${input.endsOn ?? null},
          ${input.gracePeriodDays}, ${input.notes ?? null}, ${input.status},
          ${user.id})
        returning id
      `;
      const id = row?.id as string;
      for (const scope of input.scopes) {
        await tx`
          insert into exclusivity_scopes
            (agreement_id, market_id, service_category, segment, notes)
          values (${id}, ${scope.marketId}, ${scope.serviceCategory ?? null},
            ${scope.segment ?? null}, ${scope.notes ?? null})
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "exclusivity.agreement_create",
        entity: "exclusivity_agreement",
        entityId: id,
        detail: { projectId: input.projectId, scopes: input.scopes.length },
      });
      return id;
    });
    return ok({ agreementId });
  } catch (err) {
    return fail(err);
  }
}

export async function terminateAgreement(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ agreementId: string }>> {
  const parsed = z
    .object({ agreementId: z.string().uuid(), terminatedAt: dateSchema })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { agreementId, terminatedAt } = parsed.data;
  try {
    // Ending a contractual protection is an owner decision, not an
    // operator convenience.
    assertRole(user, "admin");
    await sql.begin(async (tx) => {
      const [row] = await tx`
        select status from exclusivity_agreements
        where id = ${agreementId} for update
      `;
      if (!row) throw new ClassifiedError("not_found", "Agreement not found.");
      if (row.status === "terminated") {
        throw new ClassifiedError("conflict", "Agreement is already terminated.");
      }
      await tx`
        update exclusivity_agreements
        set status = 'terminated', terminated_at = ${terminatedAt}, updated_at = now()
        where id = ${agreementId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "exclusivity.agreement_terminate",
        entity: "exclusivity_agreement",
        entityId: agreementId,
        detail: { terminatedAt },
      });
    });
    return ok({ agreementId });
  } catch (err) {
    return fail(err);
  }
}

export interface AgreementRow {
  id: string;
  projectId: string;
  clientName: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
  gracePeriodDays: number;
  terminatedAt: string | null;
  notes: string | null;
  scopes: {
    id: string;
    marketId: string;
    marketName: string;
    serviceCategory: string | null;
    segment: string | null;
  }[];
}

/** A reserved hold becomes a signed agreement (spec 052). Audited. */
export async function activateAgreement(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ agreementId: string }>> {
  const parsed = z.object({ agreementId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid agreement id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        select status, project_id from exclusivity_agreements
        where id = ${parsed.data.agreementId} for update
      `;
      if (!row) throw new ClassifiedError("not_found", "Agreement not found.");
      if (row.status !== "reserved") {
        throw new ClassifiedError(
          "conflict",
          `Only a reserved agreement can be activated (this one is ${row.status}).`
        );
      }
      await tx`
        update exclusivity_agreements set status = 'active', updated_at = now()
        where id = ${parsed.data.agreementId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "exclusivity.agreement_activated",
        entity: "exclusivity_agreement",
        entityId: parsed.data.agreementId,
        detail: {},
      });
    });
    return ok({ agreementId: parsed.data.agreementId });
  } catch (err) {
    return fail(err);
  }
}

export async function listAgreements(): Promise<AgreementRow[]> {
  const rows = await sql`
    select a.id, a.project_id, p.name as client_name, a.status,
      a.starts_on::text, a.ends_on::text, a.grace_period_days,
      a.terminated_at::text, a.notes,
      coalesce(
        (select jsonb_agg(jsonb_build_object(
            'id', s.id, 'marketId', s.market_id, 'marketName', m.name,
            'serviceCategory', s.service_category, 'segment', s.segment)
          order by m.name)
         from exclusivity_scopes s join markets m on m.id = s.market_id
         where s.agreement_id = a.id),
        '[]'::jsonb) as scopes
    from exclusivity_agreements a
    join projects p on p.id = a.project_id
    order by a.created_at desc
  `;
  return rows as unknown as AgreementRow[];
}

async function loadAgreementInputs(): Promise<AgreementInput[]> {
  const rows = await listAgreements();
  return rows.map((row) => ({
    agreementId: row.id,
    projectId: row.projectId,
    clientName: row.clientName,
    status: row.status as "active" | "reserved" | "terminated",
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    gracePeriodDays: Number(row.gracePeriodDays),
    terminatedAt: row.terminatedAt,
    scopes: row.scopes.map((s) => ({
      scopeId: s.id,
      marketId: s.marketId,
      serviceCategory: s.serviceCategory,
      segment: s.segment,
    })),
  }));
}

export interface CheckOutcome {
  checkId: string;
  decision: "blocked" | "override" | "clear";
  result: DetectionResult;
}

export async function checkProspect(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<CheckOutcome>> {
  const parsed = checkSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const markets = await sql<MarketNode[]>`select id, name, parent_id from markets`;
    if (!markets.some((m) => m.id === input.marketId)) {
      // Refusing beats silently reporting clear on an unknown geography.
      return fail(
        new ClassifiedError(
          "validation",
          "That market is not in the tree yet — add it first, then check."
        )
      );
    }
    const agreements = await loadAgreementInputs();
    const today = new Date().toISOString().slice(0, 10);
    const result = detectConflicts(
      {
        marketId: input.marketId,
        serviceCategory: input.serviceCategory ?? null,
        segment: input.segment ?? null,
      },
      agreements,
      markets,
      today
    );

    let decision: CheckOutcome["decision"];
    if (result.worstVerdict === "clear") {
      decision = "clear";
    } else if (input.decision === "override") {
      // Signing past a detected conflict is an owner decision with a
      // written reason — the rationale is the evidence.
      assertRole(user, "admin");
      if (!input.overrideRationale?.trim()) {
        return fail(
          new ClassifiedError("validation", "An override requires a rationale.")
        );
      }
      decision = "override";
    } else {
      decision = "blocked";
    }

    const checkId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into exclusivity_checks
          (prospect_name, market_id, service_category, segment, result,
           worst_verdict, decision, override_rationale, checked_by)
        values (${input.prospectName}, ${input.marketId},
          ${input.serviceCategory ?? null}, ${input.segment ?? null},
          ${sql.json(result as never)}, ${result.worstVerdict}, ${decision},
          ${decision === "override" ? (input.overrideRationale ?? null) : null},
          ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "exclusivity.check",
        entity: "exclusivity_check",
        entityId: row?.id as string,
        detail: {
          prospect: input.prospectName,
          worstVerdict: result.worstVerdict,
          decision,
        },
      });
      return row?.id as string;
    });
    return ok({ checkId, decision, result });
  } catch (err) {
    return fail(err);
  }
}

export interface CheckRow {
  id: string;
  prospectName: string;
  marketName: string;
  serviceCategory: string | null;
  segment: string | null;
  worstVerdict: string;
  decision: string;
  overrideRationale: string | null;
  checkedAt: Date;
  conflictCount: number;
}

export async function listChecks(limit = 30): Promise<CheckRow[]> {
  return sql<CheckRow[]>`
    select c.id, c.prospect_name, m.name as market_name, c.service_category,
      c.segment, c.worst_verdict, c.decision, c.override_rationale,
      c.checked_at, jsonb_array_length(c.result->'conflicts') as conflict_count
    from exclusivity_checks c join markets m on m.id = c.market_id
    order by c.checked_at desc
    limit ${limit}
  `;
}
