/**
 * Spec 036 — head-to-head verdict table and aggregation, hand-computed.
 */
import { describe, expect, it } from "vitest";
import {
  computeHeadToHead,
  contestOutcome,
  HEAD_TO_HEAD_VERSION,
} from "@/lib/competitors/head-to-head";

const SELF = "s0000000-0000-4000-8000-000000000001";
const COMP = "c0000000-0000-4000-8000-000000000001";

describe("contestOutcome — the verdict table", () => {
  const m = (mentioned: boolean, listPosition: number | null) => ({
    mentioned,
    listPosition,
  });

  it("covers every row of the definition", () => {
    expect(contestOutcome(m(false, null), m(false, null))).toBe("uncontested");
    expect(contestOutcome(m(true, null), m(false, null))).toBe("self_win");
    expect(contestOutcome(m(false, null), m(true, 1))).toBe("competitor_win");
    expect(contestOutcome(m(true, 1), m(true, 3))).toBe("self_win");
    expect(contestOutcome(m(true, 3), m(true, 1))).toBe("competitor_win");
    expect(contestOutcome(m(true, 2), m(true, 2))).toBe("tie");
    // Unranked co-mention is a tie, not a loss — in both directions.
    expect(contestOutcome(m(true, null), m(true, 1))).toBe("tie");
    expect(contestOutcome(m(true, 1), m(true, null))).toBe("tie");
  });
});

describe("computeHeadToHead", () => {
  const responses = [
    { responseId: "r1", promptId: "p1", promptText: "Best CRM?" },
    { responseId: "r2", promptId: "p2", promptText: "Top tools?" },
    { responseId: "r3", promptId: "p3", promptText: "Who should we hire?" },
    { responseId: "r4", promptId: "p4", promptText: "Anything else?" },
  ];
  const mention = (
    responseId: string,
    companyId: string,
    listPosition: number | null,
    mentioned = true
  ) => ({ responseId, companyId, mentioned, listPosition });

  it("aggregates hand-computed wins, losses, ties, and losing prompts", () => {
    const result = computeHeadToHead({
      selfId: SELF,
      competitors: [{ companyId: COMP, companyName: "Rival" }],
      responses,
      mentions: [
        mention("r1", SELF, 1), mention("r1", COMP, 2),   // self win (rank)
        mention("r2", COMP, 1),                            // competitor win (absent self)
        mention("r3", SELF, null), mention("r3", COMP, 1), // tie (unranked co-mention)
        // r4: neither → uncontested
      ],
    });
    expect(result.version).toBe(HEAD_TO_HEAD_VERSION);
    const [row] = result.rows;
    expect(row).toMatchObject({
      contested: 3,
      selfWins: 1,
      competitorWins: 1,
      ties: 1,
    });
    expect(row!.winRate).toBeCloseTo(1 / 3);
    expect(row!.losingPrompts).toEqual(["Top tools?"]);
  });

  it("win rate is null, never zero, when nothing is contested", () => {
    const result = computeHeadToHead({
      selfId: SELF,
      competitors: [{ companyId: COMP, companyName: "Rival" }],
      responses,
      mentions: [],
    });
    expect(result.rows[0]?.winRate).toBeNull();
    expect(result.rows[0]?.contested).toBe(0);
  });

  it("a mention row with mentioned=false is absence, not presence", () => {
    const result = computeHeadToHead({
      selfId: SELF,
      competitors: [{ companyId: COMP, companyName: "Rival" }],
      responses: [responses[0]!],
      mentions: [
        mention("r1", SELF, null, false), // retraction revision
        mention("r1", COMP, 1),
      ],
    });
    expect(result.rows[0]?.competitorWins).toBe(1);
  });

  it("dedupes losing prompts across repetitions of the same prompt", () => {
    const reps = [
      { responseId: "r1", promptId: "p1", promptText: "Best CRM?" },
      { responseId: "r2", promptId: "p1", promptText: "Best CRM?" },
    ];
    const result = computeHeadToHead({
      selfId: SELF,
      competitors: [{ companyId: COMP, companyName: "Rival" }],
      responses: reps,
      mentions: [mention("r1", COMP, 1), mention("r2", COMP, 1)],
    });
    expect(result.rows[0]?.competitorWins).toBe(2);
    expect(result.rows[0]?.losingPrompts).toEqual(["Best CRM?"]);
  });
});
