/**
 * Spec 146 — the v2 schema, the deterministic validator and context
 * precondition, the grader and gate, and the gold dataset's structure.
 */
import { describe, expect, it } from "vitest";
import {
  DETECT_CONTRADICTIONS_V2_PREAMBLE,
  DETECT_CONTRADICTIONS_V2_SYSTEM,
  FIXTURE_CRITICAL_CASES,
  GOLD_GROUPS,
  PROMOTION_GATES,
  contradictionContextError,
  contradictionDetectionV2Schema,
  gradeContradictionOutput,
  isCriticalFixture,
  summarizeEval,
  validateContradictionOutput,
  type ContradictionDetectionV2,
  type EvalRun,
  type GoldFixture,
} from "@/lib/automation/contradictions/contract";
import {
  DETECT_CONTRADICTIONS_GOLD,
  GOLD_DATASET_SHA256,
  goldDatasetHash,
} from "@/tests/fixtures/detect-contradictions-gold";
import { AUTOMATION_PROMPTS } from "@/lib/automation/prompts";
import { inferenceTargetForTask } from "@/lib/ai/routing";

const gold = (id: string): GoldFixture => {
  const f = DETECT_CONTRADICTIONS_GOLD.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
};

type Obs = { claimId: string; normalizedWording: string };
type Appr = { id: string; text: string };
const obsOf = (f: GoldFixture) => f.context.observedClaims as Obs[];
const apprOf = (f: GoldFixture) => (f.context.approvedFacts as { claims: Appr[] }).claims;

/** The correct answer for a fixture, built from its labels. */
function correctAnswer(f: GoldFixture): ContradictionDetectionV2 {
  return {
    contradictions: f.expectedPairs.map((p) => ({
      observedClaimId: p.observedClaimId,
      approvedClaimId: p.approvedClaimId,
      statementA: obsOf(f).find((o) => o.claimId === p.observedClaimId)!.normalizedWording,
      statementB: apprOf(f).find((a) => a.id === p.approvedClaimId)!.text,
      severity: p.severity[p.severity.length - 1]!,
      explanation: "Both cannot be true.",
    })),
    confidence: 0.9,
  };
}

describe("v2 schema", () => {
  it("requires the contradictions field — omission is a failure, not clean", () => {
    expect(contradictionDetectionV2Schema.safeParse({ confidence: 0.9 }).success).toBe(false);
    expect(contradictionDetectionV2Schema.safeParse({ contradictions: [], confidence: 0.9 }).success).toBe(true);
  });

  it("requires confidence in [0, 1] and a known severity", () => {
    expect(contradictionDetectionV2Schema.safeParse({ contradictions: [] }).success).toBe(false);
    expect(contradictionDetectionV2Schema.safeParse({ contradictions: [], confidence: 1.2 }).success).toBe(false);
    const bad = correctAnswer(gold("s1_brokerage_change"));
    (bad.contradictions[0] as { severity: string }).severity = "severe";
    expect(contradictionDetectionV2Schema.safeParse(bad).success).toBe(false);
  });

  it("requires both ids and both statements", () => {
    const answer = correctAnswer(gold("s1_brokerage_change"));
    const withoutId: Record<string, unknown> = { ...answer.contradictions[0]! };
    delete withoutId.observedClaimId;
    expect(
      contradictionDetectionV2Schema.safeParse({ ...answer, contradictions: [withoutId] }).success
    ).toBe(false);
  });

  it("names both contexts and the direction in the v2 prompt, which production now uses (spec 146 §10)", () => {
    expect(DETECT_CONTRADICTIONS_V2_SYSTEM).toContain("observedClaims");
    expect(DETECT_CONTRADICTIONS_V2_SYSTEM).toContain("approvedFacts");
    expect(DETECT_CONTRADICTIONS_V2_SYSTEM).toContain("Never compare within one context");
    expect(DETECT_CONTRADICTIONS_V2_PREAMBLE).toContain("observedClaims against approvedFacts");
    expect(AUTOMATION_PROMPTS.detect_contradictions.version).toBe("detect-contradictions-v2");
    expect(inferenceTargetForTask("detect_contradictions").backend).toBe("ollama");
  });
});

