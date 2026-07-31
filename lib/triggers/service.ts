/**
 * Trigger registration and dispatch.
 *
 * `dispatchDueTriggers` is safe to call at any frequency and from any number of
 * processes. Its safety does not come from locking — it comes from `fire_key`
 * being the *window's* identity rather than the moment of firing, so two
 * dispatchers computing the same 09:00 slot both try to insert the same key and
 * exactly one wins.
 */
import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import * as store from "@/db/triggers";
import { fireKeyForSlot, nextOccurrence, occurrencesBetween, parseCron } from "@/lib/triggers/cron";
import { decideThreshold, hasMetric, resolveMetric } from "@/lib/triggers/threshold";
import { publishEvent } from "@/lib/events/bus";
import { eventDefinition } from "@/lib/events/catalog";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { raiseException } from "@/lib/workflow/exceptions";
import type {
  AutomationTrigger,
  CreateTriggerInput,
  FireOutcome,
} from "@/lib/triggers/types";

/** A schedule finer than this is refused: dispatch cannot honour it. */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 1;

/**
 * How far back a catch-up will look. A dispatcher that was down for a month
 * should not wake up and fire thirty daily reports; it should fire the current
 * window and say the rest were missed.
 */
export const MAX_CATCHUP_DAYS = 7;

export interface RegisterTriggerResult {
  triggerId: string;
  nextRunAt: Date | null;
}

/**
 * Register (or update) a trigger. Validation happens here rather than at fire
 * time so a broken schedule is a rejected write, not a silent no-op discovered
 * weeks later.
 */
export async function registerTrigger(
  input: CreateTriggerInput,
  now: Date = new Date()
): Promise<RegisterTriggerResult> {
  if (input.kind === "schedule") {
    if (!input.cron) {
      throw new ClassifiedError("validation", "A schedule trigger requires a cron expression.");
    }
    const fields = parseCron(input.cron);
    // Reject sub-minute intent explicitly. parseCron already refuses seconds,
    // but a step of 1 on the minute field is the finest we will dispatch.
    if (fields.minutes.length > 60 / MIN_SCHEDULE_INTERVAL_MINUTES) {
      throw new ClassifiedError(
        "validation",
        `Schedules finer than every ${MIN_SCHEDULE_INTERVAL_MINUTES} minute(s) are not supported.`
      );
    }
    const next = nextOccurrence(fields, input.startsAt ?? now, input.timezone ?? "UTC");
    if (!next) {
      throw new ClassifiedError(
        "validation",
        `Cron expression "${input.cron}" has no occurrence within the search horizon.`
      );
    }
    const triggerId = await sql.begin((tx) => store.upsertTrigger(tx, { ...input, nextRunAt: next }));
    return { triggerId, nextRunAt: next };
  }

  if (input.kind === "threshold") {
    if (!input.metricKey || !hasMetric(input.metricKey)) {
      throw new ClassifiedError(
        "validation",
        `Unknown threshold metric "${input.metricKey ?? ""}". Add a resolver in lib/triggers/threshold.ts first.`
      );
    }
    if (input.comparison === null || input.comparison === undefined) {
      throw new ClassifiedError("validation", "A threshold trigger requires a comparison.");
    }
    if (input.thresholdValue === null || input.thresholdValue === undefined) {
      throw new ClassifiedError("validation", "A threshold trigger requires a threshold value.");
    }
    // Evaluate on the same cadence as schedules; the transition rule stops it
    // from re-firing while the metric stays past the line.
    const cron = input.cron ?? "*/15 * * * *";
    const next = nextOccurrence(parseCron(cron), now, input.timezone ?? "UTC");
    const triggerId = await sql.begin((tx) =>
      store.upsertTrigger(tx, { ...input, cron, nextRunAt: next })
    );
    return { triggerId, nextRunAt: next };
  }

  if (input.kind === "webhook") {
    const eventType = String(input.config?.eventType ?? "");
    if (!eventDefinition(eventType)) {
      throw new ClassifiedError(
        "validation",
        `A webhook trigger must map to a known event type; "${eventType}" is not in the catalogue.`
      );
    }
  }

  const triggerId = await sql.begin((tx) => store.upsertTrigger(tx, { ...input, nextRunAt: null }));
  return { triggerId, nextRunAt: null };
}

