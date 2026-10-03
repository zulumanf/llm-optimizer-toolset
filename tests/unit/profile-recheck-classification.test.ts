/**
 * Spec 147 slice 5 — the deterministic recheck classification. Pure.
 */
import { describe, expect, it } from "vitest";
import {
  RECHECK_ITEM_REASON,
  classifyProfileRecheck,
  overallRecheckResult,
  recheckResultHash,
} from "@/lib/profile-corrections/recheck";
import type { ProfileCorrectionRequest } from "@/lib/profile-corrections/request";

const A_BROKER = "a0000000-0000-4000-8000-000000000001";
const A_SALES = "a0000000-0000-4000-8000-000000000003";
const A_LICENSE = "a0000000-0000-4000-8000-000000000002";
const E1 = "e0000000-0000-4000-8000-000000000001";

const request: ProfileCorrectionRequest = {
  version: "profile-correction-request-v1",
  projectId: "11111111-1111-4111-8111-111111111111",
  workflowRunId: "33333333-3333-4333-8333-333333333333",
  profileUrl: "https://www.zillow.com/profile/ana-perez",
  beforeSourceArtifactId: "44444444-4444-4444-8444-444444444444",
  beforeSha256: "a".repeat(64),
  evidencePacketId: "55555555-5555-4555-8555-555555555555",
  items: [
    {
      observedClaimId: "obs-broker",
      approvedClaimId: A_BROKER,
      approvedClaimKey: "brokerage",
      observedStatement: "Ana Perez is affiliated with Compass.",
      pageWording: "Ana Perez is an agent with Compass in Jersey City.",
      approvedStatement: "Ana Perez is affiliated with Douglas Elliman.",
      approvedAsOf: null,
      severity: "critical",
      evidenceIds: [E1],
    },
    {
      observedClaimId: "obs-sales",
      approvedClaimId: A_SALES,
      approvedClaimKey: "sales.2025.count",
      observedStatement: "Ana Perez closed 40 homes in 2025.",
      pageWording: "Closed 40 homes in 2025",
      approvedStatement: "Ana Perez closed 42 homes in 2025.",
      approvedAsOf: null,
      severity: "high",
      evidenceIds: [E1],
    },
  ],
  evidenceIds: [E1],
  maxSeverity: "critical",
};

const APPROVED = {
  packetId: "66666666-6666-4666-8666-666666666666",
  claims: [
    { id: A_BROKER, key: "brokerage", text: "Ana Perez is affiliated with Douglas Elliman." },
    { id: A_SALES, key: "sales.2025.count", text: "Ana Perez closed 42 homes in 2025." },
    { id: A_LICENSE, key: "license.nj", text: "Ana Perez holds NJ license 7654321." },
  ],
};

/** A matched observation that restates an approved fact (spec 145E). */
const affirm = (id: string, text: string) => ({
  claimId: id,
  existingStatus: "approved",
  originalWording: text,
  normalizedWording: text,
});
const observe = (id: string, original: string, normalized = original) => ({
  claimId: id,
  originalWording: original,
  normalizedWording: normalized,
});
const pair = (o: string, a: string, statementA: string, statementB: string, severity = "high") => ({
  observedClaimId: o,
  approvedClaimId: a,
  statementA,
  statementB,
  severity,
  explanation: "model prose",
});

function changed(observedClaims: unknown[], contradictions: unknown[], approvedFacts: unknown = APPROVED) {
  return classifyProfileRecheck({
    request,
    pageState: "changed",
    observedClaims,
    approvedFacts,
    compare: { contradictions, confidence: 0.9 },
  });
}

const BROKER_FIXED = affirm(A_BROKER, "Ana Perez is affiliated with Douglas Elliman.");
const SALES_FIXED = affirm(A_SALES, "Ana Perez closed 42 homes in 2025.");

describe("fast paths (no comparison)", () => {
  it("unreachable → every item unreachable", () => {
    const r = classifyProfileRecheck({ request, pageState: "unreachable" });
    expect(r.result).toBe("unreachable");
    expect(r.items.map((i) => [i.approvedClaimKey, i.status])).toEqual([
      ["brokerage", "unreachable"],
      ["sales.2025.count", "unreachable"],
    ]);
  });
  it("unchanged → still_incorrect", () => {
    const r = classifyProfileRecheck({ request, pageState: "unchanged" });
    expect(r.result).toBe("still_incorrect");
    expect(r.items.every((i) => i.status === "still_incorrect" && i.reason === RECHECK_ITEM_REASON.unchanged)).toBe(true);
  });
  it("previously seen → needs_review", () => {
    const r = classifyProfileRecheck({ request, pageState: "previously_seen" });
    expect(r.result).toBe("needs_review");
  });
});