describe("context precondition", () => {
  it("accepts every gold context, including empty observed claims and an empty packet", () => {
    for (const f of DETECT_CONTRADICTIONS_GOLD) {
      expect(contradictionContextError(f.context), f.id).toBeNull();
    }
  });

  it("refuses a missing or malformed context before any model call", () => {
    expect(contradictionContextError(null)).not.toBeNull();
    expect(contradictionContextError([])).not.toBeNull();
    expect(contradictionContextError({ approvedFacts: { claims: [] } })).not.toBeNull();
    expect(contradictionContextError({ observedClaims: [], approvedFacts: null })).not.toBeNull();
    expect(contradictionContextError({ observedClaims: [], approvedFacts: {} })).not.toBeNull();
    expect(contradictionContextError({ observedClaims: {}, approvedFacts: { claims: [] } })).not.toBeNull();
  });
});

describe("validateContradictionOutput", () => {
  const f = gold("s1_brokerage_change");
  const good = () => correctAnswer(f);

  it("accepts a correct, grounded answer and an empty answer", () => {
    expect(validateContradictionOutput(good(), f.context).ok).toBe(true);
    expect(validateContradictionOutput({ contradictions: [], confidence: 0.8 }, f.context).ok).toBe(true);
  });

  it("rejects malformed output and a missing contradictions field as schema failures", () => {
    for (const raw of [null, "no", { confidence: 0.9 }, { contradictions: "none", confidence: 0.5 }]) {
      const result = validateContradictionOutput(raw, f.context);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.kind).toBe("schema");
    }
  });

  it("rejects an invalid severity", () => {
    const bad = good();
    (bad.contradictions[0] as { severity: string }).severity = "urgent";
    const result = validateContradictionOutput(bad, f.context);
    expect(!result.ok && result.kind).toBe("schema");
  });

  it("rejects fabricated ids", () => {
    const bad = good();
    bad.contradictions[0]!.observedClaimId = "00000000-0000-4000-8000-000000000000";
    const result = validateContradictionOutput(bad, f.context);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe("validation");
    expect(!result.ok && result.errors.join()).toContain("is not in observedClaims");

    const bad2 = good();
    bad2.contradictions[0]!.approvedClaimId = "made-up";
    expect(validateContradictionOutput(bad2, f.context).ok).toBe(false);
  });

  it("rejects fabricated or edited statements", () => {
    const bad = good();
    bad.contradictions[0]!.statementA = "Ana Perez is a top agent with Douglas Elliman.";
    expect(validateContradictionOutput(bad, f.context).ok).toBe(false);
    const bad2 = good();
    bad2.contradictions[0]!.statementB = "Ana Perez was affiliated with Compass.";
    expect(validateContradictionOutput(bad2, f.context).ok).toBe(false);
  });

  it("accepts whitespace and case differences, but nothing else", () => {
    const ok = good();
    ok.contradictions[0]!.statementA = `  ${ok.contradictions[0]!.statementA.toUpperCase()}  `;
    expect(validateContradictionOutput(ok, f.context).ok).toBe(true);
    const bad = good();
    bad.contradictions[0]!.statementA = bad.contradictions[0]!.statementA.replace(/\.$/, "");
    expect(validateContradictionOutput(bad, f.context).ok).toBe(false);
  });

  it("rejects a swapped direction", () => {
    const answer = good().contradictions[0]!;
    const swappedIds = {
      contradictions: [
        { ...answer, observedClaimId: answer.approvedClaimId, approvedClaimId: answer.observedClaimId },
      ],
      confidence: 0.9,
    };
    const r1 = validateContradictionOutput(swappedIds, f.context);
    expect(!r1.ok && r1.errors.join()).toContain("direction swapped");

    const swappedText = {
      contradictions: [{ ...answer, statementA: answer.statementB, statementB: answer.statementA }],
      confidence: 0.9,
    };
    const r2 = validateContradictionOutput(swappedText, f.context);
    expect(!r2.ok && r2.errors.join()).toContain("direction swapped");
  });

  it("rejects a within-context pair and a duplicate pair", () => {
    const w = gold("w1_observed_disagree");
    const [o1, o2] = obsOf(w);
    const within = {
      contradictions: [
        { observedClaimId: o1!.claimId, approvedClaimId: o2!.claimId, statementA: o1!.normalizedWording, statementB: o2!.normalizedWording, severity: "high", explanation: "x" },
      ],
      confidence: 0.9,
    };
    expect(validateContradictionOutput(within, w.context).ok).toBe(false);

    const dup = good();
    dup.contradictions.push({ ...dup.contradictions[0]! });
    const r = validateContradictionOutput(dup, f.context);
    expect(!r.ok && r.errors.join()).toContain("duplicate pair");
  });
});