// ----------------------------------------------------------------- dispatch

export interface DispatchSummary {
  evaluated: number;
  fired: number;
  skipped: number;
  failed: number;
  details: { triggerKey: string; fireKey: string; outcome: FireOutcome }[];
}

/**
 * The starter injected into dispatch. Injected rather than imported so this
 * module does not depend on the automation runtime — the runtime depends on
 * triggers, and a cycle would make both untestable.
 */
export type WorkflowStarter = (args: {
  workflowKey: string;
  projectId: string | null;
  idempotencyKey: string;
  input: Record<string, unknown>;
  trigger: "scheduled" | "signal" | "manual";
}) => Promise<string>;

/**
 * Clone a platform-scoped schedule template to one client, enabled
 * (roadmap 2.5). The 18 shipped workflows install their schedules disabled
 * at platform scope on purpose — firing a per-client process with no
 * client is meaningless — so until now enabling one meant hand-writing a
 * trigger. The clone keeps the template's cadence and config, gains the
 * project, and gets its own key so the template stays untouched as the
 * canonical default.
 */
export async function cloneTriggerForClient(input: {
  triggerId: string;
  projectId: string;
  createdBy?: string | null;
}): Promise<RegisterTriggerResult> {
  const [source] = await sql`
    select * from automation_triggers where id = ${input.triggerId}
  `;
  if (!source) throw new ClassifiedError("not_found", "Trigger not found.");
  if (source.projectId) {
    throw new ClassifiedError(
      "conflict",
      "Already client-scoped — clone from the platform template instead."
    );
  }
  if (source.kind !== "schedule") {
    throw new ClassifiedError(
      "validation",
      "Only schedule templates are cloned per client."
    );
  }
  const [project] = await sql`
    select name from projects where id = ${input.projectId} and status = 'active'
  `;
  if (!project) throw new ClassifiedError("not_found", "Active project not found.");

  const key = `${source.key as string}:${input.projectId}`;
  const [existing] = await sql`
    select id from automation_triggers where key = ${key}
  `;
  if (existing) {
    throw new ClassifiedError(
      "conflict",
      "This client already has a clone of that schedule — toggle it instead."
    );
  }

  const result = await registerTrigger({
    key,
    kind: "schedule",
    workflowKey: source.workflowKey as string,
    projectId: input.projectId,
    name: `${(source.name as string | null) ?? (source.key as string)} — ${project.name as string}`,
    description: (source.description as string | null) ?? undefined,
    enabled: true,
    config: (source.config as Record<string, unknown> | null) ?? undefined,
    cron: source.cron as string,
    timezone: (source.timezone as string | null) ?? undefined,
    missedRunPolicy:
      (source.missedRunPolicy as CreateTriggerInput["missedRunPolicy"]) ??
      undefined,
    createdBy: input.createdBy ?? null,
  });
  await sql.begin((tx) =>
    writeAudit(tx, {
      userId: input.createdBy ?? null,
      action: "trigger.clone_for_client",
      entity: "automation_trigger",
      entityId: result.triggerId,
      detail: { sourceTriggerId: input.triggerId, projectId: input.projectId },
    })
  );
  return result;
}

