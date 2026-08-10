/**
 * Spec 059: alert thresholds are pure math over the health report — the
 * platform's "am I dying" logic must be testable without a database.
 */
import { describe, expect, it } from "vitest";
import { alertsFromReport } from "@/lib/ops/alerts";
import type { HealthReport } from "@/lib/ops/health";

const healthy = (over: Partial<HealthReport> = {}): HealthReport => ({
  ok: true,
  db: true,
  worker: { alive: true, lastSeenAt: new Date(), workerId: "w-1" },
  queue: { queued: 0, oldestQueuedMinutes: null, overdue: 0 },
  drift: { openSignals: 0 },
  spend: { last24hUsd: 1, ceilingUsd: 25 },
  ...over,
});

describe("alertsFromReport", () => {
  it("a healthy report fires nothing", () => {
    expect(alertsFromReport(healthy())).toEqual([]);
  });

  it("an unreachable db is the only alert — everything else is unknowable", () => {
    const alerts = alertsFromReport(healthy({ db: false }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("db_unreachable");
  });

  it("a stale worker fires, with the never-beaten case worded honestly", () => {
    const stale = alertsFromReport(
      healthy({ worker: { alive: false, lastSeenAt: new Date(0), workerId: "w-1" } })
    );
    expect(stale.map((a) => a.kind)).toContain("worker_stale");
    const never = alertsFromReport(
      healthy({ worker: { alive: false, lastSeenAt: null, workerId: null } })
    );
    expect(never[0]!.message).toContain("ever beaten");
  });

  it("overdue queue, open drift, and near-ceiling spend each fire by name", () => {
    const alerts = alertsFromReport(
      healthy({
        queue: { queued: 9, oldestQueuedMinutes: 44, overdue: 3 },
        drift: { openSignals: 2 },
        spend: { last24hUsd: 23, ceilingUsd: 25 },
      })
    );
    expect(alerts.map((a) => a.kind).sort()).toEqual([
      "drift_open",
      "queue_backlog",
      "spend_near_ceiling",
    ]);
  });

  it("spend below 90% of the ceiling stays quiet", () => {
    expect(
      alertsFromReport(healthy({ spend: { last24hUsd: 22.4, ceilingUsd: 25 } }))
    ).toEqual([]);
  });
});
