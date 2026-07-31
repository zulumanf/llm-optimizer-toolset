/**
 * Unit tests for the deterministic control-tower maths (spec 019) and the
 * outcome-graph confidence guard.
 *
 * The guard test is the important one: it is the single piece of code standing
 * between "we observed a correlation" and "we caused this", and the platform's
 * credibility rests on it holding.
 */
import { describe, expect, it } from "vitest";
import {
  computePriority,
  timeSensitivityScore,
  effortScore,
  PRIORITY_WEIGHTS,
  PRIORITY_FORMULA_VERSION,
  EXCEPTION_SLA_HOURS,
  EXCEPTION_KINDS,
} from "@/lib/workflow/exceptions";
import { combine, HEALTH_WEIGHTS, HEALTH_COMPONENTS } from "@/lib/control-tower/health";
import { boundConfidence, labelEffectiveness } from "@/lib/outcomes/graph";
import { periodWeeks } from "@/lib/control-tower/capacity";
import {
  resolveAutonomy,
  requiresApprovalFor,
  isManualOnly,
  ACTION_TYPE_AUTONOMY,
} from "@/lib/workflow/autonomy";

describe("priority formula", () => {
  it("weights sum to exactly 1", () => {
    const total = Object.values(PRIORITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("scores a critical overdue item near the top", () => {
    const result = computePriority({
      severity: "critical",
      hoursUntilDue: -5,
      commercialValue: 1,
      dependencyImpact: 1,
      risk: 1,
      effortMinutes: 10,
    });
    expect(result.total).toBeGreaterThan(95);
    expect(result.formulaVersion).toBe(PRIORITY_FORMULA_VERSION);
  });

  it("scores a low-severity, no-deadline, cheap item near the bottom", () => {
    const result = computePriority({
      severity: "low",
      hoursUntilDue: null,
      commercialValue: 0,
      dependencyImpact: 0,
      risk: 0,
      effortMinutes: 480,
    });
    expect(result.total).toBeLessThan(10);
  });

  it("exposes every component so the number can be decomposed", () => {
    const result = computePriority({
      severity: "high",
      hoursUntilDue: 12,
      commercialValue: 0.5,
      dependencyImpact: 0.5,
      risk: 0.5,
      effortMinutes: 30,
    });
    expect(result.components.map((c) => c.name).sort()).toEqual(
      Object.keys(PRIORITY_WEIGHTS).sort()
    );
    const recomputed = result.components.reduce((sum, c) => sum + c.contribution, 0) * 100;
    expect(result.total).toBeCloseTo(Math.round(recomputed * 10) / 10, 5);
  });

  it("ranks an overdue approval above an equally severe item with no deadline", () => {
    const shared = {
      severity: "high" as const,
      commercialValue: 0.5,
      dependencyImpact: 0.5,
      risk: 0.5,
      effortMinutes: 30,
    };
    const overdue = computePriority({ ...shared, hoursUntilDue: -1 });
    const undated = computePriority({ ...shared, hoursUntilDue: null });
    expect(overdue.total).toBeGreaterThan(undated.total);
  });

  it("clamps out-of-range inputs rather than producing a nonsense score", () => {
    const result = computePriority({
      severity: "low",
      hoursUntilDue: null,
      commercialValue: 99,
      dependencyImpact: -3,
      risk: Number.NaN,
      effortMinutes: 1,
    });
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it("time sensitivity is monotonic as a deadline approaches", () => {
    expect(timeSensitivityScore(-1)).toBeGreaterThan(timeSensitivityScore(10));
    expect(timeSensitivityScore(10)).toBeGreaterThan(timeSensitivityScore(100));
    expect(timeSensitivityScore(100)).toBeGreaterThan(timeSensitivityScore(1000));
    expect(timeSensitivityScore(null)).toBeCloseTo(0.1);
  });

  it("effort score favours the cheap fix", () => {
    expect(effortScore(5)).toBeGreaterThan(effortScore(60));
    expect(effortScore(60)).toBeGreaterThan(effortScore(480));
    expect(effortScore(10_000)).toBeCloseTo(0);
  });

  it("every exception kind has an SLA — no silent default", () => {
    for (const kind of EXCEPTION_KINDS) {
      expect(EXCEPTION_SLA_HOURS[kind]).toBeGreaterThan(0);
    }
  });
});

describe("client health combination", () => {
  const component = (name: string, score: number | null) => ({
    name: name as (typeof HEALTH_COMPONENTS)[number],
    weight: HEALTH_WEIGHTS[name as (typeof HEALTH_COMPONENTS)[number]],
    score,
    detail: "",
    evidence: {},
  });

  it("returns null with zero confidence when nothing has data", () => {
    const result = combine(HEALTH_COMPONENTS.map((n) => component(n, null)));
    expect(result.overall).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.missing).toHaveLength(HEALTH_COMPONENTS.length);
  });

  it("does not let a missing component drag the score down", () => {
    const allPresent = combine(HEALTH_COMPONENTS.map((n) => component(n, 0.8)));
    const halfMissing = combine(
      HEALTH_COMPONENTS.map((n, i) => component(n, i % 2 === 0 ? 0.8 : null))
    );
    // Same score, lower confidence — that is the whole point.
    expect(halfMissing.overall).toBeCloseTo(allPresent.overall!, 5);
    expect(halfMissing.confidence).toBeLessThan(allPresent.confidence);
  });

  it("confidence equals the weight share of components that have data", () => {
    const result = combine([
      component("visibility_trend", 1), // weight 0.20
      component("reputation_accuracy", null), // weight 0.15
    ]);
    expect(result.confidence).toBeCloseTo(0.2 / 0.35, 3);
  });

  it("lists exactly which components were missing", () => {
    const result = combine([
      component("visibility_trend", 0.5),
      component("lead_outcomes", null),
    ]);
    expect(result.missing).toEqual(["lead_outcomes"]);
  });
});

describe("outcome relationship confidence guard", () => {
  it("lets a human assert confirmed", () => {
    const result = boundConfidence({
      requested: "confirmed",
      createdByKind: "human",
      hasMatchingIdentifier: false,
      hasSelfReport: false,
    });
    expect(result.label).toBe("confirmed");
    expect(result.lowered).toBe(false);
  });

  it("lets deterministic code assert confirmed WITH a matching identifier", () => {
    const result = boundConfidence({
      requested: "confirmed",
      createdByKind: "deterministic",
      hasMatchingIdentifier: true,
      hasSelfReport: false,
    });
    expect(result.label).toBe("confirmed");
  });

  it("lowers deterministic `confirmed` when no identifier backs it", () => {
    const result = boundConfidence({
      requested: "confirmed",
      createdByKind: "deterministic",
      hasMatchingIdentifier: false,
      hasSelfReport: false,
    });
    expect(result.label).toBe("strongly_supported");
    expect(result.lowered).toBe(true);
    expect(result.reason).toContain("no matching identifier");
  });

  it("NEVER lets an agent assert confirmed, whatever evidence it claims", () => {
    const result = boundConfidence({
      requested: "confirmed",
      createdByKind: "agent",
      hasMatchingIdentifier: true,
      hasSelfReport: true,
    });
    expect(result.label).toBe("correlated");
    expect(result.lowered).toBe(true);
  });

  it("caps an agent at correlated even for strongly_supported", () => {
    const result = boundConfidence({
      requested: "strongly_supported",
      createdByKind: "agent",
      hasMatchingIdentifier: false,
      hasSelfReport: false,
    });
    expect(result.label).toBe("correlated");
  });

  it("passes weaker labels through untouched", () => {
    for (const label of ["correlated", "probable", "unknown"] as const) {
      const result = boundConfidence({
        requested: label,
        createdByKind: "agent",
        hasMatchingIdentifier: false,
        hasSelfReport: false,
      });
      expect(result.label).toBe(label);
      expect(result.lowered).toBe(false);
    }
  });
});

describe("effectiveness labelling", () => {
  const base = {
    citations: { before: null, after: null },
    traffic: { before: null, after: null },
    leads: { before: null, after: null },
    materialityThreshold: 0.1,
    confounders: [],
    daysElapsed: 60,
    expectedDaysToImpact: 30,
  };

  it("is insufficient_measurement when nothing was measured on both sides", () => {
    const result = labelEffectiveness({ ...base, visibility: { before: null, after: 0.5 } });
    expect(result.label).toBe("insufficient_measurement");
  });

  it("is insufficient_measurement before the expected impact window elapses", () => {
    const result = labelEffectiveness({
      ...base,
      visibility: { before: 0.2, after: 0.5 },
      daysElapsed: 5,
    });
    expect(result.label).toBe("insufficient_measurement");
  });

  it("reports no_detectable_change below the materiality threshold", () => {
    const result = labelEffectiveness({ ...base, visibility: { before: 0.5, after: 0.52 } });
    expect(result.label).toBe("no_detectable_change");
  });

  it("reports a positive signal — and says it is association, not cause", () => {
    const result = labelEffectiveness({ ...base, visibility: { before: 0.2, after: 0.4 } });
    expect(result.label).toBe("positive_signal");
    expect(result.reason).toContain("association");
  });

  it("reports a negative signal", () => {
    const result = labelEffectiveness({ ...base, visibility: { before: 0.4, after: 0.2 } });
    expect(result.label).toBe("negative_signal");
  });

  it("confounders beat a positive reading", () => {
    const result = labelEffectiveness({
      ...base,
      visibility: { before: 0.2, after: 0.6 },
      confounders: ["competitor exited the market"],
    });
    expect(result.label).toBe("confounded");
  });

  it("is inconclusive when metrics move in opposite directions", () => {
    const result = labelEffectiveness({
      ...base,
      visibility: { before: 0.2, after: 0.4 },
      traffic: { before: 100, after: 50 },
    });
    expect(result.label).toBe("inconclusive");
  });
});

describe("autonomy", () => {
  it("levels 0-2 demand approval; 3-4 do not", () => {
    expect(requiresApprovalFor(0)).toBe(true);
    expect(requiresApprovalFor(2)).toBe(true);
    expect(requiresApprovalFor(3)).toBe(false);
    expect(requiresApprovalFor(4)).toBe(false);
  });

  it("level 0 is manual-only", () => {
    expect(isManualOnly(0)).toBe(true);
    expect(isManualOnly(1)).toBe(false);
  });

  it("ships the documented defaults for consequential action types", () => {
    expect(ACTION_TYPE_AUTONOMY.legal_decision).toBe(0);
    expect(ACTION_TYPE_AUTONOMY.cms_publishing).toBe(2);
    expect(ACTION_TYPE_AUTONOMY.material_client_claim).toBe(2);
    expect(ACTION_TYPE_AUTONOMY.benchmark_execution).toBe(4);
  });
});

describe("capacity arithmetic", () => {
  it("counts whole weeks in a period", () => {
    expect(periodWeeks("2026-07-01", "2026-07-29")).toBe(4);
    expect(periodWeeks("2026-07-01", "2026-07-08")).toBe(1);
    // Never zero — dividing by it would produce an infinite capacity estimate.
    expect(periodWeeks("2026-07-01", "2026-07-01")).toBe(1);
  });
});

// resolveAutonomy touches the database, so its behaviour is asserted in
// tests/integration/workflow-engine.test.ts. This assertion keeps the import
// honest about what is and is not covered here.
describe("resolveAutonomy", () => {
  it("is exported for the integration suite", () => {
    expect(typeof resolveAutonomy).toBe("function");
  });
});
