/**
 * Recommendation displacement (spec 087): business-invariant tests over the
 * pure core. Failed observations never reach the input by contract (callers
 * filter error rows); these fixtures prove everything the engine itself must
 * guarantee: presence excludes, echo excludes, thresholds hold, and every
 * count reconciles to the mention rows it came from.
 */
import { describe, it, expect } from "vitest";
import {
  computeDisplacement,
  promptContexts,
  MIN_ABSENT_SAMPLE,
  MIN_MEANINGFUL_DISPLACEMENTS,
  DISPLACEMENT_VERSION,
} from "@/lib/competitors/displacement";
import type { RunMentionRow, ValidResponseRow } from "@/db/displacement";
import type { FrozenPrompt } from "@/lib/prompts/types";

const SUBJECT = "subject-co";
const RIVAL_A = "rival-a";
const RIVAL_B = "rival-b";

function frozen(
  id: string,
  text: string,
  overrides: Partial<FrozenPrompt> = {}
): FrozenPrompt {
  return {
    promptId: id,
    text,
    category: "recommendation",
    language: "en",
    position: 1,
    ...overrides,
  };
}

function response(id: string, promptId: string, provider = "openai"): ValidResponseRow {
  return { id, provider, promptId };
}

function mention(
  responseId: string,
  companyId: string,
  overrides: Partial<RunMentionRow> = {}
): RunMentionRow {
  return {
    responseId,
    companyId,
    companyName: companyId,
    mentioned: true,
    recommended: true,
    listPosition: null,
    promptEchoed: false,
    ...overrides,
  };
}

/** 8 prompts / 8 responses: enough absent sample to clear the threshold. */
function baseFixture() {
  const prompts = Array.from({ length: 8 }, (_, i) =>
    frozen(`p${i}`, `who should sell my condo in area ${i}`, {
      neighborhood: i % 2 === 0 ? "paulus hook" : "the heights",
      propertyType: "condo",
      tier: 1,
    })
  );
  const responses = prompts.map((p, i) =>
    response(`r${i}`, p.promptId, i % 2 === 0 ? "openai" : "google")
  );
  return { prompts, responses, contexts: promptContexts(prompts) };
}

