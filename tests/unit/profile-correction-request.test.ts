/**
 * Spec 147 slice 2 — the deterministic correction request builder, its
 * validator, and the approval hash binding. Pure; known-answer fixtures.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildProfileCorrectionRequest,
  profileCorrectionRequestHash,
  validateProfileCorrectionRequest,
  type CorrectionAuthority,
  type CorrectionContext,
  type ProfileCorrectionRequest,
} from "@/lib/profile-corrections/request";
import { approvalBindingError } from "@/lib/profile-corrections/approval-binding";
import { canonicalJson } from "@/lib/prospects/fact-manifest";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";
const PACKET = "55555555-5555-4555-8555-555555555555";
const SHA = "a".repeat(64);
const URL_ = "https://www.zillow.com/profile/ana-perez";

const A_BROKER = "a0000000-0000-4000-8000-000000000001";
const A_LICENSE = "a0000000-0000-4000-8000-000000000002";
const A_SALES = "a0000000-0000-4000-8000-000000000003";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const E3 = "e0000000-0000-4000-8000-000000000003";
const E_OTHER = "e0000000-0000-4000-8000-000000000009";

const MODEL_PROSE = "MODEL EXPLANATION THAT MUST NEVER BE COPIED";

function observed() {
  return [
    {
      claimId: "obs-broker",
      originalWording: "Ana Perez is an agent with Compass in Jersey City.",
      normalizedWording: "Ana Perez is affiliated with Compass.",
    },
    {
      claimId: "obs-license",
      originalWording: "NJ license #1234567",
      normalizedWording: "Ana Perez holds NJ license 1234567.",
    },
    {
      claimId: "obs-sales",
      originalWording: "Closed 40 homes in 2025",
      normalizedWording: "Ana Perez closed 40 homes in 2025.",
    },
  ];
}

function approvedClaims() {
  return [
    { id: A_BROKER, key: "brokerage", text: "Ana Perez is affiliated with Douglas Elliman.", asOf: null, effectiveDate: "2026-01-15", evidenceIds: [E1], stale: false },
    { id: A_LICENSE, key: "license.nj", text: "Ana Perez holds NJ license 7654321.", asOf: "2024-03-01", effectiveDate: null, evidenceIds: [E2], stale: false },
    { id: A_SALES, key: "sales.2025.count", text: "Ana Perez closed 42 homes in 2025.", asOf: "2025-12-31", effectiveDate: null, evidenceIds: [E3, E1], stale: false },
  ];
}

const PAIRS = {
  broker: { observedClaimId: "obs-broker", approvedClaimId: A_BROKER, statementA: "Ana Perez is affiliated with Compass.", statementB: "Ana Perez is affiliated with Douglas Elliman.", severity: "critical", explanation: MODEL_PROSE },
  license: { observedClaimId: "obs-license", approvedClaimId: A_LICENSE, statementA: "NJ license #1234567", statementB: "Ana Perez holds NJ license 7654321.", severity: "critical", explanation: MODEL_PROSE },
  sales: { observedClaimId: "obs-sales", approvedClaimId: A_SALES, statementA: "Ana Perez closed 40 homes in 2025.", statementB: "Ana Perez closed 42 homes in 2025.", severity: "high", explanation: MODEL_PROSE },
} as const;

interface Pair {
  observedClaimId: string;
  approvedClaimId: string;
  statementA: string;
  statementB: string;
  severity: string;
  explanation: string;
}

function context(pairs: Pair[], overrides: Partial<CorrectionContext> = {}, claims = approvedClaims()): CorrectionContext {
  return {
    projectId: PROJECT,
    workflowRunId: RUN,
    profileUrl: URL_,
    canonicalExtract: { sourceArtifactId: ARTIFACT, sha256: SHA, claims: observed() },
    approvedFacts: { packetId: PACKET, claims },
    compare: { contradictions: pairs, confidence: 0.92 },
    ...overrides,
  };
}

function authority(overrides: Partial<CorrectionAuthority> = {}): CorrectionAuthority {
  return {
    claims: approvedClaims().map((c) => ({ id: c.id, projectId: PROJECT, status: "approved", evidenceIds: c.evidenceIds })),
    sourceArtifact: { id: ARTIFACT, projectId: PROJECT, sha256: SHA },
    ...overrides,
  };
}

function build(pairs: Pair[], ctxOverrides: Partial<CorrectionContext> = {}, auth = authority()) {
  const result = buildProfileCorrectionRequest(context(pairs, ctxOverrides), auth);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorsOf(result: { ok: boolean; errors?: string[] }): string[] {
  return result.ok ? [] : (result.errors ?? []);
}

// ---------------------------------------------------------------- builder

describe("buildProfileCorrectionRequest", () => {
  it("builds exactly one item from one validated pair, with only validated data", () => {
    const { request, requestSha256 } = build([PAIRS.broker]);
    expect(request).toEqual({
      version: "profile-correction-request-v1",
      projectId: PROJECT,
      workflowRunId: RUN,
      profileUrl: URL_,
      beforeSourceArtifactId: ARTIFACT,
      beforeSha256: SHA,
      evidencePacketId: PACKET,
      items: [
        {
          observedClaimId: "obs-broker",
          approvedClaimId: A_BROKER,
          approvedClaimKey: "brokerage",
          observedStatement: "Ana Perez is affiliated with Compass.",
          pageWording: "Ana Perez is an agent with Compass in Jersey City.",
          approvedStatement: "Ana Perez is affiliated with Douglas Elliman.",
          approvedAsOf: "2026-01-15",
          severity: "critical",
          evidenceIds: [E1],
        },
      ],
      evidenceIds: [E1],
      maxSeverity: "critical",
    });
    expect(requestSha256).toBe(createHash("sha256").update(canonicalJson(request)).digest("hex"));
  });

  it("orders multiple items deterministically: severity, then fact key, then observed id", () => {
    const { request } = build([PAIRS.sales, PAIRS.license, PAIRS.broker]);
    expect(request.items.map((i) => [i.severity, i.approvedClaimKey])).toEqual([
      ["critical", "brokerage"],
      ["critical", "license.nj"],
      ["high", "sales.2025.count"],
    ]);
    expect(request.evidenceIds).toEqual([E1, E2, E3]);
    expect(request.items[2]!.evidenceIds).toEqual([E1, E3]);
  });

  it("preserves the exact observed and approved wording and never copies the model explanation", () => {
    const { request } = build([PAIRS.license]);
    expect(request.items[0]!.pageWording).toBe("NJ license #1234567");
    expect(request.items[0]!.observedStatement).toBe("NJ license #1234567");
    expect(request.items[0]!.approvedStatement).toBe("Ana Perez holds NJ license 7654321.");
    expect(request.items[0]!.approvedAsOf).toBe("2024-03-01");
    expect(JSON.stringify(request)).not.toContain(MODEL_PROSE);
    expect(Object.keys(request.items[0]!)).not.toContain("explanation");
  });

  it("hashes deterministically, whatever order the comparison listed the pairs in", () => {
    const a = build([PAIRS.broker, PAIRS.license, PAIRS.sales]);
    const b = build([PAIRS.sales, PAIRS.broker, PAIRS.license]);
    expect(a.requestSha256).toBe(b.requestSha256);
    expect(a.requestSha256).toBe(profileCorrectionRequestHash(clone(a.request)));
    expect(a.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds nothing for a clean comparison", () => {
    const result = buildProfileCorrectionRequest(context([]), authority());
    expect(errorsOf(result)).toEqual(["no_contradictions: a clean comparison has nothing to correct"]);
  });

  it("fails closed when the approved fact is missing from the packet", () => {
    const claims = approvedClaims().filter((c) => c.id !== A_BROKER);
    const result = buildProfileCorrectionRequest(context([PAIRS.broker], {}, claims), authority());
    expect(errorsOf(result).join(" ")).toMatch(/contradiction_validation: .*not in approvedFacts/);
  });

  it("fails closed when the approved fact no longer exists in the database", () => {
    const result = buildProfileCorrectionRequest(
      context([PAIRS.broker]),
      authority({ claims: authority().claims.filter((c) => c.id !== A_BROKER) })
    );
    expect(errorsOf(result).some((e) => e.startsWith("claim_missing"))).toBe(true);
  });

  it("fails closed with no evidence", () => {
    const claims = approvedClaims().map((c) => (c.id === A_BROKER ? { ...c, evidenceIds: [] } : c));
    const result = buildProfileCorrectionRequest(context([PAIRS.broker], {}, claims), authority());
    expect(errorsOf(result).some((e) => e.startsWith("no_evidence"))).toBe(true);
  });

  it("fails closed on a stale approved fact", () => {
    const claims = approvedClaims().map((c) => (c.id === A_SALES ? { ...c, stale: true } : c));
    const result = buildProfileCorrectionRequest(context([PAIRS.sales], {}, claims), authority());
    expect(errorsOf(result).some((e) => e.startsWith("stale_fact"))).toBe(true);
  });

  it("fails closed on cross-project data: a claim or the before page from another client", () => {
    const foreignClaim = buildProfileCorrectionRequest(
      context([PAIRS.broker]),
      authority({
        claims: authority().claims.map((c) => (c.id === A_BROKER ? { ...c, projectId: OTHER_PROJECT } : c)),
      })
    );
    expect(errorsOf(foreignClaim).some((e) => e.startsWith("cross_project"))).toBe(true);

    const foreignPage = buildProfileCorrectionRequest(
      context([PAIRS.broker]),
      authority({ sourceArtifact: { id: ARTIFACT, projectId: OTHER_PROJECT, sha256: SHA } })
    );
    expect(errorsOf(foreignPage).some((e) => e.startsWith("cross_project"))).toBe(true);
  });

  it("fails closed when the database evidence differs from the packet's", () => {
    const result = buildProfileCorrectionRequest(
      context([PAIRS.broker]),
      authority({
        claims: authority().claims.map((c) => (c.id === A_BROKER ? { ...c, evidenceIds: [E_OTHER] } : c)),
      })
    );
    expect(errorsOf(result).some((e) => e.startsWith("evidence_mismatch"))).toBe(true);
  });

  it("inherits Spec 146's validator: a fabricated pair never builds", () => {
    const fabricated = { ...PAIRS.broker, statementA: "Ana Perez works for Compass and Redfin." };
    const result = buildProfileCorrectionRequest(context([fabricated]), authority());
    expect(errorsOf(result).join(" ")).toMatch(/contradiction_validation/);
  });
});

// -------------------------------------------------------------- validator

describe("validateProfileCorrectionRequest", () => {
  const ALL: Pair[] = [PAIRS.broker, PAIRS.license, PAIRS.sales];

  function base(): ProfileCorrectionRequest {
    return clone(build(ALL).request);
  }

  function check(request: unknown, ctxOverrides: Partial<CorrectionContext> = {}, auth = authority()) {
    return validateProfileCorrectionRequest(request, context(ALL, ctxOverrides), auth);
  }

  function expectError(request: unknown, prefix: string, ctxOverrides: Partial<CorrectionContext> = {}, auth = authority()) {
    const errors = errorsOf(check(request, ctxOverrides, auth));
    expect(errors.some((e) => e.startsWith(prefix)), `${prefix} in ${JSON.stringify(errors)}`).toBe(true);
  }

  it("passes the deterministic build", () => {
    expect(check(base())).toEqual({ ok: true });
  });

  it("rejects a fabricated or edited observed statement", () => {
    const r = base();
    r.items[0]!.observedStatement = "Ana Perez left real estate.";
    expectError(r, "observed_statement_mismatch");

    const w = base();
    w.items[0]!.pageWording = "Ana Perez is an agent with Compass.";
    expectError(w, "page_wording_mismatch");
  });

  it("rejects a wrong approved fact", () => {
    const r = base();
    r.items[0]!.approvedStatement = "Ana Perez is affiliated with Corcoran.";
    expectError(r, "approved_fact_mismatch");
  });

  it("rejects a wrong claim id", () => {
    const r = base();
    r.items[0]!.approvedClaimId = A_SALES;
    expectError(r, "extra_item");
    expectError(r, "missing_item");
  });

  it("rejects a wrong evidence id", () => {
    const r = base();
    r.items[0]!.evidenceIds = [E_OTHER];
    r.evidenceIds = [...new Set(r.items.flatMap((i) => i.evidenceIds))].sort();
    expectError(r, "evidence_mismatch");
  });

  it("rejects a wrong severity", () => {
    const r = base();
    r.items[2]!.severity = "low";
    expectError(r, "severity_mismatch");
  });

  it("rejects a missing, duplicate or extra contradiction", () => {
    const missing = base();
    missing.items.pop();
    expectError(missing, "missing_item");

    const duplicate = base();
    duplicate.items.push(clone(duplicate.items[0]!));
    expectError(duplicate, "duplicate_item");

    const extra = base();
    extra.items.push({ ...clone(extra.items[0]!), observedClaimId: "obs-invented" });
    expectError(extra, "extra_item");
  });

  it("rejects a tenant mismatch and a cross-project claim", () => {
    const r = base();
    r.projectId = OTHER_PROJECT;
    expectError(r, "tenant_mismatch");

    expectError(
      base(),
      "cross_project",
      {},
      authority({ claims: authority().claims.map((c) => ({ ...c, projectId: OTHER_PROJECT })) })
    );
  });

  it("rejects a claim that is no longer approved, or whose evidence changed", () => {
    expectError(
      base(),
      "claim_not_approved",
      {},
      authority({ claims: authority().claims.map((c) => (c.id === A_LICENSE ? { ...c, status: "superseded" } : c)) })
    );
    expectError(
      base(),
      "evidence_mismatch",
      {},
      authority({ claims: authority().claims.map((c) => (c.id === A_LICENSE ? { ...c, evidenceIds: [E2, E_OTHER] } : c)) })
    );
  });

  it("rejects a stale approved fact", () => {
    const claims = approvedClaims().map((c) => (c.id === A_SALES ? { ...c, stale: true } : c));
    expectError(base(), "stale_fact", { approvedFacts: { packetId: PACKET, claims } });
  });

  it("rejects another run, page, before-artifact or packet", () => {
    const run = base();
    run.workflowRunId = "66666666-6666-4666-8666-666666666666";
    expectError(run, "run_mismatch");
    const page = base();
    page.profileUrl = "https://www.zillow.com/profile/someone-else";
    expectError(page, "profile_mismatch");
    const source = base();
    source.beforeSha256 = "b".repeat(64);
    expectError(source, "source_mismatch");
    const packet = base();
    packet.evidencePacketId = "77777777-7777-4777-8777-777777777777";
    expectError(packet, "packet_mismatch");
  });

  it("rejects wrong derived fields", () => {
    const sev = base();
    sev.maxSeverity = "high";
    expectError(sev, "derived_mismatch");
    const ev = base();
    ev.evidenceIds = [E1];
    expectError(ev, "derived_mismatch");
  });

  it("rejects any additional factual statement or field", () => {
    const extraField = { ...base(), note: "The agent also won Best of Zillow 2025." };
    expectError(extraField, "schema");
    const extraItemField = base() as unknown as { items: Record<string, unknown>[] };
    extraItemField.items[0]!.explanation = MODEL_PROSE;
    expectError(extraItemField, "schema");
  });

  it("rejects a reordered request as not the deterministic build", () => {
    const r = base();
    r.items.reverse();
    expectError(r, "not_deterministic");
  });

  it("rejects malformed and empty input", () => {
    expectError(undefined, "schema");
    expectError({}, "schema");
    expectError({ ...base(), items: [] }, "schema");
  });

  it("fails closed when the comparison itself does not validate", () => {
    const errors = errorsOf(
      check(base(), { compare: { contradictions: [{ ...PAIRS.broker, approvedClaimId: OTHER_PROJECT }], confidence: 0.9 } })
    );
    expect(errors.join(" ")).toMatch(/contradiction_validation/);
  });
});

// ----------------------------------------------------------------- binding

describe("approvalBindingError", () => {
  const { request, requestSha256 } = build([PAIRS.broker, PAIRS.sales]);
  const detail = (artifact: unknown) => ({ output: { artifact }, autonomy: {} });

  it("binds when the approved artifact is exactly the stored request", () => {
    expect(approvalBindingError(detail({ request, requestSha256 }), requestSha256)).toBeNull();
  });

  it("refuses an edited request shown under the old hash", () => {
    const edited = clone(request);
    edited.items[0]!.approvedStatement = "Ana Perez is affiliated with Corcoran.";
    expect(approvalBindingError(detail({ request: edited, requestSha256 }), requestSha256)).toMatch(/does not match the hash/);
  });

  it("refuses an approval given for a different request than the one stored", () => {
    const other = build([PAIRS.broker]);
    expect(
      approvalBindingError(detail({ request: other.request, requestSha256: other.requestSha256 }), requestSha256)
    ).toMatch(/stored request is/);
  });

  it("refuses an approval that carries no request", () => {
    expect(approvalBindingError({ output: {} }, requestSha256)).toMatch(/does not carry/);
    expect(approvalBindingError(null, requestSha256)).toMatch(/does not carry/);
  });
});
