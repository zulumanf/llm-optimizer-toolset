/**
 * The worker's scheduler cadence (2026-08-17): tickDue is the one decision
 * the loop makes about time, so it is pinned here. The tick bodies
 * themselves are the same functions the cron routes run, covered by the
 * automation-layer and cron-route integration suites.
 *
 * Spec 115 addition: the assistant-task lane of runAutomationTick is pinned
 * with every other lane mocked — its counts join the report, and a throwing
 * task engine is isolated instead of aborting the rest of the tick.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAutomationTick, tickDue } from "@/lib/ops/tick";

const mocks = vi.hoisted(() => ({
  runTriggerDispatch: vi.fn(),
  runEventDelivery: vi.fn(),
  sweepConnections: vi.fn(),
  runDailyMaintenance: vi.fn(),
  runWeeklyMaintenance: vi.fn(),
  measureDueActionOutcomes: vi.fn(),
  startWeeklyCycles: vi.fn(),
  startWeeklyBriefs: vi.fn(),
  syncNotifications: vi.fn(),
  detectDriftSignals: vi.fn(),
  dispatchSystemAlerts: vi.fn(),
  syncInterventionStatuses: vi.fn(),
  drainScheduledSends: vi.fn(),
  advanceCityPipelines: vi.fn(),
  advanceAssistantTasks: vi.fn(),
}));

vi.mock("@/lib/automation/dispatch", () => ({
  runTriggerDispatch: mocks.runTriggerDispatch,
  runEventDelivery: mocks.runEventDelivery,
}));
vi.mock("@/lib/connectors/health", () => ({ sweepConnections: mocks.sweepConnections }));
vi.mock("@/lib/knowledge/maintenance/service", () => ({
  runDailyMaintenance: mocks.runDailyMaintenance,
  runWeeklyMaintenance: mocks.runWeeklyMaintenance,
}));
vi.mock("@/lib/outcomes/sweep", () => ({
  measureDueActionOutcomes: mocks.measureDueActionOutcomes,
}));
vi.mock("@/lib/cycles/service", () => ({
  startWeeklyCycles: mocks.startWeeklyCycles,
  startWeeklyBriefs: mocks.startWeeklyBriefs,
}));
vi.mock("@/lib/notifications/service", () => ({ syncNotifications: mocks.syncNotifications }));
vi.mock("@/lib/drift/detect", () => ({ detectDriftSignals: mocks.detectDriftSignals }));
vi.mock("@/lib/ops/alerts", () => ({ dispatchSystemAlerts: mocks.dispatchSystemAlerts }));
vi.mock("@/lib/attribution/service", () => ({
  syncInterventionStatuses: mocks.syncInterventionStatuses,
}));
vi.mock("@/lib/prospects/scheduled-sends", () => ({
  drainScheduledSends: mocks.drainScheduledSends,
}));
vi.mock("@/lib/prospects/city-pipeline", () => ({
  advanceCityPipelines: mocks.advanceCityPipelines,
}));
vi.mock("@/lib/assistant/tasks", () => ({
  advanceAssistantTasks: mocks.advanceAssistantTasks,
}));

const T0 = 1_800_000_000_000;
const TEN_MIN = 10 * 60_000;

describe("tickDue", () => {
  it("fires immediately on a fresh process (no prior tick)", () => {
    expect(tickDue(null, T0, TEN_MIN)).toBe(true);
  });

  it("does not fire before the interval elapses", () => {
    expect(tickDue(T0, T0 + TEN_MIN - 1, TEN_MIN)).toBe(false);
  });

  it("fires exactly at and after the interval", () => {
    expect(tickDue(T0, T0 + TEN_MIN, TEN_MIN)).toBe(true);
    expect(tickDue(T0, T0 + 5 * TEN_MIN, TEN_MIN)).toBe(true);
  });

  it("handles a clock that went backwards by staying quiet", () => {
    expect(tickDue(T0, T0 - 1, TEN_MIN)).toBe(false);
  });
});

describe("runAutomationTick — the assistant-task lane (spec 115)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runTriggerDispatch.mockResolvedValue({ evaluated: 0, fired: 0, skipped: 0, failed: 0 });
    mocks.runEventDelivery.mockResolvedValue({ delivered: 0, deadLettered: 0 });
    const maintenance = {
      windowKey: "w",
      alreadyRan: true,
      status: "ok",
      exceptionsOpened: 0,
      pagesRebuilt: 0,
      pagesConsidered: 0,
      checksFailed: 0,
    };
    mocks.runDailyMaintenance.mockResolvedValue(maintenance);
    mocks.runWeeklyMaintenance.mockResolvedValue(maintenance);
    mocks.measureDueActionOutcomes.mockResolvedValue({ measured: 0 });
    mocks.syncNotifications.mockResolvedValue({ synced: 0 });
    mocks.detectDriftSignals.mockResolvedValue({ opened: 0 });
    mocks.dispatchSystemAlerts.mockResolvedValue({ firing: [], sent: 0 });
    mocks.syncInterventionStatuses.mockResolvedValue({ advanced: 0 });
    mocks.drainScheduledSends.mockResolvedValue({ sent: 0 });
    mocks.advanceCityPipelines.mockResolvedValue({ advanced: 0 });
  });

  it("includes the task engine's counts in the tick report", async () => {
    mocks.advanceAssistantTasks.mockResolvedValue({
      advanced: 2,
      parked: 1,
      resumed: 1,
      completed: 1,
      failed: 0,
    });
    const report = await runAutomationTick();
    expect(mocks.advanceAssistantTasks).toHaveBeenCalledTimes(1);
    expect(report.assistantTasks).toEqual({
      advanced: 2,
      parked: 1,
      resumed: 1,
      completed: 1,
      failed: 0,
    });
    expect(report.triggers).toEqual({ evaluated: 0, fired: 0, skipped: 0, failed: 0 });
  });

  it("a throwing task engine is isolated — the rest of the tick still runs", async () => {
    mocks.advanceAssistantTasks.mockRejectedValue(new Error("task engine exploded"));
    const report = await runAutomationTick();
    expect(report.assistantTasks).toEqual({
      error: "assistant tasks failed; dispatch was unaffected",
    });
    // Notification sync runs AFTER the task lane — the throw did not abort it.
    expect(mocks.syncNotifications).toHaveBeenCalledTimes(1);
    expect(report.notifications).toEqual({ synced: 0 });
    expect(report.scheduledSends).toEqual({ sent: 0 });
  });
});