export async function dispatchDueTriggers(
  startWorkflow: WorkflowStarter,
  now: Date = new Date()
): Promise<DispatchSummary> {
  const due = await store.dueTriggers(now);
  const summary: DispatchSummary = {
    evaluated: due.length,
    fired: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  for (const trigger of due) {
    try {
      const outcomes =
        trigger.kind === "schedule"
          ? await dispatchSchedule(trigger, startWorkflow, now)
          : await dispatchThreshold(trigger, startWorkflow, now);
      for (const outcome of outcomes) {
        summary.details.push(outcome);
        if (outcome.outcome === "fired") summary.fired += 1;
        else if (outcome.outcome === "failed") summary.failed += 1;
        else summary.skipped += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failed += 1;
      summary.details.push({
        triggerKey: trigger.key,
        fireKey: fireKeyForSlot(now),
        outcome: "failed",
      });
      await sql.begin(async (tx) => {
        await store.claimFire(tx, {
          triggerId: trigger.id,
          fireKey: `error:${fireKeyForSlot(now)}`,
          outcome: "failed",
          detail: { error: message.slice(0, 500) },
        });
        await raiseException(tx, {
          projectId: trigger.projectId,
          kind: "failed_workflow",
          severity: "high",
          summary: `Trigger ${trigger.key} could not dispatch: ${message}`,
          recommendedAction: "Fix the trigger configuration or the target workflow, then re-enable.",
        });
      });
      log("error", "trigger.dispatch_failed", { key: trigger.key, message });
    }
  }

  log("info", "trigger.dispatch", {
    evaluated: summary.evaluated,
    fired: summary.fired,
    skipped: summary.skipped,
    failed: summary.failed,
  });
  return summary;
}

/**
 * Which windows a schedule owes, given how long the dispatcher has been away.
 * Pure, so the missed-run policies are unit-testable without a clock or a DB.
 */
export function plannedSlots(args: {
  cron: string;
  timezone: string;
  lastFiredAt: Date | null;
  startsAt: Date | null;
  now: Date;
  policy: AutomationTrigger["missedRunPolicy"];
}): { toFire: Date[]; toSkip: Date[] } {
  const fields = parseCron(args.cron);
  const horizon = new Date(args.now.getTime() - MAX_CATCHUP_DAYS * 86_400_000);
  const since = [args.lastFiredAt, args.startsAt, horizon]
    .filter((d): d is Date => d instanceof Date)
    .reduce((latest, candidate) => (candidate > latest ? candidate : latest), horizon);

  const missed = occurrencesBetween(fields, since, args.now, args.timezone);
  if (missed.length === 0) return { toFire: [], toSkip: [] };

  switch (args.policy) {
    case "run_all":
      return { toFire: missed, toSkip: [] };
    case "skip":
      // Only the newest window matters; earlier ones are not owed at all.
      return { toFire: missed.slice(-1), toSkip: missed.slice(0, -1) };
    case "run_once":
    default:
      // Fire the newest, and record the rest as deliberately skipped so the
      // gap is visible instead of silent.
      return { toFire: missed.slice(-1), toSkip: missed.slice(0, -1) };
  }
}

async function dispatchSchedule(
  trigger: AutomationTrigger,
  startWorkflow: WorkflowStarter,
  now: Date
): Promise<{ triggerKey: string; fireKey: string; outcome: FireOutcome }[]> {
  if (!trigger.cron) return [];
  const { toFire, toSkip } = plannedSlots({
    cron: trigger.cron,
    timezone: trigger.timezone,
    lastFiredAt: trigger.lastFiredAt,
    startsAt: trigger.startsAt,
    now,
    policy: trigger.missedRunPolicy,
  });

  const results: { triggerKey: string; fireKey: string; outcome: FireOutcome }[] = [];

  for (const slot of toSkip) {
    const fireKey = fireKeyForSlot(slot);
    const claimed = await sql.begin((tx) =>
      store.claimFire(tx, {
        triggerId: trigger.id,
        fireKey,
        outcome: "skipped_missed",
        detail: { policy: trigger.missedRunPolicy, reason: "dispatcher was not running for this window" },
      })
    );
    if (claimed) results.push({ triggerKey: trigger.key, fireKey, outcome: "skipped_missed" });
  }

  for (const slot of toFire) {
    const fireKey = fireKeyForSlot(slot);
    const claimed = await sql.begin((tx) =>
      store.claimFire(tx, { triggerId: trigger.id, fireKey, outcome: "fired" })
    );
    if (!claimed) {
      // Another dispatcher owns this window. Nothing to do, and nothing wrong.
      continue;
    }
    try {
      const runId = await startWorkflow({
        workflowKey: trigger.workflowKey,
        projectId: trigger.projectId,
        idempotencyKey: `trigger:${trigger.key}:${fireKey}`,
        input: {
          trigger: { key: trigger.key, kind: "schedule", slot: slot.toISOString() },
          ...(trigger.config ?? {}),
        },
        trigger: "scheduled",
      });
      await sql.begin((tx) =>
        store.attachFireResult(tx, {
          fireId: claimed.id,
          workflowRunId: runId,
          outcome: "fired",
          detail: { slot: slot.toISOString(), timezone: trigger.timezone },
        })
      );
      results.push({ triggerKey: trigger.key, fireKey, outcome: "fired" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sql.begin(async (tx) => {
        await store.attachFireResult(tx, {
          fireId: claimed.id,
          outcome: "failed",
          detail: { error: message.slice(0, 500) },
        });
        await raiseException(tx, {
          projectId: trigger.projectId,
          kind: "failed_workflow",
          severity: "high",
          summary: `Scheduled trigger ${trigger.key} could not start ${trigger.workflowKey}: ${message}`,
          recommendedAction: "Publish the workflow or fix its inputs, then retry the fire.",
        });
      });
      results.push({ triggerKey: trigger.key, fireKey, outcome: "failed" });
    }
  }

  const next = nextOccurrence(parseCron(trigger.cron), now, trigger.timezone);
  await sql.begin((tx) =>
    store.setNextRun(tx, {
      triggerId: trigger.id,
      nextRunAt: next,
      lastFireKey: toFire.length > 0 ? fireKeyForSlot(toFire[toFire.length - 1]!) : null,
      fired: toFire.length > 0,
    })
  );
  return results;
}

async function dispatchThreshold(
  trigger: AutomationTrigger,
  startWorkflow: WorkflowStarter,
  now: Date
): Promise<{ triggerKey: string; fireKey: string; outcome: FireOutcome }[]> {
  const fireKey = fireKeyForSlot(now);
  const sample = trigger.metricKey
    ? await resolveMetric(trigger.metricKey, {
        projectId: trigger.projectId,
        lookbackDays: trigger.lookbackDays ?? 7,
      })
    : null;

  const verdict = decideThreshold({
    sample,
    comparison: trigger.comparison ?? "gt",
    thresholdValue: trigger.thresholdValue ?? 0,
    minimumSample: trigger.minimumSample ?? 1,
    previouslyBreached: trigger.lastBreached,
  });

  const nextRunAt = trigger.cron
    ? nextOccurrence(parseCron(trigger.cron), now, trigger.timezone)
    : null;

  if (verdict.outcome !== "fire") {
    // Record insufficient samples so a quiet trigger can be distinguished from
    // a trigger nobody is evaluating.
    if (verdict.outcome === "insufficient_sample") {
      await sql.begin((tx) =>
        store.claimFire(tx, {
          triggerId: trigger.id,
          fireKey,
          outcome: "insufficient_sample",
          detail: {
            metric: trigger.metricKey,
            required: trigger.minimumSample,
            observed: verdict.sample?.sampleSize ?? 0,
          },
        })
      );
    }
    await sql.begin(async (tx) => {
      await store.setBreached(tx, trigger.id, verdict.breached);
      await store.setNextRun(tx, { triggerId: trigger.id, nextRunAt });
    });
    return verdict.outcome === "insufficient_sample"
      ? [{ triggerKey: trigger.key, fireKey, outcome: "insufficient_sample" }]
      : [];
  }

  const claimed = await sql.begin((tx) =>
    store.claimFire(tx, { triggerId: trigger.id, fireKey, outcome: "fired" })
  );
  if (!claimed) return [];

  try {
    const runId = await startWorkflow({
      workflowKey: trigger.workflowKey,
      projectId: trigger.projectId,
      idempotencyKey: `trigger:${trigger.key}:${fireKey}`,
      input: {
        trigger: {
          key: trigger.key,
          kind: "threshold",
          metric: trigger.metricKey,
          comparison: trigger.comparison,
          thresholdValue: trigger.thresholdValue,
          observedValue: verdict.sample.value,
          sampleSize: verdict.sample.sampleSize,
          detail: verdict.sample.detail,
        },
        ...(trigger.config ?? {}),
      },
      trigger: "scheduled",
    });
    await sql.begin(async (tx) => {
      await store.attachFireResult(tx, {
        fireId: claimed.id,
        workflowRunId: runId,
        outcome: "fired",
        detail: { observedValue: verdict.sample.value, sampleSize: verdict.sample.sampleSize },
      });
      await store.setBreached(tx, trigger.id, true);
      await store.setNextRun(tx, { triggerId: trigger.id, nextRunAt, fired: true });
    });
    return [{ triggerKey: trigger.key, fireKey, outcome: "fired" }];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql.begin(async (tx) => {
      await store.attachFireResult(tx, {
        fireId: claimed.id,
        outcome: "failed",
        detail: { error: message.slice(0, 500) },
      });
      await store.setNextRun(tx, { triggerId: trigger.id, nextRunAt });
    });
    return [{ triggerKey: trigger.key, fireKey, outcome: "failed" }];
  }
}

// ------------------------------------------------------------------ manual

export interface ManualTriggerInput {
  workflowKey: string;
  projectId: string | null;
  reason: string;
  mode: "live" | "test";
  input?: Record<string, unknown>;
  userId: string;
}

/**
 * Start a workflow by hand. A reason is mandatory — "who ran this and why" is
 * the minimum an audit trail needs, and a blank reason makes the audit row
 * worthless.
 */
export async function manualTrigger(
  args: ManualTriggerInput,
  startWorkflow: WorkflowStarter
): Promise<{ runId: string }> {
  if (args.reason.trim().length < 3) {
    throw new ClassifiedError(
      "validation",
      "A manual run requires a reason — it is recorded in the audit trail."
    );
  }
  const nonce = randomUUID();
  const runId = await startWorkflow({
    workflowKey: args.workflowKey,
    projectId: args.projectId,
    // A manual run is intentional every time, so its key is unique rather than
    // derived — deduplicating deliberate re-runs would be wrong.
    idempotencyKey: `manual:${args.workflowKey}:${nonce}`,
    input: {
      trigger: { kind: "manual", reason: args.reason, mode: args.mode, userId: args.userId },
      ...(args.input ?? {}),
    },
    trigger: "manual",
  });

  await sql.begin((tx) =>
    writeAudit(tx, {
      userId: args.userId,
      action: "automation.manual_trigger",
      entity: "workflow_run",
      entityId: runId,
      detail: {
        workflowKey: args.workflowKey,
        reason: args.reason,
        mode: args.mode,
        projectId: args.projectId,
      },
    })
  );
  return { runId };
}

// ------------------------------------------------------------ event publish

/** Publish a domain event from a trigger context (used by the manual UI). */
export async function publishManualEvent(args: {
  type: string;
  projectId: string | null;
  payload: Record<string, unknown>;
  userId: string;
  reason: string;
}): Promise<{ eventId: string; created: boolean }> {
  const result = await sql.begin(async (tx) => {
    const published = await publishEvent(tx, {
      type: args.type,
      projectId: args.projectId,
      actorId: args.userId,
      source: "manual",
      payload: args.payload,
      metadata: { reason: args.reason },
    });
    await writeAudit(tx, {
      userId: args.userId,
      action: "automation.manual_event",
      entity: "domain_event",
      entityId: published.event.id,
      detail: { type: args.type, reason: args.reason },
    });
    return published;
  });
  return { eventId: result.event.id, created: result.created };
}