describe("changed page", () => {
  it("corrected: the error is gone and the page restates each approved fact", () => {
    const r = changed([BROKER_FIXED, SALES_FIXED], []);
    expect(r.result).toBe("corrected");
    expect(r.items.map((i) => [i.status, i.reason])).toEqual([
      ["corrected", RECHECK_ITEM_REASON.affirmed],
      ["corrected", RECHECK_ITEM_REASON.affirmed],
    ]);
  });

  it("still_incorrect: the same validated contradiction remains", () => {
    const obs = observe("obs-new", "Ana Perez is an agent with Compass in Jersey City.", "Ana Perez is affiliated with Compass.");
    const r = changed([obs, SALES_FIXED], [pair("obs-new", A_BROKER, "Ana Perez is affiliated with Compass.", APPROVED.claims[0]!.text)]);
    expect(r.items[0]).toMatchObject({ status: "still_incorrect", currentObservedClaimId: "obs-new" });
    expect(r.result).toBe("still_incorrect");
  });

  it("needs_review: contradicted with other wording", () => {
    const obs = observe("obs-x", "Ana Perez joined Redfin.", "Ana Perez is affiliated with Redfin.");
    const r = changed([obs, SALES_FIXED], [pair("obs-x", A_BROKER, "Ana Perez is affiliated with Redfin.", APPROVED.claims[0]!.text)]);
    expect(r.items[0]).toMatchObject({ status: "needs_review", reason: RECHECK_ITEM_REASON.differentContradiction });
    expect(r.result).toBe("needs_review");
  });

  it("needs_review, never corrected, when the error is merely absent", () => {
    const r = changed([], []);
    expect(r.items.every((i) => i.status === "needs_review" && i.reason === RECHECK_ITEM_REASON.notAffirmed)).toBe(true);
    expect(r.result).toBe("needs_review");
  });

  it("needs_review when the wrong wording is still on the page but unflagged", () => {
    const lingering = observe("obs-l", "Closed 40 homes in 2025");
    const r = changed([BROKER_FIXED, lingering], []);
    expect(r.items[1]).toMatchObject({ status: "needs_review", reason: RECHECK_ITEM_REASON.wordingStillPresent });
  });

  it("needs_review when the approved fact itself is gone", () => {
    const facts = { ...APPROVED, claims: APPROVED.claims.filter((c) => c.id !== A_SALES) };
    const r = changed([BROKER_FIXED], [], facts);
    expect(r.items[1]).toMatchObject({ status: "needs_review", reason: RECHECK_ITEM_REASON.factGone });
  });

  it("a comparison that does not validate never yields corrected", () => {
    for (const compare of [
      undefined,
      { contradictions: [pair("obs-ghost", A_BROKER, "fabricated", APPROVED.claims[0]!.text)], confidence: 0.9 },
      { confidence: 0.9 },
      "not json",
    ]) {
      const r = classifyProfileRecheck({ request, pageState: "changed", observedClaims: [BROKER_FIXED, SALES_FIXED], approvedFacts: APPROVED, compare });
      expect(r.result).toBe("needs_review");
      expect(r.items.every((i) => i.reason === RECHECK_ITEM_REASON.comparisonInvalid)).toBe(true);
    }
    // A missing context is not success either.
    const noContext = classifyProfileRecheck({ request, pageState: "changed", compare: { contradictions: [], confidence: 1 } });
    expect(noContext.result).toBe("needs_review");
  });

  it("a new contradiction on another approved fact turns a corrected result into needs_review", () => {
    const lic = observe("obs-lic", "License 1111111", "Ana Perez holds NJ license 1111111.");
    const r = changed(
      [BROKER_FIXED, SALES_FIXED, lic],
      [pair("obs-lic", A_LICENSE, "Ana Perez holds NJ license 1111111.", APPROVED.claims[2]!.text, "critical")]
    );
    expect(r.items.every((i) => i.status === "corrected")).toBe(true);
    expect(r.newContradictions).toEqual([
      { observedClaimId: "obs-lic", approvedClaimId: A_LICENSE, statementA: "Ana Perez holds NJ license 1111111.", severity: "critical" },
    ]);
    expect(r.result).toBe("needs_review");
  });
});

describe("overall result and hashing", () => {
  it("uses the explicit priority: unreachable > still_incorrect > needs_review > corrected", () => {
    expect(overallRecheckResult([{ status: "corrected" }, { status: "corrected" }])).toBe("corrected");
    expect(overallRecheckResult([{ status: "corrected" }, { status: "still_incorrect" }])).toBe("still_incorrect");
    expect(overallRecheckResult([{ status: "needs_review" }, { status: "still_incorrect" }])).toBe("still_incorrect");
    expect(overallRecheckResult([{ status: "corrected" }, { status: "needs_review" }])).toBe("needs_review");
    expect(overallRecheckResult([{ status: "unreachable" }, { status: "still_incorrect" }])).toBe("unreachable");
    expect(overallRecheckResult([{ status: "corrected" }], 1)).toBe("needs_review");
  });

  it("orders items by the request and hashes deterministically", () => {
    const a = changed([SALES_FIXED, BROKER_FIXED], []);
    const b = changed([BROKER_FIXED, SALES_FIXED], []);
    expect(a.items.map((i) => i.approvedClaimKey)).toEqual(["brokerage", "sales.2025.count"]);
    expect(recheckResultHash(a)).toBe(recheckResultHash(b));
    expect(recheckResultHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(recheckResultHash(a)).not.toBe(recheckResultHash(changed([BROKER_FIXED], [])));
    expect(a.version).toBe("profile-recheck-result-v1");
  });
});
