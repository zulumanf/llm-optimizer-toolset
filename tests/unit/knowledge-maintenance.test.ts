/**
 * Spec 025 — the pure parts: severity floors, window keys, retrieval scoring.
 *
 * The scoring tests carry the most weight. The asymmetry between recall (a
 * ratio with a floor) and forbidden items (a count with zero tolerance) is the
 * whole safety property of the evaluation suite, and it is exactly the kind of
 * rule that erodes silently if nothing asserts it.
 */
import { describe, expect, it } from "vitest";
import {
  effectiveSeverity,
  KIND_MIN_SEVERITY,
  KNOWLEDGE_EXCEPTION_KINDS,
} from "@/lib/knowledge/maintenance/exceptions";
import { dailyWindowKey, weeklyWindowKey } from "@/lib/knowledge/maintenance/service";
import {
  scoreFixture,
  summarize,
  type RetrievalFixture,
} from "@/lib/knowledge/maintenance/retrieval-eval";
import type { ContextPacket } from "@/lib/knowledge/context/builder";

describe("exception severity floors", () => {
  it("never lets a detector demote a kind below its floor", () => {
    // A privacy violation reported as "low" is a privacy violation nobody sees.
    expect(effectiveSeverity("privacy_violation", "low")).toBe("critical");
    expect(effectiveSeverity("wiki_canonical_drift", "medium")).toBe("critical");
    expect(effectiveSeverity("expired_claim", "low")).toBe("high");
  });

  it("lets a detector raise severity for a specific case", () => {
    expect(effectiveSeverity("stale_page", "medium")).toBe("medium");
    expect(effectiveSeverity("weak_evidence", "high")).toBe("high");
  });

  it("falls back to the floor when no severity is proposed", () => {
    expect(effectiveSeverity("unused_page")).toBe("low");
    expect(effectiveSeverity("page_hash_mismatch")).toBe("critical");
  });

  it("assigns a floor to every declared kind", () => {
    for (const kind of KNOWLEDGE_EXCEPTION_KINDS) {
      expect(KIND_MIN_SEVERITY[kind], kind).toBeDefined();
    }
  });

  it("treats the integrity failures as critical", () => {
    // These three mean the compiled layer is lying about canonical truth.
    for (const kind of ["page_hash_mismatch", "wiki_canonical_drift", "privacy_violation"] as const) {
      expect(KIND_MIN_SEVERITY[kind]).toBe("critical");
    }
  });
});

describe("maintenance window keys", () => {
  it("keys a day in UTC so every caller computes the same window", () => {
    expect(dailyWindowKey(new Date("2026-07-30T04:00:00Z"))).toBe("2026-07-30");
    expect(dailyWindowKey(new Date("2026-07-30T23:59:59Z"))).toBe("2026-07-30");
  });

  it("gives two callers minutes apart the same key", () => {
    const a = dailyWindowKey(new Date("2026-07-30T09:00:00Z"));
    const b = dailyWindowKey(new Date("2026-07-30T09:07:00Z"));
    expect(a).toBe(b);
  });

  it("uses ISO weeks, not rolling 7-day windows", () => {
    // A rolling window is not idempotent: every caller computes a different one.
    const monday = weeklyWindowKey(new Date("2026-07-27T00:00:00Z"));
    const friday = weeklyWindowKey(new Date("2026-07-31T23:00:00Z"));
    expect(monday).toBe(friday);
    expect(monday).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("rolls to a new key at the week boundary", () => {
    const thisWeek = weeklyWindowKey(new Date("2026-07-30T00:00:00Z"));
    const nextWeek = weeklyWindowKey(new Date("2026-08-05T00:00:00Z"));
    expect(thisWeek).not.toBe(nextWeek);
  });
});

// ------------------------------------------------------- retrieval scoring

function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    id: null,
    projectId: "p1",
    templateKey: "content_drafting",
    agentKey: "content_draft",
    taskObjective: "draft",
    audience: "public",
    items: [],
    missingContext: [],
    withheldClaimIds: [],
    requiredDisclaimers: [],
    tokenCount: 100,
    tokenBudget: 8000,
    freshness: "current",
    contentHash: "abc",
    expiresAt: new Date().toISOString(),
    builderVersion: "context-builder-v1",
    ...overrides,
  };
}