describe("computeDisplacement", () => {
  it("counts rivals recommended in the subject's absence, reconciled to the mention rows", () => {
    const { responses, contexts } = baseFixture();
    const mentions = [
      // Subject present on r0 — that response can never displace.
      mention("r0", SUBJECT),
      mention("r0", RIVAL_A),
      // Rival A recommended on 3 absent responses.
      mention("r1", RIVAL_A),
      mention("r2", RIVAL_A),
      mention("r3", RIVAL_A),
      // Rival B on 2.
      mention("r2", RIVAL_B),
      mention("r4", RIVAL_B),
    ];
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });

    expect(result.version).toBe(DISPLACEMENT_VERSION);
    expect(result.validResponses).toBe(8);
    expect(result.subjectMentionedResponses).toBe(1);
    expect(result.absentResponses).toBe(7);
    expect(result.status).toBe("ok");

    const a = result.rivals.find((r) => r.companyId === RIVAL_A)!;
    const b = result.rivals.find((r) => r.companyId === RIVAL_B)!;
    // Reconciliation: counts match exactly the qualifying mention rows,
    // and the evidence response ids are the same rows.
    expect(a.displacedResponses).toBe(3);
    expect(a.responseIds).toEqual(["r1", "r2", "r3"]);
    expect(b.displacedResponses).toBe(2);
    expect(b.responseIds).toEqual(["r2", "r4"]);
    // r0 (subject present) contributed to neither rival.
    expect(a.responseIds).not.toContain("r0");
    // Ordering: most-displacing first.
    expect(result.rivals[0]!.companyId).toBe(RIVAL_A);
  });

  it("subject presence on a response excludes it even when the subject was not recommended", () => {
    const { responses, contexts } = baseFixture();
    const mentions = [
      // Subject mentioned-but-not-recommended: still present, still excluded.
      mention("r1", SUBJECT, { recommended: false }),
      mention("r1", RIVAL_A),
      mention("r2", RIVAL_A),
      mention("r3", RIVAL_A),
    ];
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    const a = result.rivals.find((r) => r.companyId === RIVAL_A)!;
    expect(a.displacedResponses).toBe(2);
    expect(a.responseIds).toEqual(["r2", "r3"]);
  });

  it("echoed rival recommendations never count (the prompt named the rival)", () => {
    const { responses, contexts } = baseFixture();
    const mentions = [
      mention("r1", RIVAL_A, { promptEchoed: true }),
      mention("r2", RIVAL_A, { promptEchoed: true }),
      mention("r3", RIVAL_A),
      mention("r4", RIVAL_A),
    ];
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    const a = result.rivals.find((r) => r.companyId === RIVAL_A)!;
    expect(a.displacedResponses).toBe(2);
  });

  it("mentioned-but-not-recommended rivals never count as displacement", () => {
    const { responses, contexts } = baseFixture();
    const mentions = [
      mention("r1", RIVAL_A, { recommended: false }),
      mention("r2", RIVAL_A, { recommended: false }),
    ];
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    expect(result.rivals).toHaveLength(0);
  });

  it("a rival appearing once is reported but flagged below the meaningful bar", () => {
    const { responses, contexts } = baseFixture();
    const mentions = [
      mention("r1", RIVAL_A),
      mention("r2", RIVAL_B),
      mention("r3", RIVAL_B),
    ];
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    const a = result.rivals.find((r) => r.companyId === RIVAL_A)!;
    const b = result.rivals.find((r) => r.companyId === RIVAL_B)!;
    expect(MIN_MEANINGFUL_DISPLACEMENTS).toBe(2);
    expect(a.meaningful).toBe(false);
    expect(b.meaningful).toBe(true);
    // Sub-threshold rivals never reach the headline observations.
    expect(result.observations.join(" ")).not.toContain(`${RIVAL_A} was recommended`);
  });

  it("returns insufficient_evidence below the absent-sample threshold", () => {
    const prompts = Array.from({ length: 4 }, (_, i) => frozen(`p${i}`, `q ${i}`));
    const responses = prompts.map((p, i) => response(`r${i}`, p.promptId));
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions: [mention("r1", RIVAL_A), mention("r2", RIVAL_A)],
      contexts: promptContexts(prompts),
    });
    expect(result.absentResponses).toBeLessThan(MIN_ABSENT_SAMPLE);
    expect(result.status).toBe("insufficient_evidence");
    expect(result.explanation).toBeNull();
  });

  it("holdout prompts stay out of every denominator", () => {
    const prompts = [
      ...Array.from({ length: 7 }, (_, i) => frozen(`p${i}`, `q ${i}`)),
      frozen("ph", "holdout question", { isHoldout: true }),
    ];
    const responses = prompts.map((p, i) => response(`r${i}`, p.promptId));
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      // A rival recommendation on the holdout response must not count.
      mentions: [mention("r7", RIVAL_A), mention("r1", RIVAL_A)],
      contexts: promptContexts(prompts),
    });
    expect(result.validResponses).toBe(7);
    const a = result.rivals.find((r) => r.companyId === RIVAL_A)!;
    expect(a.displacedResponses).toBe(1);
  });

  it("mention rows for unknown responses (e.g. failed observations) are ignored", () => {
    const { responses, contexts } = baseFixture();
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions: [
        mention("r-failed", RIVAL_A),
        mention("r-failed-2", RIVAL_A),
        mention("r1", RIVAL_A),
        mention("r2", RIVAL_A),
      ],
      contexts,
    });
    const a = result.rivals.find((r) => r.companyId === RIVAL_A)!;
    expect(a.displacedResponses).toBe(2);
  });

  it("breaks displacement down by provider and real-estate dimension, counts reconciling", () => {
    const { responses, contexts } = baseFixture();
    const mentions = [
      mention("r1", RIVAL_A, { listPosition: 1 }), // google, the heights
      mention("r2", RIVAL_A, { listPosition: 3 }), // openai, paulus hook
      mention("r3", RIVAL_A), // google, the heights
    ];
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    const a = result.rivals.find((r) => r.companyId === RIVAL_A)!;
    const providerTotal = a.byProvider.reduce((s, row) => s + row.count, 0);
    expect(providerTotal).toBe(a.displacedResponses);
    expect(a.byProvider).toEqual([
      { segment: "google", count: 2 },
      { segment: "openai", count: 1 },
    ]);
    expect(a.byDimension.neighborhood).toEqual([
      { segment: "the heights", count: 2 },
      { segment: "paulus hook", count: 1 },
    ]);
    expect(a.byDimension.property_type).toEqual([{ segment: "condo", count: 3 }]);
    expect(a.meanListPosition).toBe(2);
  });

  it("keeps language associative — observations count, the explanation never claims cause", () => {
    const { responses, contexts } = baseFixture();
    const result = computeDisplacement({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions: [mention("r1", RIVAL_A), mention("r2", RIVAL_A)],
      contexts,
    });
    expect(result.explanation).toMatch(/not a proven cause/);
  });
});
