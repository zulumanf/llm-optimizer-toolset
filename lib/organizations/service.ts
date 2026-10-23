/**
 * Brokerage organizations (spec 151 D1): a read-only portfolio view over
 * member entities' market-benchmark measurements.
 *
 * Access: staff see every organization; any other account sees exactly the
 * organizations it holds an un-revoked grant for (deny by default, and an
 * unknown or ungranted id reads as not-found so existence never leaks).
 * Data scope: only projects of kind 'prospect' bound to a market (shared
 * market benchmarks). A member's appearance inside some client's private
 * project is never read here. No licensed RealTrends field is selected.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, isStaff, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { SCORING_VERSION } from "@/lib/constants";

export class OrganizationAccessError extends ClassifiedError {
  constructor() {
    super("not_found", "Organization not found.");
    this.name = "OrganizationAccessError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function assertOrganizationAccess(user: CurrentUser, organizationId: string): Promise<void> {
  if (!UUID_RE.test(organizationId)) throw new OrganizationAccessError();
  if (isStaff(user)) {
    const [org] = await sql`select id from organizations where id = ${organizationId} and archived_at is null`;
    if (!org) throw new OrganizationAccessError();
    return;
  }
  const [grant] = await sql`
    select g.id from organization_grants g join organizations o on o.id = g.organization_id
    where g.organization_id = ${organizationId} and g.user_id = ${user.id}
      and g.revoked_at is null and o.archived_at is null
  `;
  if (!grant) throw new OrganizationAccessError();
}

export async function visibleOrganizations(user: CurrentUser): Promise<{ id: string; name: string; members: number }[]> {
  const rows = isStaff(user)
    ? await sql`
        select o.id, o.name, (select count(*)::int from organization_entities e where e.organization_id = o.id and e.removed_at is null) as members
        from organizations o where o.archived_at is null order by o.name
      `
    : await sql`
        select o.id, o.name, (select count(*)::int from organization_entities e where e.organization_id = o.id and e.removed_at is null) as members
        from organizations o join organization_grants g on g.organization_id = o.id
        where g.user_id = ${user.id} and g.revoked_at is null and o.archived_at is null order by o.name
      `;
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, members: r.members as number }));
}

const createSchema = z.object({ name: z.string().trim().min(2).max(200), companyId: z.string().uuid().optional() });

export async function createOrganization(user: CurrentUser, raw: unknown): Promise<ActionResult<{ organizationId: string }>> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into organizations (name, company_id, created_by) values (${parsed.data.name}, ${parsed.data.companyId ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, { userId: user.id, action: "organization.created", entity: "organization", entityId: row!.id as string, detail: { name: parsed.data.name } });
      return row!.id as string;
    });
    return ok({ organizationId: id });
  } catch (err) {
    return fail(err);
  }
}

const memberSchema = z.object({
  organizationId: z.string().uuid(),
  companyId: z.string().uuid(),
  level: z.enum(["individual", "team", "office"]),
});

export async function addOrganizationEntity(user: CurrentUser, raw: unknown): Promise<ActionResult<{ memberId: string }>> {
  const parsed = memberSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    // Server-side scope (review): only companies measured in a shared market
    // benchmark may join a roster — never a name that exists only inside a
    // client's private project.
    const [measured] = await sql`
      select 1 from score_estimates e join runs r on r.id = e.run_id join projects p on p.id = r.project_id
      where e.company_id = ${parsed.data.companyId} and p.kind = 'prospect' and p.market_id is not null
      limit 1
    `;
    if (!measured) {
      return fail(new ClassifiedError("validation", "Only agents and teams measured in a market benchmark can join a brokerage roster."));
    }
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into organization_entities (organization_id, company_id, level, added_by)
        values (${parsed.data.organizationId}, ${parsed.data.companyId}, ${parsed.data.level}, ${user.id})
        on conflict (organization_id, company_id) do update set removed_at = null, level = excluded.level
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "organization.entity_added",
        entity: "organization",
        entityId: parsed.data.organizationId,
        detail: { companyId: parsed.data.companyId, level: parsed.data.level },
      });
      return row!.id as string;
    });
    return ok({ memberId: id });
  } catch (err) {
    return fail(err);
  }
}

export async function grantOrganizationAccess(user: CurrentUser, raw: unknown): Promise<ActionResult<{ grantId: string }>> {
  const parsed = z.object({ organizationId: z.string().uuid(), userId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into organization_grants (organization_id, user_id, granted_by)
        values (${parsed.data.organizationId}, ${parsed.data.userId}, ${user.id})
        on conflict (organization_id, user_id) do update set revoked_at = null, granted_by = excluded.granted_by, granted_at = now()
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "organization.access_granted",
        entity: "organization",
        entityId: parsed.data.organizationId,
        detail: { granteeId: parsed.data.userId },
      });
      return row!.id as string;
    });
    return ok({ grantId: id });
  } catch (err) {
    return fail(err);
  }
}

export interface RosterMetric {
  model: string;
  provider: string;
  rate: number | null;
  low: number | null;
  high: number | null;
  numerator: number;
  denominator: number;
  prompts: number;
}

export interface RosterRow {
  companyId: string;
  name: string;
  level: string;
  market: string | null;
  measuredAt: Date | null;
  recommended: RosterMetric[];
  mentioned: RosterMetric[];
}

/** The read-only roster: each member's latest market-benchmark estimates. */
export async function organizationRoster(user: CurrentUser, organizationId: string): Promise<{ organization: string; rows: RosterRow[] }> {
  await assertOrganizationAccess(user, organizationId);
  const [org] = await sql`select name from organizations where id = ${organizationId}`;
  const members = await sql`
    select e.company_id, e.level, c.name from organization_entities e join companies c on c.id = e.company_id
    where e.organization_id = ${organizationId} and e.removed_at is null order by c.name
  `;
  const ids = members.map((m) => m.companyId as string);
  const estimates = ids.length
    ? await sql`
        with latest as (
          select distinct on (e.company_id) e.company_id, e.run_id, m.name as market, r.started_at
          from score_estimates e
          join runs r on r.id = e.run_id
          join projects p on p.id = r.project_id
          left join markets m on m.id = p.market_id
          where e.company_id = any(${ids}) and e.scoring_version = ${SCORING_VERSION}
            and p.kind = 'prospect' and p.market_id is not null and p.archived_at is null
            and r.status in ('completed', 'partial')
          order by e.company_id, r.started_at desc
        )
        select e.company_id, e.metric, e.provider, e.model, e.rate::float8 as rate,
          e.clustered_low::float8 as low, e.clustered_high::float8 as high,
          e.numerator, e.denominator, e.distinct_prompts, l.market, l.started_at
        from latest l join score_estimates e on e.run_id = l.run_id and e.company_id = l.company_id
        where e.scoring_version = ${SCORING_VERSION} and e.metric in ('recommendation_rate', 'mention_rate')
        order by e.company_id, e.metric, e.instrument_key
      `
    : [];
  return {
    organization: org?.name as string,
    rows: members.map((m) => {
      const own = estimates.filter((e) => e.companyId === m.companyId);
      const toMetric = (e: Record<string, unknown>): RosterMetric => ({
        model: e.model as string,
        provider: e.provider as string,
        rate: (e.rate as number | null) ?? null,
        low: (e.low as number | null) ?? null,
        high: (e.high as number | null) ?? null,
        numerator: e.numerator as number,
        denominator: e.denominator as number,
        prompts: e.distinctPrompts as number,
      });
      return {
        companyId: m.companyId as string,
        name: m.name as string,
        level: m.level as string,
        market: (own[0]?.market as string | null) ?? null,
        measuredAt: (own[0]?.startedAt as Date | null) ?? null,
        recommended: own.filter((e) => e.metric === "recommendation_rate").map(toMetric),
        mentioned: own.filter((e) => e.metric === "mention_rate").map(toMetric),
      };
    }),
  };
}

/** Staff form data: companies measured in market benchmarks, and client accounts. */
export async function organizationFormData(user: CurrentUser): Promise<{
  companies: { id: string; name: string }[];
  clientUsers: { id: string; email: string }[];
}> {
  assertCanWrite(user);
  const companies = await sql`
    select distinct c.id, c.name from score_estimates e
    join companies c on c.id = e.company_id
    join runs r on r.id = e.run_id join projects p on p.id = r.project_id
    where p.kind = 'prospect' and p.market_id is not null and c.archived_at is null
    order by c.name limit 2000
  `;
  const users = await sql`
    select id, email from users where role in ('client_viewer', 'client_validator') and active order by email
  `;
  return {
    companies: companies.map((c) => ({ id: c.id as string, name: c.name as string })),
    clientUsers: users.map((u) => ({ id: u.id as string, email: u.email as string })),
  };
}
