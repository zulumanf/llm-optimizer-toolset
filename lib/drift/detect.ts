/**
 * Fleet drift detection (spec 053, `drift-detector-v1`). Deterministic —
 * no model anywhere near it. Three detectors share one insert path with an
 * open-signal dedupe, so the cron heartbeat can run this every tick and
 * the operator sees each fingerprint once until they acknowledge it.
 *
 * The design rule: a provider change across N clients is ONE signal that
 * names all N, never N client-specific insights (audit measurement §8).
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany } from "@/db/companies";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { log } from "@/lib/logger";

export const DRIFT_DETECTOR_VERSION = "drift-detector-v1";
/** A rate move this large on one project is "moved" for fleet grouping. */
export const FLEET_DELTA = 0.1;
/** A fleet signal needs at least this many projects moving together… */
export const FLEET_MIN_PROJECTS = 3;
/** …and at least this share of the projects that could be measured. */
export const FLEET_MIN_SHARE = 0.5;
/** On a sentinel, any comparable-pair move this large is the anomaly. */
export const SENTINEL_DELTA = 0.1;
export const DRIFT_METRICS = ["mention_rate", "recommendation_rate"] as const;

export interface ProjectDelta {
  projectId: string;
  projectName: string;
  provider: string;
  metric: string;
  delta: number;
}

export interface FleetSignal {
  provider: string;
  metric: string;
  direction: "up" | "down";
  magnitude: number;
  affected: { projectId: string; projectName: string; delta: number }[];
  share: number;
}

/**
 * Pure grouping math: which (provider, metric) pairs moved the same
 * direction across enough of the measurable fleet. `measurableProjects` is
 * the number of projects that HAD a comparable pair — the honest
 * denominator; projects without one are unknown, not stable.
 */
