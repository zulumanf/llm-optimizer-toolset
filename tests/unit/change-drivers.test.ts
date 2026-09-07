/**
 * Visibility change drivers (spec 087, P1): the decomposition reconciles to
 * the mention rows, small wiggles stay out, and every emitted sentence
 * survives the causal-language gate — drivers describe what moved together,
 * never what caused what.
 */
import { describe, it, expect } from "vitest";
import {
  computeChangeDrivers,
  CHANGE_DRIVERS_VERSION,
  DRIVER_MIN_DELTA,
} from "@/lib/reports/drivers";
import { findCausalPhrase } from "@/lib/workflow/gates";
import type { RunMentionRow, ValidResponseRow } from "@/db/displacement";
import type { FrozenPrompt } from "@/lib/prompts/types";

const SUBJECT = "subject-co";

const prompts: FrozenPrompt[] = Array.from({ length: 6 }, (_, i) => ({
  promptId: `p${i}`,
  text: i < 3 ? `best luxury condo listing agent ${i}` : `waterfront seller agent ${i}`,
  category: "recommendation",
  language: "en",
  position: i + 1,
}));

function side(runTag: string, recommendedOn: number[], rivalNames: string[] = []) {
  const responses: ValidResponseRow[] = prompts.map((p, i) => ({
    id: `${runTag}-r${i}`,
    provider: i % 2 === 0 ? "openai" : "google",
    promptId: p.promptId,
  }));
  const mentions: RunMentionRow[] = [
    ...recommendedOn.map((i) => ({
      responseId: `${runTag}-r${i}`,
      companyId: SUBJECT,
      companyName: SUBJECT,
      mentioned: true,
      recommended: true,
      listPosition: null,
      promptEchoed: false,
    })),
    ...rivalNames.map((name, i) => ({
      responseId: `${runTag}-r${i}`,
      companyId: `rival-${name}`,
      companyName: name,
      mentioned: true,
      recommended: true,
      listPosition: null,
      promptEchoed: false,
    })),
  ];
  return { responses, mentions };
}

describe("computeChangeDrivers", () => {
  it("decomposes the recommendation delta by provider and reports new domains/rivals", () => {
    const result = computeChangeDrivers({
      previousRunId: "prev",
      currentRunId: "curr",
      subjectCompanyId: SUBJECT,
      frozenPrompts: prompts,
      previous: side("prev", [0]),
      current: side("curr", [0, 2, 4], ["Team X"]),
      previousDomains: new Set(["zillow.com"]),
      currentDomains: new Set(["zillow.com", "jerseydigs.com"]),
      interventionsBetween: [
        { id: "i1", title: "99 Hudson authority page", shippedAt: "2026-08-01" },
      ],
    });
    expect(result.version).toBe(CHANGE_DRIVERS_VERSION);
    expect(result.status).toBe("ok");
    expect(result.previousRecommended).toBe(1);
    expect(result.currentRecommended).toBe(3);
    // 0/2/4 are all openai rows: +2 clears DRIVER_MIN_DELTA; google stays 0.
    expect(DRIVER_MIN_DELTA).toBe(2);
    expect(result.byProvider).toEqual([
      { segment: "openai", previous: 1, current: 3, delta: 2 },
    ]);
    expect(result.newDomains).toEqual(["jerseydigs.com"]);
    expect(result.newRivals).toEqual(["Team X"]);
    expect(result.interventionsBetween).toHaveLength(1);
  });

  it("sub-threshold wiggles never become drivers", () => {
    const result = computeChangeDrivers({
      previousRunId: "prev",
      currentRunId: "curr",
      subjectCompanyId: SUBJECT,
      frozenPrompts: prompts,
      previous: side("prev", [0]),
      current: side("curr", [0, 2]),
      previousDomains: new Set(),
      currentDomains: new Set(),
      interventionsBetween: [],
    });
    expect(result.byProvider).toEqual([]);
    expect(result.byCluster).toEqual([]);
  });

  it("every observation survives the causal-language gate", () => {
    const result = computeChangeDrivers({
      previousRunId: "prev",
      currentRunId: "curr",
      subjectCompanyId: SUBJECT,
      frozenPrompts: prompts,
      previous: side("prev", []),
      current: side("curr", [0, 2, 4], ["Team X"]),
      previousDomains: new Set(),
      currentDomains: new Set(["jerseydigs.com"]),
      interventionsBetween: [
        { id: "i1", title: "Local publication coverage", shippedAt: "2026-08-01" },
      ],
    });
    for (const sentence of result.observations) {
      expect(findCausalPhrase(sentence), sentence).toBeNull();
    }
  });
});