describe("gradeContradictionOutput", () => {
  it("passes every check for the labelled answer on every fixture", () => {
    for (const f of DETECT_CONTRADICTIONS_GOLD) {
      const answer = correctAnswer(f);
      expect(validateContradictionOutput(answer, f.context).ok, f.id).toBe(true);
      const grade = gradeContradictionOutput(f, answer);
      expect(grade.checks.every((c) => c.passed), f.id).toBe(true);
    }
  });

  it("fails the critical find check when a contradiction is missed", () => {
    const f = gold("s1_brokerage_change");
    const grade = gradeContradictionOutput(f, { contradictions: [], confidence: 0.9 });
    expect(grade.expectedFound).toBe(0);
    expect(grade.checks.find((c) => c.name.startsWith("finds"))).toMatchObject({ passed: false, critical: true });
  });

  it("fails the critical no-extra-pair check on a false positive", () => {
    const f = gold("n1_subset_market");
    const o = obsOf(f)[0]!;
    const a = apprOf(f)[0]!;
    const grade = gradeContradictionOutput(f, {
      contradictions: [
        { observedClaimId: o.claimId, approvedClaimId: a.id, statementA: o.normalizedWording, statementB: a.text, severity: "medium", explanation: "x" },
      ],
      confidence: 0.8,
    });
    expect(grade.unexpectedPairs).toHaveLength(1);
    expect(grade.checks.find((c) => c.name.startsWith("reports no pair"))).toMatchObject({ passed: false, critical: true });
  });

  it("enforces the case-11 severity floor as critical and the band as non-critical", () => {
    const f = gold("s2_license_number");
    const answer = correctAnswer(f);
    answer.contradictions[0]!.severity = "medium";
    const grade = gradeContradictionOutput(f, answer);
    expect(grade.checks.find((c) => c.name.includes("high or critical"))).toMatchObject({ passed: false, critical: true });
    expect(grade.checks.find((c) => c.name.includes("in ["))).toMatchObject({ passed: false, critical: false });
    expect(grade.severityInBand).toBe(0);
  });

  it("checks confidence >= 0.7 on a clear contradiction", () => {
    const f = gold("s3_same_period_count");
    const answer = { ...correctAnswer(f), confidence: 0.4 };
    expect(gradeContradictionOutput(f, answer).checks.find((c) => c.name.startsWith("confidence"))!.passed).toBe(false);
  });
});

