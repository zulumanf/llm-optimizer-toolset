/**
 * Spec 137 — lane modes, the explicit state machine (tests 29–33 at the
 * pure layer), canary determinism, send-intent identity, operator view.
 */
import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  canaryBucket,
  conceptualState,
  operatorView,
  releaseDecision,
  resolveLaneConfig,
  sendIntentKey,
  sendMessageIdFor,
  senderDomainOf,
  HANDOFF_STATUSES,
  LANE_TRANSITIONS,
} from "@/lib/prospects/fulfillment-lane";

describe("state machine", () => {
  it("29: no direct transition from the reply to SENT; every status has an explicit row", () => {
    expect(canTransition("pending", "sent")).toBe(false);
    expect(() => assertTransition("pending", "sent")).toThrow(/Invalid fulfillment transition pending → sent/);
    expect(canTransition("autonomy_eligible", "scheduled")).toBe(false);
    expect(canTransition("evidence_verified", "sent")).toBe(false);
    for (const s of HANDOFF_STATUSES) expect(Array.isArray(LANE_TRANSITIONS[s])).toBe(true);
  });
  it("30: a blocked (needs_review) handoff cannot progress to release; 31: it leaves only by explicit reactivation to the eligibility check, or a stop", () => {
    expect(LANE_TRANSITIONS.needs_review).toEqual(["autonomy_eligible", "stopped"]);
    expect(canTransition("needs_review", "release_ready")).toBe(false);
    expect(canTransition("needs_review", "scheduled")).toBe(false);
  });
  it("32: terminal states have no exits", () => {
    expect(LANE_TRANSITIONS.stopped).toEqual([]);
    expect(LANE_TRANSITIONS.sent).toEqual([]);
  });
  it("the happy path is exactly the documented chain", () => {
    const chain = ["pending", "autonomy_eligible", "evidence_verified", "report_published", "qa_passed", "release_ready", "scheduled", "sent"] as const;
    for (let i = 0; i < chain.length - 1; i++) expect(canTransition(chain[i]!, chain[i + 1]!)).toBe(true);
    expect(conceptualState({ status: "release_ready", autoVerdict: "would_send", reason: null })).toBe("RELEASE_READY_SHADOW_HELD");
    expect(conceptualState({ status: "needs_review", autoVerdict: "blocked", reason: "EVIDENCE_RELEASE_BLOCKED: x" })).toBe("EVIDENCE_BLOCKED");
    expect(conceptualState({ status: "needs_review", autoVerdict: "escalated", reason: "ESCALATED_TO_FOUNDER: pricing" })).toBe("ESCALATED_TO_FOUNDER");
  });
});

describe("lane modes", () => {
  it("release policy defaults to report_and_video; report_only must be explicit; garbage falls back closed", () => {
    expect(resolveLaneConfig({}).releasePolicy).toBe("report_and_video");
    expect(resolveLaneConfig({ FULFILLMENT_RELEASE_POLICY: "report_only" }).releasePolicy).toBe("report_only");
    expect(resolveLaneConfig({ FULFILLMENT_RELEASE_POLICY: "video_only" }).releasePolicy).toBe("report_and_video");
    expect(canTransition("release_ready", "qa_passed")).toBe(true);
    expect(conceptualState({ status: "qa_passed", autoVerdict: "held", reason: "WAITING_FOR_VIDEO: no video artifact" })).toBe("REPORT_READY_WAITING_FOR_VIDEO");
  });
  it("defaults to SHADOW; the legacy spec 129 opt-in maps to NARROW_AUTONOMOUS; explicit mode wins", () => {
    expect(resolveLaneConfig({}).mode).toBe("SHADOW");
    expect(resolveLaneConfig({ REPORT_HANDOFF_AUTOSEND: "true" }).mode).toBe("NARROW_AUTONOMOUS");
    expect(resolveLaneConfig({ REPORT_HANDOFF_AUTOSEND: "true", AUTONOMOUS_POSITIVE_REPLY_MODE: "shadow" }).mode).toBe("SHADOW");
    expect(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_MODE: "bogus" }).mode).toBe("SHADOW");
    expect(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT: "250" }).canaryPercent).toBe(100);
    expect(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT: "x" }).canaryPercent).toBe(10);
  });
  it("SHADOW records would_send and never transmits; the kill switch holds in every mode", () => {
    expect(releaseDecision(resolveLaneConfig({}), "h1")).toMatchObject({ action: "hold_shadow", autoVerdict: "would_send" });
    expect(releaseDecision(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_MODE: "NARROW_AUTONOMOUS", AUTONOMOUS_POSITIVE_REPLY_KILL_SWITCH: "true" }), "h1")).toMatchObject({ action: "hold_shadow" });
    expect(releaseDecision(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_MODE: "NARROW_AUTONOMOUS" }), "h1")).toMatchObject({ action: "transmit", autoVerdict: "transmit" });
    expect(releaseDecision(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_MODE: "MANUAL_ONLY" }), "h1")).toMatchObject({ action: "manual_only", autoVerdict: "escalated" });
  });
  it("CANARY is a deterministic percentage bucket per handoff", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (const id of ids) expect(canaryBucket(id)).toBe(canaryBucket(id));
    const at20 = ids.filter((id) => releaseDecision(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_MODE: "CANARY", AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT: "20" }), id).action === "transmit").length;
    expect(at20).toBeGreaterThan(20);
    expect(at20).toBeLessThan(80);
    const at0 = ids.filter((id) => releaseDecision(resolveLaneConfig({ AUTONOMOUS_POSITIVE_REPLY_MODE: "CANARY", AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT: "0" }), id).action === "transmit").length;
    expect(at0).toBe(0);
  });
});

