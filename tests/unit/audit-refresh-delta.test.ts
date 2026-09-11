/**
 * Spec 075: the delta a refresh card shows is pure arithmetic over two runs'
 * scored entities — known-answer tested here, including the claim-flip flag
 * the operator must see before approving.
 */
import { describe, expect, it } from "vitest";
import { computeAuditDelta } from "@/lib/prospects/refresh";
import type { BenchmarkEntityMetrics } from "@/lib/prospects/findings";

const SELF = "00000000-0000-4000-9000-000000000001";
const RIVAL = "00000000-0000-4000-9000-000000000002";
const OTHER = "00000000-0000-4000-9000-000000000003";

function entity(
  companyId: string,
  name: string,
  recommendationRate: number | null,
  mentionRate: number | null = null
): BenchmarkEntityMetrics {
  return {
    companyId,
    name,
    mentionRate,
    recommendationRate,
    shareOfVoice: null,
    citationScore: null,
    sampleSize: 40,
    scoreIds: {},
  };
}

describe("computeAuditDelta", () => {
  it("reports old and new rates for the prospect and the top rival", () => {
    const delta = computeAuditDelta(
      SELF,
      [entity(SELF, "Us", 0.05, 0.2), entity(RIVAL, "Compass", 0.15)],
      [entity(SELF, "Us", 0.08, 0.25), entity(RIVAL, "Compass", 0.12)]
    );
    expect(delta.recommendationRate).toEqual({ old: 0.05, new: 0.08 });
    expect(delta.mentionRate).toEqual({ old: 0.2, new: 0.25 });
    expect(delta.topRival).toEqual({
      companyId: RIVAL,
      name: "Compass",
      rate: { old: 0.15, new: 0.12 },
    });
    expect(delta.claimStillTrue).toBe(true);
  });

  it("picks the top rival by NEW recommendation rate", () => {
    const delta = computeAuditDelta(
      SELF,
      [entity(SELF, "Us", 0.05), entity(RIVAL, "Compass", 0.3), entity(OTHER, "Sotheby's", 0.1)],
      [entity(SELF, "Us", 0.05), entity(RIVAL, "Compass", 0.06), entity(OTHER, "Sotheby's", 0.2)]
    );
    expect(delta.topRival?.name).toBe("Sotheby's");
    expect(delta.topRival?.rate).toEqual({ old: 0.1, new: 0.2 });
  });

  it("flags the claim as flipped when the prospect now leads every rival", () => {
    const delta = computeAuditDelta(
      SELF,
      [entity(SELF, "Us", 0.05), entity(RIVAL, "Compass", 0.15)],
      [entity(SELF, "Us", 0.2), entity(RIVAL, "Compass", 0.1)]
    );
    expect(delta.claimStillTrue).toBe(false);
  });

  it("keeps the claim standing on a tie", () => {
    const delta = computeAuditDelta(
      SELF,
      [entity(SELF, "Us", 0.1), entity(RIVAL, "Compass", 0.1)],
      [entity(SELF, "Us", 0.1), entity(RIVAL, "Compass", 0.1)]
    );
    expect(delta.claimStillTrue).toBe(true);
  });

  it("treats missing measurements as absence of evidence, not a reversal", () => {
    const noRival = computeAuditDelta(SELF, [entity(SELF, "Us", 0.1)], [entity(SELF, "Us", 0.1)]);
    expect(noRival.topRival).toBeNull();
    expect(noRival.claimStillTrue).toBe(true);

    const nullRates = computeAuditDelta(
      SELF,
      [entity(SELF, "Us", null), entity(RIVAL, "Compass", null)],
      [entity(SELF, "Us", null), entity(RIVAL, "Compass", null)]
    );
    expect(nullRates.recommendationRate).toEqual({ old: null, new: null });
    expect(nullRates.claimStillTrue).toBe(true);
  });

  it("handles a company absent from the old run (new market entrant)", () => {
    const delta = computeAuditDelta(
      SELF,
      [entity(SELF, "Us", 0.05)],
      [entity(SELF, "Us", 0.05), entity(RIVAL, "Compass", 0.2)]
    );
    expect(delta.topRival?.rate).toEqual({ old: null, new: 0.2 });
  });
});
