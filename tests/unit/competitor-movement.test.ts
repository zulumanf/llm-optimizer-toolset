/**
 * Spec 030 movement semantics: overtakes require a flip AND a notable move
 * on at least one side; noise and small samples stay silent.
 */
import { describe, expect, it } from "vitest";
import {
  detectMovement,
  type CompanySeries,
  type MetricSeries,
} from "@/lib/competitors/movement";

function series(
  current: number,
  previous: number,
  opts?: { n?: number; providers?: [number, number][] }
): MetricSeries {
  const n = opts?.n ?? 40;
  // Two providers moving with the aggregate unless overridden — satisfies
  // changeVerdict's ≥2-consistent-providers rule.
  const providerPairs = opts?.providers ?? [
    [current, previous],
    [current, previous],
  ];
  return {
    aggregate: { current, previous, nCurrent: n, nPrevious: n },
    perProvider: providerPairs.map(([cur, prev], i) => ({
      provider: `p${i}`,
      current: cur,
      previous: prev,
      nCurrent: n,
      nPrevious: n,
    })),
  };
}

function company(
  name: string,
  mention: MetricSeries | null
): CompanySeries {
  return {
    companyId: `id-${name}`,
    name,
    metrics: mention ? { mention_rate: mention } : {},
  };
}

describe("detectMovement", () => {
  it("flags an overtake when the competitor flips above with a notable gain", () => {
    const events = detectMovement(company("Parva", series(0.45, 0.55)), [
      company("Acme", series(0.62, 0.4)),
    ]);
    const overtake = events.find((e) => e.kind === "competitor_overtake");
    expect(overtake).toBeDefined();
    expect(overtake?.competitorName).toBe("Acme");
    expect(overtake?.detail).toContain("overtook");
    expect(overtake?.detail).toContain("62%");
  });

  it("flags an overtake when only the subject's fall is notable", () => {
    // Competitor drifts +0.04 (within noise); subject drops 0.15 → flip.
    const events = detectMovement(company("Parva", series(0.4, 0.55)), [
      company("Acme", series(0.5, 0.46)),
    ]);
    expect(events.some((e) => e.kind === "competitor_overtake")).toBe(true);
    expect(events.some((e) => e.kind === "visibility_drop")).toBe(true);
  });

  it("stays silent on a flip inside noise", () => {
    // Both moved < 0.10 — a coin toss, not an overtake.
    const events = detectMovement(company("Parva", series(0.5, 0.53)), [
      company("Acme", series(0.55, 0.5)),
    ]);
    expect(events).toHaveLength(0);
  });

  it("stays silent on small samples even with a big flip", () => {
    const events = detectMovement(
      company("Parva", series(0.2, 0.8, { n: 10 })),
      [company("Acme", series(0.8, 0.2, { n: 10 }))]
    );
    expect(events).toHaveLength(0);
  });

  it("requires provider agreement — a one-provider move is not notable", () => {
    // Aggregate rises 0.22 but the two providers disagree in direction.
    const events = detectMovement(company("Parva", series(0.4, 0.5)), [
      company(
        "Acme",
        series(0.62, 0.4, { providers: [[0.9, 0.3], [0.34, 0.5]] })
      ),
    ]);
    expect(events.some((e) => e.kind === "competitor_overtake")).toBe(false);
  });

  it("reports a visibility drop without any competitor flip", () => {
    const events = detectMovement(company("Parva", series(0.4, 0.55)), [
      company("Acme", series(0.3, 0.3)),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("visibility_drop");
    expect(events[0]?.detail).toContain("55%");
    expect(events[0]?.detail).toContain("40%");
  });

  it("no comparable window (missing metric series) → nothing", () => {
    const events = detectMovement(company("Parva", null), [
      company("Acme", series(0.9, 0.1)),
    ]);
    expect(events).toHaveLength(0);
  });
});