export function groupFleetMovements(
  deltas: ProjectDelta[],
  measurableProjects: number
): FleetSignal[] {
  if (measurableProjects === 0) return [];
  const buckets = new Map<string, ProjectDelta[]>();
  for (const row of deltas) {
    if (Math.abs(row.delta) < FLEET_DELTA) continue;
    const direction = row.delta > 0 ? "up" : "down";
    const key = `${row.provider}|${row.metric}|${direction}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }
  const signals: FleetSignal[] = [];
  for (const [key, rows] of buckets) {
    const distinct = new Map(rows.map((r) => [r.projectId, r]));
    const count = distinct.size;
    const share = count / measurableProjects;
    if (count < FLEET_MIN_PROJECTS || share < FLEET_MIN_SHARE) continue;
    const [provider, metric, direction] = key.split("|") as [string, string, "up" | "down"];
    const affected = [...distinct.values()].map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      delta: Number(r.delta.toFixed(4)),
    }));
    signals.push({
      provider,
      metric,
      direction,
      magnitude: Number(
        (
          affected.reduce((a, r) => a + Math.abs(r.delta), 0) / affected.length
        ).toFixed(4)
      ),
      affected,
      share: Number(share.toFixed(3)),
    });
  }
  return signals.sort((a, b) => b.share - a.share);
}

/**
 * The subject's per-provider metric deltas between a project's latest
 * scored run and its most recent COMPARABLE prior — same frozen prompt-set
 * version and scoring version, the movement.ts comparability rule. Returns
 * null when no comparable pair exists (unknown, not stable).
 */
async function projectDeltas(
  projectId: string,
  projectName: string
): Promise<ProjectDelta[] | null> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) return null;
  const [latest] = await sql`
    select r.id, r.prompt_set_version_id,
      (select s.scoring_version from scores s where s.run_id = r.id limit 1)
        as scoring_version
    from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s
        where s.run_id = r.id and s.company_id = ${subject.id})
    order by r.started_at desc limit 1
  `;
  if (!latest) return null;
  const [prior] = await sql`
    select r.id from runs r
    where r.project_id = ${projectId}
      and r.id != ${latest.id}
      and r.prompt_set_version_id = ${latest.promptSetVersionId}
      and exists (select 1 from scores s
        where s.run_id = r.id and s.company_id = ${subject.id}
          and s.scoring_version = ${latest.scoringVersion})
    order by r.started_at desc limit 1
  `;
  if (!prior) return null;

  const rows = await sql`
    select run_id, provider, metric, value from scores
    where run_id in (${latest.id}, ${prior.id})
      and company_id = ${subject.id}
      and scoring_version = ${latest.scoringVersion}
      and provider != 'all'
      and metric = any(${[...DRIFT_METRICS]})
  `;
  const byKey = new Map<string, { latest?: number; prior?: number }>();
  for (const row of rows) {
    const key = `${row.provider}|${row.metric}`;
    if (!byKey.has(key)) byKey.set(key, {});
    const slot = byKey.get(key)!;
    if (row.runId === latest.id) slot.latest = Number(row.value);
    else slot.prior = Number(row.value);
  }
  const deltas: ProjectDelta[] = [];
  for (const [key, pair] of byKey) {
    if (pair.latest === undefined || pair.prior === undefined) continue;
    const [provider, metric] = key.split("|") as [string, string];
    deltas.push({
      projectId,
      projectName,
      provider,
      metric,
      delta: pair.latest - pair.prior,
    });
  }
  return deltas;
}

async function insertSignal(signal: {
  kind: "fleet_movement" | "provider_shape" | "sentinel_deviation";
  provider: string;
  metric?: string | null;
  direction?: "up" | "down" | null;
  magnitude?: number | null;
  affected?: unknown[];
  summary: string;
  detail?: Record<string, unknown>;
}): Promise<boolean> {
  const rows = await sql`
    insert into drift_signals
      (kind, provider, metric, direction, magnitude, affected, summary,
       detail, detector_version)
    values
      (${signal.kind}, ${signal.provider}, ${signal.metric ?? null},
       ${signal.direction ?? null}, ${signal.magnitude ?? null},
       ${sql.json((signal.affected ?? []) as never)}, ${signal.summary},
       ${sql.json((signal.detail ?? {}) as never)}, ${DRIFT_DETECTOR_VERSION})
    on conflict do nothing
    returning id
  `;
  const created = rows.length > 0;
  if (created) {
    log("warn", "drift.signal_opened", {
      kind: signal.kind,
      provider: signal.provider,
      metric: signal.metric ?? null,
      summary: signal.summary.slice(0, 160),
    });
  }
  return created;
}

export interface DriftDetectionResult {
  fleetSignals: number;
  shapeSignals: number;
  sentinelSignals: number;
  measurableProjects: number;
}

/** All three detectors. Safe on any cadence — open signals dedupe. */
export async function detectDriftSignals(): Promise<DriftDetectionResult> {
  const result: DriftDetectionResult = {
    fleetSignals: 0,
    shapeSignals: 0,
    sentinelSignals: 0,
    measurableProjects: 0,
  };

  // 1. Fleet movement across active client projects.
  const clients = await sql`
    select id, name from projects where status = 'active' and kind = 'client'
  `;
  const allDeltas: ProjectDelta[] = [];
  for (const project of clients) {
    const deltas = await projectDeltas(project.id as string, project.name as string);
    if (deltas === null) continue;
    result.measurableProjects += 1;
    allDeltas.push(...deltas);
  }
  for (const signal of groupFleetMovements(allDeltas, result.measurableProjects)) {
    const created = await insertSignal({
      kind: "fleet_movement",
      provider: signal.provider,
      metric: signal.metric,
      direction: signal.direction,
      magnitude: signal.magnitude,
      affected: signal.affected,
      summary:
        `${signal.affected.length} of ${result.measurableProjects} measurable clients moved ` +
        `${signal.direction} together on ${signal.provider} ${signal.metric.replace(/_/g, " ")} ` +
        `(mean |Δ| ${(signal.magnitude * 100).toFixed(0)} pts). Provider-level change is the ` +
        `likely cause — investigate before any client-facing narrative uses these deltas.`,
      detail: { share: signal.share },
    });
    if (created) result.fleetSignals += 1;
  }

  // 2. Provider shape drift — persisted flags, trailing week.
  const shapes = await sql`
    select provider, count(*)::int as n from responses
    where shape_recognized = false
      and requested_at > now() - interval '7 days'
    group by provider
  `;
  for (const row of shapes) {
    const created = await insertSignal({
      kind: "provider_shape",
      provider: row.provider as string,
      summary:
        `${row.n} capture(s) from ${row.provider} in the last 7 days had an unrecognized ` +
        `payload shape — the provider likely changed its format. Answers may be reading as ` +
        `empty; verify the adapter before trusting new measurements.`,
      detail: { count: Number(row.n) },
    });
    if (created) result.shapeSignals += 1;
  }

  // 3. Sentinel deviation — on a sentinel, movement IS the anomaly.
  const sentinels = await sql`
    select id, name from projects where status = 'active' and kind = 'sentinel'
  `;
  for (const project of sentinels) {
    const deltas = await projectDeltas(project.id as string, project.name as string);
    if (!deltas) continue;
    for (const delta of deltas) {
      if (Math.abs(delta.delta) < SENTINEL_DELTA) continue;
      const created = await insertSignal({
        kind: "sentinel_deviation",
        provider: delta.provider,
        metric: delta.metric,
        direction: delta.delta > 0 ? "up" : "down",
        magnitude: Number(Math.abs(delta.delta).toFixed(4)),
        affected: [
          {
            projectId: delta.projectId,
            projectName: delta.projectName,
            delta: Number(delta.delta.toFixed(4)),
          },
        ],
        summary:
          `Sentinel "${delta.projectName}" moved ${(Math.abs(delta.delta) * 100).toFixed(0)} pts ` +
          `on ${delta.provider} ${delta.metric.replace(/_/g, " ")} — sentinels measure stable ` +
          `entities, so this is instrument movement, not market movement.`,
      });
      if (created) result.sentinelSignals += 1;
    }
  }

  return result;
}

export interface DriftSignalRow {
  id: string;
  kind: string;
  provider: string;
  metric: string | null;
  direction: string | null;
  magnitude: number | null;
  affected: { projectId: string; projectName: string; delta: number }[];
  summary: string;
  status: string;
  detectedAt: Date;
}

export async function listDriftSignals(
  status: "open" | "acknowledged" | "all" = "open"
): Promise<DriftSignalRow[]> {
  const rows = await sql`
    select id, kind, provider, metric, direction, magnitude, affected,
      summary, status, detected_at
    from drift_signals
    where ${status === "all" ? sql`true` : sql`status = ${status}`}
    order by detected_at desc
    limit 100
  `;
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    provider: r.provider as string,
    metric: (r.metric as string | null) ?? null,
    direction: (r.direction as string | null) ?? null,
    magnitude: r.magnitude === null ? null : Number(r.magnitude),
    affected: (r.affected as DriftSignalRow["affected"]) ?? [],
    summary: r.summary as string,
    status: r.status as string,
    detectedAt: r.detectedAt as Date,
  }));
}

/** The operator saw it and decided — recorded, and detection re-arms. */
export async function acknowledgeDriftSignal(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ signalId: string }>> {
  const { z } = await import("zod");
  const parsed = z
    .object({ signalId: z.string().uuid(), note: z.string().trim().max(500).optional() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid signal id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update drift_signals
        set status = 'acknowledged', acknowledged_by = ${user.id},
          acknowledged_at = now(), acknowledged_note = ${parsed.data.note ?? null}
        where id = ${parsed.data.signalId} and status = 'open'
        returning id
      `;
      if (!row) {
        throw new ClassifiedError("not_found", "Signal not found or already acknowledged.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "drift.signal_acknowledged",
        entity: "drift_signal",
        entityId: parsed.data.signalId,
        detail: { note: parsed.data.note ?? null },
      });
    });
    return ok({ signalId: parsed.data.signalId });
  } catch (err) {
    return fail(err);
  }
}
