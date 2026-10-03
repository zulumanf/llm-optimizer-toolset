/**
 * Spec 147 slice 6 — the pure reconciliation decision and the open-status
 * definition.
 */
import { describe, expect, it } from "vitest";
import { reconciliationDecision, type ReconcileSnapshot } from "@/lib/profile-corrections/reconcile-decision";
import {
  OPEN_CORRECTION_STATUSES,
  REROUTABLE_CORRECTION_STATUSES,
  STOPPED_RUN_STATES,
  WITHDRAWABLE_CORRECTION_STATUSES,
} from "@/lib/profile-corrections/constants";

const NOW = new Date("2026-10-10T12:00:00Z");
const base: ReconcileSnapshot = {
  status: "awaiting_approval",
  contentRunState: "waiting_for_approval",
  contentApprovalDecision: null,
  routedAt: null,
  externalRunState: null,
  draftRunState: null,
  draftAttemptStatus: null,
  recheckRowStatus: null,
  recheckRunState: null,
  hasRecheckResult: false,
};
const decide = (s: Partial<ReconcileSnapshot>) => reconciliationDecision({ ...base, ...s }, NOW, 15);

describe("open statuses", () => {
  it("protects exactly the in-flight states and frees every terminal one", () => {
    expect([...OPEN_CORRECTION_STATUSES]).toEqual([
      "awaiting_approval",
      "approved",
      "destination_required",
      "awaiting_external_approval",
      "ready_to_draft",
      "awaiting_send_confirmation",
      "sent",
    ]);
    for (const closed of ["rejected", "expired", "withdrawn", "corrected", "still_incorrect", "needs_review", "unreachable"]) {
      expect(OPEN_CORRECTION_STATUSES as readonly string[]).not.toContain(closed);
    }
    // Withdrawal is possible everywhere nothing has been confirmed sent.
    expect(WITHDRAWABLE_CORRECTION_STATUSES as readonly string[]).not.toContain("sent");
    expect(REROUTABLE_CORRECTION_STATUSES as readonly string[]).not.toContain("awaiting_send_confirmation");
  });
});

describe("reconciliationDecision", () => {
  it("content approval: timed out or stopped → expired; rejected → rejected; waiting → untouched", () => {
    for (const state of STOPPED_RUN_STATES) {
      expect(decide({ contentRunState: state })).toMatchObject({ action: "move", to: "expired" });
    }
    expect(decide({ contentRunState: "safely_stopped", contentApprovalDecision: "rejected" })).toMatchObject({
      action: "move",
      to: "rejected",
    });
    expect(decide({ contentRunState: "waiting_for_approval" })).toEqual({ action: "none" });
    expect(decide({ contentRunState: "running" })).toEqual({ action: "none" });
  });

  it("approved but never routed: stopped → expired; running → untouched", () => {
    expect(decide({ status: "approved", contentRunState: "failed" })).toMatchObject({ to: "expired" });
    expect(decide({ status: "approved", contentRunState: "running" })).toEqual({ action: "none" });
  });

  it("publisher approval: stopped or never started → destination_required, never ready", () => {
    expect(decide({ status: "awaiting_external_approval", externalRunState: "safely_stopped" })).toMatchObject({
      to: "destination_required",
    });
    expect(
      decide({ status: "awaiting_external_approval", externalRunState: null, routedAt: new Date(NOW.getTime() - 16 * 60_000) })
    ).toMatchObject({ to: "destination_required", reason: "external_submission_run_never_started" });
    expect(
      decide({ status: "awaiting_external_approval", externalRunState: null, routedAt: new Date(NOW.getTime() - 5 * 60_000) })
    ).toEqual({ action: "none" });
    expect(decide({ status: "awaiting_external_approval", externalRunState: "waiting_for_approval" })).toEqual({ action: "none" });
  });

  it("send confirmation: stopped → ready_to_draft with the draft's outcome unknown, never sent", () => {
    const d = decide({ status: "awaiting_send_confirmation", draftRunState: "safely_stopped", draftAttemptStatus: "created" });
    expect(d).toMatchObject({ action: "move", to: "ready_to_draft", draftOutcomeUnknown: true });
    expect(decide({ status: "awaiting_send_confirmation", draftRunState: "waiting_for_approval" })).toEqual({ action: "none" });
  });

  it("recheck: a stopped run or an unreleasable row → needs_review, never corrected", () => {
    expect(
      decide({ status: "sent", recheckRowStatus: "released", recheckRunState: "safely_stopped" })
    ).toMatchObject({ to: "needs_review", failRecheckRow: true });
    for (const row of ["failed", "skipped", null]) {
      expect(decide({ status: "sent", recheckRowStatus: row })).toMatchObject({ to: "needs_review" });
    }
    expect(decide({ status: "sent", recheckRowStatus: "queued" })).toEqual({ action: "none" });
    expect(decide({ status: "sent", recheckRowStatus: "released", recheckRunState: "running" })).toEqual({ action: "none" });
    expect(decide({ status: "sent", recheckRowStatus: "released", recheckRunState: "safely_stopped", hasRecheckResult: true })).toEqual({
      action: "none",
    });
  });

  it("never moves a healthy or terminal request, and reports anomalies instead of resolving them", () => {
    for (const status of ["destination_required", "ready_to_draft", "rejected", "expired", "withdrawn", "corrected", "needs_review"]) {
      expect(decide({ status, contentRunState: "failed" })).toEqual({ action: "none" });
    }
    expect(decide({ contentRunState: "completed" })).toMatchObject({ action: "anomaly" });
    const all = [
      decide({ contentRunState: "failed" }),
      decide({ status: "awaiting_external_approval", externalRunState: "failed" }),
      decide({ status: "awaiting_send_confirmation", draftRunState: "failed" }),
      decide({ status: "sent", recheckRowStatus: "failed" }),
    ];
    for (const d of all) {
      expect(d.action === "move" && ["sent", "corrected", "approved"].includes(d.to)).toBe(false);
    }
  });
});
