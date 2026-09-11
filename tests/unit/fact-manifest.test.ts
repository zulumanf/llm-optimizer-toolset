/**
 * Spec 137 — the canonical fact manifest: derived facts are computed, the
 * manifest compiles only from verified evidence, and artifact assertions
 * (report ↔ manifest, email figures ⊆ manifest) fail deterministically.
 * Tests 34, 36, 40 plus the derived-math lock.
 */
import { describe, expect, it } from "vitest";
import {
  assertNoInternalFields,
  assertReportMatchesManifest,
  assertTextNumbersManifested,
  compileFactManifest,
  numberTokens,
  productionRatioDisplay,
  recommendationMultipleDisplay,
  validatedSummarySentence,
} from "@/lib/prospects/fact-manifest";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { manifestFor, verifiedVerdictFor } from "../fixtures/fact-manifest";

const snapshot: MismatchEvidenceSnapshot = {
  templateVersion: "competitive_mismatch_reply_v1", runId: "run-1", provider: "openai", answerCount: 256, modelCount: 1,
  capturedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:00:00Z", scopeCopy: "Grand Rapids questions", audiences: ["buyer"],
  prospect: { companyId: "p", prospectId: null, name: "Blu House Properties", recommendationCount: 2, productionSignalId: "rp", productionSourceUrl: "https://rt", productionYear: 2025, productionValue: 56_900_000, productionDisplay: "$56.9M closed" },
  competitor: { companyId: "c", prospectId: null, name: "Harbor View Group", recommendationCount: 25, productionSignalId: "rc", productionSourceUrl: "https://rt", productionYear: 2025, productionValue: 24_900_000, productionDisplay: "$24.9M closed", productionRatio: 0.44, recommendationGap: 23 },
  metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
};

describe("derived facts are computed, not generated", () => {
  it("2 / 25 / 256 → ratio 43.76 → 'roughly 44%', multiple 12.5, gap 23; every artifact reads the same values", () => {
    const m = manifestFor(snapshot, "team");
    expect(m.facts.FACT_PRODUCTION_RATIO.value).toBe(43.76);
    expect(m.facts.FACT_PRODUCTION_RATIO.display).toBe("roughly 44%");
    expect(m.facts.FACT_RECOMMENDATION_MULTIPLE.value).toBe(12.5);
    expect(m.facts.FACT_RECOMMENDATION_MULTIPLE.display).toBe("12.5x as often");
    expect(m.facts.FACT_ABSOLUTE_GAP.value).toBe(23);
    expect(m.facts.FACT_DENOMINATOR.value).toBe(256);
    expect(validatedSummarySentence(m).text).toBe("Harbor View Group closed roughly 44% of your team's volume, but was recommended 12.5x as often in the same 256-answer test.");
    expect(productionRatioDisplay(null)).toBeNull();
    expect(recommendationMultipleDisplay(3)).toBe("3x as often");
  });
  it("is deterministic: same evidence → same hashes; a changed count → a different manifest hash", () => {
    const a = manifestFor(snapshot);
    const b = manifestFor(snapshot);
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.evidenceHash).toBe(b.evidenceHash);
    const c = manifestFor({ ...snapshot, competitor: { ...snapshot.competitor, recommendationCount: 26 } });
    expect(c.manifestHash).not.toBe(a.manifestHash);
    // A correction in force changes the manifest even with identical counts.
    const d = compileFactManifest({ snapshot, verdict: verifiedVerdictFor(snapshot, { diagnostics: { ...verifiedVerdictFor(snapshot).diagnostics, correctionId: "corr-1" } }), market: "Reno", prospectEntityType: "team", approvedExampleIds: ["r1"], approvedFirstActionId: "priority-1:abc" });
    expect(d.ok && d.manifest.manifestHash).not.toBe(a.manifestHash);
  });
  it("a zero prospect count compiles a zero-safe sentence (only after the release layer verified the zero)", () => {
    const m = manifestFor({ ...snapshot, prospect: { ...snapshot.prospect, recommendationCount: 0 } }, "individual");
    expect(m.facts.FACT_RECOMMENDATION_MULTIPLE.value).toBeNull();
    expect(validatedSummarySentence(m).text).toContain("was not recommended in any");
  });
});

describe("UNKNOWN fails closed", () => {
  it("does not compile from a blocked verdict or an unknown entity type on either side", () => {
    const blocked = verifiedVerdictFor(snapshot, { verified: false, reasons: ["PRIMARY_SHADOW_COUNT_MISMATCH"] });
    expect(compileFactManifest({ snapshot, verdict: blocked, market: "Reno", prospectEntityType: "team", approvedExampleIds: [], approvedFirstActionId: null })).toEqual({ ok: false, reason: "evidence not verified: PRIMARY_SHADOW_COUNT_MISMATCH" });
    expect(compileFactManifest({ snapshot, verdict: verifiedVerdictFor(snapshot), market: "Reno", prospectEntityType: null, approvedExampleIds: [], approvedFirstActionId: null })).toMatchObject({ ok: false, reason: "prospect entity type unknown" });
    const v = verifiedVerdictFor(snapshot);
    v.diagnostics.entityLevels = { prospect: "team", competitor: null };
    expect(compileFactManifest({ snapshot, verdict: v, market: "Reno", prospectEntityType: "team", approvedExampleIds: [], approvedFirstActionId: null })).toMatchObject({ ok: false, reason: "competitor entity type unknown" });
  });
});

describe("artifact assertions", () => {
  const m = manifestFor(snapshot);
  const block = { prospect: { name: "Blu House Properties", productionDisplay: "$56.9M closed", productionYear: 2025, recommendationCount: 2 }, competitor: { name: "Harbor View Group", productionDisplay: "$24.9M closed", productionYear: 2025, recommendationCount: 25 }, answerCount: 256 };
  it("34: report values equal the manifest → no issues; 35: a stale report (old count) is rejected", () => {
    expect(assertReportMatchesManifest(block, m)).toEqual([]);
    const stale = assertReportMatchesManifest({ ...block, competitor: { ...block.competitor, recommendationCount: 11 } }, m);
    expect(stale).toEqual([{ check: "competitor_recommendations", detail: "report states 11, manifest 25" }]);
    expect(assertReportMatchesManifest({ ...block, answerCount: 255 }, m)[0]!.check).toBe("denominator");
  });
  it("text figures must all be manifest figures", () => {
    expect(numberTokens("$56.9M closed, 25 of 256, roughly 44%")).toEqual(["$56.9M", "25", "256", "44%"]);
    expect(assertTextNumbersManifested("Harbor View Group was recommended 25 times out of 256; that is roughly 44% of your $56.9M.", m)).toEqual([]);
    expect(assertTextNumbersManifested("recommended 26 times", m)[0]!.detail).toContain("26");
  });
  it("36: internal/debug fields never reach customer-facing props", () => {
    expect(assertNoInternalFields({ prospectName: "x", denominator: "256" })).toEqual([]);
    expect(assertNoInternalFields({ prospectName: "x", manifestHash: "abc", run_id: "r" })[0]!.detail).toContain("manifestHash, run_id");
  });
});
