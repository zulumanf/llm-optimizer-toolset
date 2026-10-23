/**
 * Unit economics from MEASURED rows only (spec 151 C5). Every figure carries
 * its source:
 *   measured     — summed from capture/LLM ledgers RF writes itself
 *   ledger       — from the manual billing ledger or the labor ledger
 *   not_recorded — RF has no data for it (infrastructure bills, third-party
 *                  subscriptions, labor rate); shown as missing, never zero
 *
 * Labor is costed only when the caller passes an hourly rate, and the rate
 * is echoed back as an assumption. Contribution margin is not EBITDA.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, assertProjectAccess, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";

export const LABOR_ACTIVITIES = [
  "onboarding",
  "report_review",
  "manual_intervention",
  "support",
  "client_communication",
  "optimization",
  "measurement_review",
  "sales_prospecting",
  "sales_call",
  "operations",
  "other",
] as const;
export const SALES_ACTIVITIES: readonly string[] = ["sales_prospecting", "sales_call"];

const laborSchema = z.object({
  projectId: z.string().uuid().optional(),
  engagementId: z.string().uuid().optional(),
  activity: z.enum(LABOR_ACTIVITIES),
  minutes: z.number().int().refine((m) => m !== 0 && Math.abs(m) <= 1440, "Minutes must be non-zero and at most a day."),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(500).optional(),
  corrects: z.string().uuid().optional(),
});

export async function recordLabor(user: CurrentUser, raw: unknown): Promise<ActionResult<{ entryId: string }>> {
  const parsed = laborSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  if (input.minutes < 0 && !input.corrects) {
    return fail(new ClassifiedError("validation", "A negative entry must name the entry it corrects."));
  }
  try {
    assertCanWrite(user);
    const [row] = await sql`
      insert into labor_entries (project_id, engagement_id, activity, minutes, occurred_on, note, corrects, recorded_by)
      values (${input.projectId ?? null}, ${input.engagementId ?? null}, ${input.activity}, ${input.minutes},
        ${input.occurredOn}, ${input.note ?? null}, ${input.corrects ?? null}, ${user.id})
      returning id
    `;
    return ok({ entryId: row!.id as string });
  } catch (err) {
    return fail(err);
  }
}

const outcomeSchema = z
  .object({
    projectId: z.string().uuid(),
    engagementId: z.string().uuid().optional(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    provenance: z.enum(["self_reported", "client_system_export"]),
    qualifiedLeads: z.number().int().min(0).optional(),
    leadsBySource: z.record(z.string().min(1).max(60), z.number().int().min(0)).default({}),
    aiDiscoveryMentions: z.number().int().min(0).optional(),
    aiReferralSessions: z.number().int().min(0).optional(),
    closedTransactions: z.number().int().min(0).optional(),
    notes: z.string().trim().max(1000).optional(),
    supersedes: z.string().uuid().optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, "The period ends before it starts.")
  .refine(
    (v) =>
      v.qualifiedLeads !== undefined ||
      Object.keys(v.leadsBySource).length > 0 ||
      v.aiDiscoveryMentions !== undefined ||
      v.aiReferralSessions !== undefined ||
      v.closedTransactions !== undefined,
    "Record at least one figure — an empty outcome is not a zero."
  );

/** Record a client-supplied outcome. Never inferred, never defaulted. */
export async function recordClientOutcome(user: CurrentUser, raw: unknown): Promise<ActionResult<{ outcomeId: string }>> {
  const parsed = outcomeSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const v = parsed.data;
  try {
    assertCanWrite(user);
    const id = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into client_outcomes (project_id, engagement_id, period_start, period_end, provenance, qualified_leads,
          leads_by_source, ai_discovery_mentions, ai_referral_sessions, closed_transactions, notes, supersedes, recorded_by)
        values (${v.projectId}, ${v.engagementId ?? null}, ${v.periodStart}, ${v.periodEnd}, ${v.provenance},
          ${v.qualifiedLeads ?? null}, ${tx.json(v.leadsBySource)}, ${v.aiDiscoveryMentions ?? null},
          ${v.aiReferralSessions ?? null}, ${v.closedTransactions ?? null}, ${v.notes ?? null}, ${v.supersedes ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "outcome.recorded",
        entity: "client_outcome",
        entityId: row!.id as string,
        projectId: v.projectId,
        detail: { provenance: v.provenance, periodStart: v.periodStart, periodEnd: v.periodEnd },
      });
      return row!.id as string;
    });
    return ok({ outcomeId: id });
  } catch (err) {
    return fail(err);
  }
}

export interface OutcomeRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  provenance: "self_reported" | "client_system_export";
  qualifiedLeads: number | null;
  leadsBySource: Record<string, number>;
  aiDiscoveryMentions: number | null;
  aiReferralSessions: number | null;
  closedTransactions: number | null;
  notes: string | null;
}

/** Current outcomes per project (superseded rows hidden, never deleted). */
export async function listClientOutcomes(user: CurrentUser, projectId: string): Promise<OutcomeRow[]> {
  await assertProjectAccess(user, projectId);
  return sql<OutcomeRow[]>`
    select id, period_start::text, period_end::text, provenance, qualified_leads, leads_by_source,
      ai_discovery_mentions, ai_referral_sessions, closed_transactions, notes
    from client_outcomes o
    where project_id = ${projectId}
      and not exists (select 1 from client_outcomes n where n.supersedes = o.id)
    order by period_start desc
  `;
}

export type Sourced<T> = { value: T; source: "measured" | "ledger" | "not_recorded" };