describe("send intent identity", () => {
  it("one logical action = one key; a new manifest version is a new identity", () => {
    const base = { prospectId: "p", replyId: "r", manifestHash: "m1", messageType: "positive_reply_report_delivery" as const, templateVersion: "v2" };
    expect(sendIntentKey(base)).toBe(sendIntentKey({ ...base }));
    expect(sendIntentKey({ ...base, manifestHash: "m2" })).not.toBe(sendIntentKey(base));
    expect(sendMessageIdFor(sendIntentKey(base), "recommendedfirst.com")).toMatch(/^<rf-[0-9a-f]{32}@recommendedfirst\.com>$/);
    expect(senderDomainOf("francisco@recommendedfirst.com")).toBe("recommendedfirst.com");
    expect(senderDomainOf(null)).toBe("recommendedfirst.com");
  });
});

describe("operator view", () => {
  it("says why automation stopped and what to do next, without logs", () => {
    const v = operatorView(
      { status: "needs_review", reason: "ESCALATED_TO_FOUNDER: pricing or cost language", autonomyClass: "escalate", autonomyReason: "pricing or cost language", autoVerdict: "escalated", laneMode: "SHADOW", releaseVerdict: null },
      { prospectName: "Blu House Properties", replyExcerpt: "Yes, how much?", reportPublished: false }
    );
    expect(v).toMatchObject({ state: "ESCALATED_TO_FOUNDER", whyStopped: "ESCALATED_TO_FOUNDER: pricing or cost language", reportStatus: "not published", videoStatus: "not part of this release policy" });
    expect(v.nextAction).toMatch(/by hand/);
    const held = operatorView({ status: "release_ready", reason: "SHADOW: all gates passed; would have sent", autonomyClass: "autonomy_eligible", autonomyReason: null, autoVerdict: "would_send", laneMode: "SHADOW", releaseVerdict: { verified: true } }, { prospectName: "x", replyExcerpt: "Yes", reportPublished: true });
    expect(held.evidenceStatus).toBe("verified (primary = shadow)");
    expect(held.nextAction).toMatch(/SHADOW/);
  });
});

describe("per-handoff release policy exception (migration 114)", () => {
  it("a recorded report_only override wins over the global report_and_video policy; anything else falls back to the global policy; autonomy is untouched", async () => {
    const { effectiveReleasePolicy, resolveLaneConfig } = await import("@/lib/prospects/fulfillment-lane");
    const cfg = resolveLaneConfig({});
    expect(cfg.releasePolicy).toBe("report_and_video");
    expect(effectiveReleasePolicy(cfg, "report_only")).toBe("report_only");
    expect(effectiveReleasePolicy(cfg, "report_and_video")).toBe("report_and_video");
    expect(effectiveReleasePolicy(cfg, null)).toBe("report_and_video");
    expect(effectiveReleasePolicy(cfg, "anything")).toBe("report_and_video");
    expect(effectiveReleasePolicy(resolveLaneConfig({ FULFILLMENT_RELEASE_POLICY: "report_only" }), null)).toBe("report_only");
    expect(cfg.mode).toBe("SHADOW");
  });
});