describe("summarizeEval and the promotion gate", () => {
  const holdout = DETECT_CONTRADICTIONS_GOLD.filter((f) => f.split === "holdout");
  const perfect = (): EvalRun[] =>
    holdout.flatMap((f) =>
      [1, 2, 3].map((rep) => ({
        fixtureId: f.id,
        rep,
        failure: null,
        grade: gradeContradictionOutput(f, correctAnswer(f)),
        durationMs: 10_000,
      }))
    );

  it("passes a perfect run", () => {
    const summary = summarizeEval(holdout, perfect());
    expect(summary.passed).toBe(true);
    expect(summary.criticalRunsPassed).toBe(summary.criticalRuns);
    expect(summary.criticalRuns).toBe(33);
    expect(summary.overallPassRate).toBe(1);
    expect(summary.recall).toBe(1);
    expect(summary.falsePositiveRate).toBe(0);
    expect(summary.consistency).toBe(1);
  });

  it("fails on a single runtime, schema or validator failure", () => {
    for (const failure of ["runtime", "schema", "validation"] as const) {
      const runs = perfect();
      runs[0] = { ...runs[0]!, failure, grade: null };
      const summary = summarizeEval(holdout, runs);
      expect(summary.gates.maxFailures).toBe(false);
      expect(summary.passed).toBe(false);
    }
  });

  it("fails on one missed critical contradiction in one repetition", () => {
    const runs = perfect();
    const index = runs.findIndex((r) => r.fixtureId === "r1_rejected_recurring");
    runs[index] = {
      ...runs[index]!,
      grade: gradeContradictionOutput(gold("r1_rejected_recurring"), { contradictions: [], confidence: 0.9 }),
    };
    const summary = summarizeEval(holdout, runs);
    expect(summary.gates.criticalPassRate).toBe(false);
    expect(summary.gates.criticalConsistency).toBe(false);
    expect(summary.passed).toBe(false);
  });

  it("fails on p95 latency above 60 s", () => {
    const runs = perfect().map((r) => ({ ...r, durationMs: 61_000 }));
    expect(summarizeEval(holdout, runs).gates.maxP95LatencyMs).toBe(false);
  });

  it("keeps the gates exactly as spec 146 fixes them", () => {
    expect(PROMOTION_GATES).toEqual({
      criticalPassRate: 1,
      overallPassRate: 0.95,
      recall: 0.95,
      maxFalsePositiveRate: 0.05,
      maxFailures: 0,
      criticalConsistency: 1,
      overallConsistency: 0.95,
      severityAccuracy: 0.9,
      maxP95LatencyMs: 60_000,
    });
  });
});

describe("gold dataset", () => {
  const fixtures = DETECT_CONTRADICTIONS_GOLD;
  const holdout = fixtures.filter((f) => f.split === "holdout");

  it("is frozen by its hash", () => {
    expect(goldDatasetHash()).toBe(GOLD_DATASET_SHA256);
  });

  it("has at least 40 fixtures with unique ids and every group, split about 60/40", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    for (const group of GOLD_GROUPS) {
      expect(fixtures.some((f) => f.group === group), group).toBe(true);
      expect(holdout.some((f) => f.group === group), `holdout ${group}`).toBe(true);
    }
    expect(holdout.length / fixtures.length).toBeGreaterThanOrEqual(0.35);
    expect(holdout.length / fixtures.length).toBeLessThanOrEqual(0.45);
  });

  it("marks exactly 11 critical fixtures, all in the holdout, covering every fixture-level critical case", () => {
    const critical = fixtures.filter(isCriticalFixture);
    expect(critical.map((f) => f.id)).toEqual([
      "s1_brokerage_change",
      "s2_license_number",
      "s3_same_period_count",
      "n1_subset_market",
      "n2_over_forty",
      "p1_different_years",
      "f1_same_surname",
      "r1_rejected_recurring",
      "o1_no_counterpart",
      "w1_observed_disagree",
      "a1_prompt_injection",
    ]);
    expect(critical.every((f) => f.split === "holdout")).toBe(true);
    const covered = new Set(critical.flatMap((f) => f.criticalCases));
    for (const c of FIXTURE_CRITICAL_CASES) expect(covered.has(c), `case ${c}`).toBe(true);
  });

  it("references only ids present in each fixture's contexts, with a rule on every fixture", () => {
    for (const f of fixtures) {
      expect(f.rule.length, f.id).toBeGreaterThan(5);
      const obsIds = new Set(obsOf(f).map((o) => o.claimId));
      const apprIds = new Set(apprOf(f).map((a) => a.id));
      for (const p of f.expectedPairs) {
        expect(obsIds.has(p.observedClaimId), f.id).toBe(true);
        expect(apprIds.has(p.approvedClaimId), f.id).toBe(true);
        expect(p.severity.length, f.id).toBeGreaterThan(0);
      }
    }
  });

  it("uses the production context shapes", () => {
    const f = gold("r1_rejected_recurring");
    expect(obsOf(f)[0]).toMatchObject({ existingStatus: "rejected", resolution: "already_known" });
    expect(f.context.approvedFacts).toMatchObject({ audience: "public", claimCount: 1 });
    expect(Object.keys(apprOf(f)[0]!)).toEqual(
      expect.arrayContaining(["id", "key", "text", "value", "category", "asOf", "stale", "evidenceIds"])
    );
  });
});