export interface ProjectEconomics {
  projectId: string | null;
  projectName: string;
  /** client = delivery cost; prospect/sentinel/internal = acquisition or platform cost. */
  kind: string;
  measurementCostUsd: Sourced<number>;
  internalInferenceCostUsd: Sourced<number>;
  thirdPartyCostUsd: Sourced<number | null>;
  failedCells: number;
  totalCells: number;
  laborMinutesByActivity: Record<string, number>;
  deliveryHours: Sourced<number>;
  salesHours: Sourced<number>;
  revenueUsd: Sourced<number>;
  laborCostUsd: Sourced<number | null>;
  contributionMarginUsd: Sourced<number | null>;
}

export interface EconomicsReport {
  from: string;
  to: string;
  months: number;
  assumedHourlyRateUsd: number | null;
  projects: ProjectEconomics[];
  unattributedInferenceCostUsd: Sourced<number>;
  failedJobs: number;
  totalJobs: number;
  infrastructureCostUsd: Sourced<null>;
  notes: string[];
}

const range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  projectId: z.string().uuid().optional(),
  assumedHourlyRateUsd: z.number().positive().optional(),
});

/** Staff-only: crosses clients. */
export async function unitEconomics(user: CurrentUser, raw: unknown): Promise<EconomicsReport> {
  assertCanWrite(user);
  const input = range.parse(raw);
  const months = Math.max(1 / 30, (new Date(input.to).getTime() - new Date(input.from).getTime()) / (30.44 * 86400000));
  const pid = input.projectId ?? null;

  const capture = await sql`
    select p.id, p.name, p.kind,
      coalesce(sum(r.cost_usd), 0)::float8 as cost,
      count(r.id)::int as cells,
      count(r.id) filter (where r.error is not null)::int as failed
    from projects p
    left join runs run on run.project_id = p.id
    left join responses r on r.run_id = run.id
      and r.requested_at >= ${input.from}::date and r.requested_at < ${input.to}::date + 1
    where (${pid}::uuid is null or p.id = ${pid}) and p.archived_at is null
    group by p.id, p.name, p.kind
  `;
  const llm = await sql`
    select project_id, coalesce(sum(cost_micro_usd), 0)::float8 / 1e6 as cost
    from llm_calls where called_at >= ${input.from}::date and called_at < ${input.to}::date + 1
    group by project_id
  `;
  const labor = await sql`
    select project_id, activity, sum(minutes)::int as minutes
    from labor_entries where occurred_on between ${input.from}::date and ${input.to}::date
    group by project_id, activity
  `;
  const revenue = await sql`
    select project_id, coalesce(sum(amount_cents), 0)::float8 / 100 as usd
    from billing_events where kind = 'payment_received'
      and occurred_at >= ${input.from}::date and occurred_at < ${input.to}::date + 1
    group by project_id
  `;
  const [jobsRow] = await sql`
    select count(*)::int as total, count(*) filter (where status = 'failed')::int as failed
    from jobs where created_at >= ${input.from}::date and created_at < ${input.to}::date + 1
  `;

  const rate = input.assumedHourlyRateUsd ?? null;
  const projects: ProjectEconomics[] = capture.map((c) => {
    const id = c.id as string;
    const minutes: Record<string, number> = {};
    for (const l of labor.filter((x) => x.projectId === id)) minutes[l.activity as string] = l.minutes as number;
    const deliveryMinutes = Object.entries(minutes).filter(([a]) => !SALES_ACTIVITIES.includes(a)).reduce((s, [, m]) => s + m, 0);
    const salesMinutes = Object.entries(minutes).filter(([a]) => SALES_ACTIVITIES.includes(a)).reduce((s, [, m]) => s + m, 0);
    const measurement = Number(c.cost);
    const internal = Number(llm.find((x) => x.projectId === id)?.cost ?? 0);
    const rev = Number(revenue.find((x) => x.projectId === id)?.usd ?? 0);
    const laborCost = rate === null ? null : (deliveryMinutes / 60) * rate;
    return {
      projectId: id,
      projectName: c.name as string,
      kind: c.kind as string,
      measurementCostUsd: { value: measurement, source: "measured" },
      internalInferenceCostUsd: { value: internal, source: "measured" },
      thirdPartyCostUsd: { value: null, source: "not_recorded" },
      failedCells: c.failed as number,
      totalCells: c.cells as number,
      laborMinutesByActivity: minutes,
      deliveryHours: { value: deliveryMinutes / 60, source: "ledger" },
      salesHours: { value: salesMinutes / 60, source: "ledger" },
      revenueUsd: { value: rev, source: "ledger" },
      laborCostUsd: { value: laborCost, source: rate === null ? "not_recorded" : "ledger" },
      contributionMarginUsd: {
        value: laborCost === null ? null : rev - measurement - internal - laborCost,
        source: laborCost === null ? "not_recorded" : "ledger",
      },
    };
  });
  return {
    from: input.from,
    to: input.to,
    months,
    assumedHourlyRateUsd: rate,
    projects,
    unattributedInferenceCostUsd: { value: Number(llm.find((x) => x.projectId === null)?.cost ?? 0), source: "measured" },
    failedJobs: (jobsRow?.failed as number) ?? 0,
    totalJobs: (jobsRow?.total as number) ?? 0,
    infrastructureCostUsd: { value: null, source: "not_recorded" },
    notes: [
      "Hosting, database, email, TTS and other subscriptions are not recorded in the platform; enter them from invoices.",
      "Third-party API costs outside the LLM ledgers (search, contact discovery) are not recorded.",
      "Contribution margin = revenue − measured inference − costed delivery labor. It is not gross margin after infrastructure and it is not EBITDA.",
      "Shared captures are charged once, to the project that paid for the original call.",
    ],
  };
}