const fixture: RetrievalFixture = {
  key: "content-northvale",
  taskType: "content_drafting",
  description: "drafting packet for Northvale Demo",
  required: ["Jersey City", "40 transactions"],
  forbidden: ["Harbor Point private", "other-client-fact"],
};

describe("retrieval fixture scoring", () => {
  it("passes when every required fact is present and nothing forbidden is", () => {
    const score = scoreFixture(
      fixture,
      packet(),
      "Northvale Demo operates in Jersey City and closed 40 transactions in 2025."
    );
    expect(score.recall).toBe(1);
    expect(score.forbiddenPresent).toBe(0);
    expect(score.passed).toBe(true);
  });

  it("fails on a single forbidden item even with perfect recall", () => {
    // This is the asymmetry that matters: one leak is a breach, and averaging
    // it against successes would let it hide behind a good score.
    const score = scoreFixture(
      fixture,
      packet(),
      "Jersey City, 40 transactions, and also Harbor Point private notes."
    );
    expect(score.recall).toBe(1);
    expect(score.forbiddenPresent).toBe(1);
    expect(score.passed).toBe(false);
    expect(score.failures.join(" ")).toContain("FORBIDDEN");
  });

  it("fails when recall falls below the floor", () => {
    const score = scoreFixture(fixture, packet(), "Northvale Demo operates in Jersey City.");
    expect(score.recall).toBe(0.5);
    expect(score.passed).toBe(false);
    expect(score.failures.join(" ")).toContain("missing required");
  });

  it("counts items rendered only in packet metadata, not just prose", () => {
    // A fact carried as a structured item still reaches the agent.
    const score = scoreFixture(
      fixture,
      packet({
        items: [
          {
            itemType: "claim",
            itemRef: "40 transactions",
            label: "Jersey City",
            included: true,
          } as ContextPacket["items"][number],
        ],
      }),
      ""
    );
    expect(score.recall).toBe(1);
  });

  it("ignores excluded items — they never reach the agent", () => {
    const score = scoreFixture(
      fixture,
      packet({
        items: [
          {
            itemType: "claim",
            itemRef: "Harbor Point private",
            label: "withheld",
            included: false,
          } as ContextPacket["items"][number],
        ],
      }),
      "Jersey City, 40 transactions"
    );
    expect(score.forbiddenPresent).toBe(0);
    expect(score.passed).toBe(true);
  });

  it("fails a packet over its token budget", () => {
    const score = scoreFixture(
      { ...fixture, tokenBudget: 50 },
      packet({ tokenCount: 120 }),
      "Jersey City, 40 transactions"
    );
    expect(score.passed).toBe(false);
    expect(score.failures.join(" ")).toContain("token budget exceeded");
  });

  it("matches case-insensitively", () => {
    const score = scoreFixture(fixture, packet(), "jersey city — 40 TRANSACTIONS closed");
    expect(score.recall).toBe(1);
  });

  it("reports null recall rather than 1 when a fixture requires nothing", () => {
    const score = scoreFixture(
      { ...fixture, required: [] },
      packet(),
      "anything at all"
    );
    expect(score.recall).toBeNull();
    expect(score.passed).toBe(true);
  });
});

describe("suite summary", () => {
  it("flags any forbidden presence across the whole suite", () => {
    const clean = scoreFixture(fixture, packet(), "Jersey City 40 transactions");
    const leaky = scoreFixture(fixture, packet(), "Jersey City 40 transactions other-client-fact");
    const summary = summarize("knowledge-retrieval", [clean, leaky]);

    expect(summary.fixtures).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.anyForbiddenPresent).toBe(true);
    expect(summary.failures[0]?.fixtureKey).toBe("content-northvale");
  });

  it("returns null mean recall when nothing required anything", () => {
    const score = scoreFixture({ ...fixture, required: [] }, packet(), "x");
    expect(summarize("s", [score]).meanRecall).toBeNull();
  });
});
