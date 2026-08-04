/**
 * Threshold trigger evaluation. Deterministic by construction — no LLM, no
 * heuristic, no "looks like a decline".
 *
 * Two rules make a threshold trigger trustworthy:
 *
 *  1. **Minimum sample.** Below it, the trigger does not fire and records
 *     `insufficient_sample`. An alert computed from four observations is
 *     noise wearing an alert's clothes.
 *  2. **Transition, not state.** A metric that sits past its threshold fires
 *     once, on the crossing, not on every evaluation. Re-arming happens when
 *     it crosses back.
 */
import { sql } from "@/db/client";
import type { ThresholdComparison } from "@/lib/triggers/types";

export interface MetricSample {
  value: number;
  sampleSize: number;
  /** What the number is made of, so an alert can be explained, not just shown. */
  detail: Record<string, unknown>;
}

export type MetricResolver = (args: {
  projectId: string | null;
  lookbackDays: number;
}) => Promise<MetricSample | null>;

/**
 * The metric catalogue. Every key is a named, versioned calculation over
 * durable rows. Adding a key means adding a resolver — there is no generic
 * "run this SQL" escape hatch, deliberately.
 */
const RESOLVERS: Record<string, MetricResolver> = {
  /**
   * Share of the window's responses that recommended the client's own brand.
   * Denominator is responses observed, not mentions found — a rate whose
   * denominator is the hits is not a rate.
   */
  recommendation_rate: async ({ projectId, lookbackDays }) => {
    // "The client's own brand" is the PROJECT's subject company, with the
    // legacy global is_self company only as fallback — the same resolution
    // getSubjectCompany() uses. Filtering on bare `c.is_self` measured one
    // global brand for every project (cleanup audit 2026-08-04, D).
    const [row] = await sql`
      select
        count(distinct r.id)::int as total,
        count(distinct r.id) filter (
          where m.recommended and m.company_id = coalesce(
            (select p.subject_company_id from projects p where p.id = run.project_id),
            (select id from companies where is_self and archived_at is null limit 1)
          )
        )::int as hits
      from responses r
      join runs run on run.id = r.run_id
      left join mentions m on m.response_id = r.id
      where run.project_id = ${projectId}
        and r.requested_at > now() - make_interval(days => ${lookbackDays})
    `;
    const total = Number(row?.total ?? 0);
    if (total === 0) return null;
    const hits = Number(row?.hits ?? 0);
    return {
      value: hits / total,
      sampleSize: total,
      detail: { numerator: hits, denominator: total, lookbackDays },
    };
  },

  /**
   * Approved claims due for review inside the window. `review_date` is the
   * freshness contract a claim carries (migration 018); a claim past it is no
   * longer evidence we are willing to publish on.
   */
  claims_expiring_soon: async ({ projectId, lookbackDays }) => {
    const [row] = await sql`
      select count(*)::int as n from claims
      where project_id = ${projectId}
        and status = 'approved'
        and review_date is not null
        and review_date <= (now() + make_interval(days => ${lookbackDays}))::date
    `;
    return {
      value: Number(row?.n ?? 0),
      sampleSize: Number(row?.n ?? 0),
      detail: { windowDays: lookbackDays },
    };
  },

  /** Approvals past their due date. Operational health, not measurement. */
  overdue_approvals: async ({ projectId }) => {
    const [row] = await sql`
      select count(*)::int as n from workflow_approvals
      where decision is null and due_at < now()
        and (${projectId}::uuid is null or project_id = ${projectId})
    `;
    return { value: Number(row?.n ?? 0), sampleSize: Number(row?.n ?? 0), detail: {} };
  },

  /** Consecutive connector failures — three in a row is a real outage. */
  connector_failure_streak: async ({ projectId, lookbackDays }) => {
    const [row] = await sql`
      select count(*)::int as n from connector_health_checks
      where (${projectId}::uuid is null or project_id = ${projectId})
        and checked_at > now() - make_interval(days => ${lookbackDays})
        and (authorization_ok = false or read_ok = false)
    `;
    return { value: Number(row?.n ?? 0), sampleSize: Number(row?.n ?? 0), detail: {} };
  },

  /** Spend on a client's workflow runs inside the window, in micro-USD. */
  workflow_cost_micro_usd: async ({ projectId, lookbackDays }) => {
    const [row] = await sql`
      select coalesce(sum(cost_micro_usd), 0)::bigint as total, count(*)::int as runs
      from workflow_runs
      where project_id = ${projectId}
        and started_at > now() - make_interval(days => ${lookbackDays})
    `;
    return {
      value: Number(row?.total ?? 0),
      sampleSize: Number(row?.runs ?? 0),
      detail: { lookbackDays },
    };
  },

  /** Open exceptions for a client — the operator's load signal. */
  open_exceptions: async ({ projectId }) => {
    const [row] = await sql`
      select count(*)::int as n from workflow_exceptions
      where status in ('open', 'acknowledged')
        and (${projectId}::uuid is null or project_id = ${projectId})
    `;
    return { value: Number(row?.n ?? 0), sampleSize: Number(row?.n ?? 0), detail: {} };
  },
};

export function knownMetricKeys(): string[] {
  return Object.keys(RESOLVERS).sort();
}

export function hasMetric(key: string): boolean {
  return key in RESOLVERS;
}

export function compare(
  value: number,
  comparison: ThresholdComparison,
  threshold: number
): boolean {
  switch (comparison) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    default: {
      const _exhaustive: never = comparison;
      void _exhaustive;
      return false;
    }
  }
}

export type ThresholdVerdict =
  | { outcome: "fire"; sample: MetricSample; breached: true }
  | { outcome: "no_change"; sample: MetricSample; breached: boolean }
  | { outcome: "rearmed"; sample: MetricSample; breached: false }
  | { outcome: "insufficient_sample"; sample: MetricSample | null; breached: boolean }
  | { outcome: "unknown_metric"; sample: null; breached: boolean };

/**
 * Evaluate one threshold trigger. Pure decision logic given a sample, so the
 * transition rules are unit-testable without a database.
 */
export function decideThreshold(args: {
  sample: MetricSample | null;
  comparison: ThresholdComparison;
  thresholdValue: number;
  minimumSample: number;
  previouslyBreached: boolean;
}): ThresholdVerdict {
  if (args.sample === null) {
    return { outcome: "insufficient_sample", sample: null, breached: args.previouslyBreached };
  }
  if (args.sample.sampleSize < args.minimumSample) {
    return {
      outcome: "insufficient_sample",
      sample: args.sample,
      breached: args.previouslyBreached,
    };
  }
  const breached = compare(args.sample.value, args.comparison, args.thresholdValue);
  if (breached && !args.previouslyBreached) {
    return { outcome: "fire", sample: args.sample, breached: true };
  }
  if (!breached && args.previouslyBreached) {
    return { outcome: "rearmed", sample: args.sample, breached: false };
  }
  return { outcome: "no_change", sample: args.sample, breached };
}

export async function resolveMetric(
  metricKey: string,
  args: { projectId: string | null; lookbackDays: number }
): Promise<MetricSample | null> {
  const resolver = RESOLVERS[metricKey];
  if (!resolver) return null;
  return resolver(args);
}
