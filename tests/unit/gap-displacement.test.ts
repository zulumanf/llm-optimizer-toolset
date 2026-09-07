/**
 * Displacement gap findings + priority banding (spec 087). The detector only
 * ever sees engine output that already cleared MIN_ABSENT_SAMPLE and the
 * meaningful bar — these tests pin the finding's shape, score, epistemics,
 * and the band vocabulary the task queue maps from.
 */
import { describe, it, expect } from "vitest";
import {
  detectGaps,
  priorityBand,
  DETECTOR_VERSION,
  PRIORITY_BANDS,
  type DisplacementGapInput,
} from "@/lib/gaps/detect";

const BASE = {
  subjectName: "Lumina Group",
  subjectDomain: "luminagroup.com",
  prompts: [],
  companies: [],
  domains: [],
};

const DISPLACEMENT: DisplacementGapInput = {
  validResponses: 64,
  absentResponses: 58,
  rivals: [
    {
      name: "Team A",
      displacedResponses: 17,
      topClusters: ["luxury condo · seller", "waterfront"],
      topDomains: [
        { domain: "jerseydigs.com", count: 6, sourceType: "local_press" },
        { domain: "zillow.com", count: 4, sourceType: "portal" },
      ],
    },
    {
      name: "Team B",
      displacedResponses: 13,
      topClusters: [],
      topDomains: [],
    },
  ],
  sampleResponseIds: ["res-1", "res-2"],
};

describe("displacement gap finding", () => {
  it("emits an observation-classified finding naming who was recommended instead", () => {
    expect(DETECTOR_VERSION).toBe("gap-detector-v1.2");
    const findings = detectGaps({ ...BASE, displacement: DISPLACEMENT });
    const finding = findings.find((f) => f.gapType === "displacement");
    expect(finding).toBeDefined();
    expect(finding!.finding).toContain("Team A (17×)");
    expect(finding!.finding).toContain("Team B (13×)");
    expect(finding!.finding).toContain("58 of 64");
    expect(finding!.finding).toContain("luxury condo · seller");
    expect(finding!.classification).toBe("observation");
    expect(finding!.promptCategory).toBeNull();
    // Severity: 17/58 of absent answers × 2, capped at 1.
    expect(finding!.severity).toBeCloseTo((17 / 58) * 2, 5);
    expect(finding!.evidence).toHaveLength(2);
    expect(finding!.detail.rivals).toEqual(DISPLACEMENT.rivals);
  });

  it("emits nothing without displacement input or without meaningful rivals", () => {
    expect(
      detectGaps(BASE).some((f) => f.gapType === "displacement")
    ).toBe(false);
    expect(
      detectGaps({
        ...BASE,
        displacement: { ...DISPLACEMENT, rivals: [] },
      }).some((f) => f.gapType === "displacement")
    ).toBe(false);
  });

  it("does not change the pre-087 finding set for callers without displacement data", () => {
    expect(detectGaps(BASE)).toEqual([]);
  });
});

describe("priorityBand", () => {
  it("maps the opportunity score onto the named bands", () => {
    expect(priorityBand(PRIORITY_BANDS.doNow)).toBe("do_now");
    expect(priorityBand(92)).toBe("do_now");
    expect(priorityBand(PRIORITY_BANDS.doNext)).toBe("do_next");
    expect(priorityBand(69.9)).toBe("do_next");
    expect(priorityBand(PRIORITY_BANDS.test)).toBe("test");
    expect(priorityBand(29.9)).toBe("low_priority");
  });
});
