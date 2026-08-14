/**
 * Intervention lifecycle (spec 062): the transition map is the contract the
 * service, the sync, and the migration backfill all lean on — every edge is
 * pinned here, both directions.
 */
import { describe, expect, it } from "vitest";
import {
  INTERVENTION_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
  deriveObservedStatus,
  type InterventionStatus,
} from "@/lib/attribution/lifecycle";

describe("canTransition", () => {
  it("allows the forward path shipped → retest_pending → retested", () => {
    expect(canTransition("shipped", "retest_pending")).toBe(true);
    expect(canTransition("retest_pending", "retested")).toBe(true);
  });

  it("allows the forward jump shipped → retested (reality can outrun the sync)", () => {
    expect(canTransition("shipped", "retested")).toBe(true);
  });

  it("allows retest_pending → shipped (an emptied schedule must not lie)", () => {
    expect(canTransition("retest_pending", "shipped")).toBe(true);
  });

  it("never leaves retested", () => {
    expect(canTransition("retested", "retest_pending")).toBe(false);
    expect(canTransition("retested", "shipped")).toBe(false);
  });

  it("blocks from any active state, with human-only resolution to any state", () => {
    expect(canTransition("shipped", "blocked")).toBe(true);
    expect(canTransition("retest_pending", "blocked")).toBe(true);
    expect(canTransition("blocked", "shipped")).toBe(true);
    expect(canTransition("blocked", "retest_pending")).toBe(true);
    expect(canTransition("blocked", "retested")).toBe(true);
    expect(canTransition("blocked", "cancelled")).toBe(true);
  });

  it("cancels from any non-terminal state", () => {
    expect(canTransition("shipped", "cancelled")).toBe(true);
    expect(canTransition("retest_pending", "cancelled")).toBe(true);
    expect(canTransition("blocked", "cancelled")).toBe(true);
  });

  it("terminal states never leave, and self-transitions are refused", () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const to of INTERVENTION_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
    for (const status of INTERVENTION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("cannot block or re-block a finished measurement", () => {
    expect(canTransition("retested", "blocked")).toBe(false);
    expect(canTransition("cancelled", "blocked")).toBe(false);
  });
});

describe("deriveObservedStatus", () => {
  it("a completed post run means retested, whatever else is pending", () => {
    expect(
      deriveObservedStatus({ hasCompletedPost: true, hasPendingPost: true })
    ).toBe("retested");
    expect(
      deriveObservedStatus({ hasCompletedPost: true, hasPendingPost: false })
    ).toBe("retested");
  });

  it("a scheduled or started post run means retest_pending", () => {
    expect(
      deriveObservedStatus({ hasCompletedPost: false, hasPendingPost: true })
    ).toBe("retest_pending");
  });

  it("nothing scheduled means shipped", () => {
    expect(
      deriveObservedStatus({ hasCompletedPost: false, hasPendingPost: false })
    ).toBe("shipped");
  });

  it("every derived status is reachable from every active status (the sync can never strand a row)", () => {
    const active: InterventionStatus[] = ["shipped", "retest_pending", "blocked"];
    const derivable: InterventionStatus[] = ["shipped", "retest_pending", "retested"];
    for (const from of active) {
      for (const to of derivable) {
        expect(from === to || canTransition(from, to)).toBe(true);
      }
    }
  });
});
