/**
 * Spec 147 slice 4 — the deterministic correction email and the send
 * confirmation binding. Pure; known-answer fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  correctionEmailHash,
  renderProfileCorrectionEmail,
  validateProfileCorrectionEmail,
  type CorrectionEmailInput,
} from "@/lib/profile-corrections/email";
import { sendConfirmationBindingError } from "@/lib/profile-corrections/approval-binding";
import { profileCorrectionRequestHash, type ProfileCorrectionRequest } from "@/lib/profile-corrections/request";

const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const DEST = "d0000000-0000-4000-8000-000000000001";
const OTHER_DEST = "d0000000-0000-4000-8000-000000000002";
const MODEL_PROSE = "MODEL EXPLANATION THAT MUST NEVER BE COPIED";

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
      approvedClaimId: "a0000000-0000-4000-8000-000000000001",
      approvedClaimKey: "brokerage",
      observedStatement: "Ana Perez is affiliated with Compass.",
      pageWording: "Ana Perez is an agent with Compass in Jersey City.",
      approvedStatement: "Ana Perez is affiliated with Douglas Elliman.",
      approvedAsOf: "2026-01-15",
      severity: "critical",
      evidenceIds: [E1],
    },
    {
      observedClaimId: "obs-sales",
      approvedClaimId: "a0000000-0000-4000-8000-000000000003",
      approvedClaimKey: "sales.2025.count",
      observedStatement: "Ana Perez closed 40 homes in 2025.",
      pageWording: "Closed 40 homes in 2025",
      approvedStatement: "Ana Perez closed 42 homes in 2025.",
      approvedAsOf: null,
      severity: "high",
      evidenceIds: [E2],
    },
  ],
  evidenceIds: [E1, E2],
  maxSeverity: "critical",
};
const SHA = profileCorrectionRequestHash(request);

function input(overrides: Partial<CorrectionEmailInput> = {}): CorrectionEmailInput {
  return {
    request,
    requestSha256: SHA,
    destination: { id: DEST, kind: "client_editor", recipientName: "Maria Perez", email: "maria@perezrealty.example" },
    subjectName: "Perez Realty Group",
    ...overrides,
  };
}

function render(overrides: Partial<CorrectionEmailInput> = {}) {
  const result = renderProfileCorrectionEmail(input(overrides));
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.email;
}

describe("renderProfileCorrectionEmail", () => {
  it("renders the client_editor email exactly", () => {
    expect(render()).toEqual({
      templateVersion: "profile-correction-email-v1",
      to: "maria@perezrealty.example",
      subject: "Correction needed on www.zillow.com",
      body: [
        "Hi Maria Perez,",
        "",
        "We checked https://www.zillow.com/profile/ana-perez against the facts you approved with us. It currently says something that does not match:",
        "",
        '1. The page says: "Ana Perez is an agent with Compass in Jersey City."',
        '   Approved fact: "Ana Perez is affiliated with Douglas Elliman." (as of 2026-01-15)',
        '2. The page says: "Closed 40 homes in 2025"',
        '   Approved fact: "Ana Perez closed 42 homes in 2025."',
        "",
        "Could you update the page, or reply if the approved fact has changed?",
        "We will check the page again in 14 days.",
      ].join("\n"),
    });
  });

  it("renders the publisher email exactly, on the client's behalf", () => {
    const email = render({
      destination: { id: DEST, kind: "publisher", recipientName: "Corrections desk", email: "corrections@zillow.example" },
    });
    expect(email.to).toBe("corrections@zillow.example");
    expect(email.body.split("\n")).toEqual([
      "Hello Corrections desk,",
      "",
      "We are writing on behalf of Perez Realty Group about https://www.zillow.com/profile/ana-perez. The page states the following, which does not match Perez Realty Group's confirmed records:",
      "",
      '1. The page says: "Ana Perez is an agent with Compass in Jersey City."',
      '   Correct fact: "Ana Perez is affiliated with Douglas Elliman." (as of 2026-01-15)',
      '2. The page says: "Closed 40 homes in 2025"',
      '   Correct fact: "Ana Perez closed 42 homes in 2025."',
      "",
      "Could you please correct the page? Thank you.",
    ]);
  });

  it("is deterministic, follows the request's item order, and carries only validated statements", () => {
    const a = render();
    const b = render();
    expect(correctionEmailHash(a)).toBe(correctionEmailHash(b));
    expect(a.body.indexOf("Compass")).toBeLessThan(a.body.indexOf("40 homes"));
    expect(JSON.stringify(a)).not.toContain(MODEL_PROSE);
    expect(a.body).not.toContain("severity");
    expect(a.body).not.toContain(request.items[0]!.approvedClaimId);
    // Every quoted line is a validated statement from the request.
    const quoted = [...a.body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const validated = request.items.flatMap((i) => [i.pageWording, i.approvedStatement]);
    expect(quoted.every((q) => validated.includes(q!))).toBe(true);
  });

  it("refuses a stale hash, a malformed destination, and a publisher email with no client name", () => {
    expect(renderProfileCorrectionEmail(input({ requestSha256: "b".repeat(64) })).ok).toBe(false);
    expect(
      renderProfileCorrectionEmail(input({ destination: { id: DEST, kind: "client_editor", recipientName: "M", email: "nope" } })).ok
    ).toBe(false);
    expect(
      renderProfileCorrectionEmail(
        input({ subjectName: " ", destination: { id: DEST, kind: "publisher", recipientName: "Desk", email: "d@x.example" } })
      ).ok
    ).toBe(false);
  });
});

describe("validateProfileCorrectionEmail", () => {
  it("accepts exactly the rendering", () => {
    expect(validateProfileCorrectionEmail(render(), input())).toEqual({ ok: true });
  });

  it("rejects another recipient (e.g. the client's contact on a publisher destination)", () => {
    const email = { ...render(), to: "client@perezrealty.example" };
    const v = validateProfileCorrectionEmail(email, input());
    expect(v).toEqual({ ok: false, errors: [expect.stringMatching(/^recipient_mismatch/)] });
  });

  it("rejects the email for a different destination", () => {
    const forOther = render({ destination: { id: OTHER_DEST, kind: "client_editor", recipientName: "Luis", email: "luis@x.example" } });
    expect(validateProfileCorrectionEmail(forOther, input()).ok).toBe(false);
  });

  it("rejects an invented or edited fact, an added field, and a stale request hash", () => {
    const edited = render();
    expect(
      validateProfileCorrectionEmail({ ...edited, body: edited.body.replace("42 homes", "45 homes") }, input()).ok
    ).toBe(false);
    expect(
      validateProfileCorrectionEmail({ ...edited, body: `${edited.body}\nAlso, Ana won Best of Zillow 2025.` }, input()).ok
    ).toBe(false);
    expect(validateProfileCorrectionEmail({ ...edited, cc: "x@y.example" }, input()).ok).toBe(false);
    const staleRequest = { ...request, items: [request.items[0]!] };
    expect(validateProfileCorrectionEmail(edited, input({ request: staleRequest })).ok).toBe(false);
  });
});

describe("sendConfirmationBindingError", () => {
  const expected = {
    correctionRequestId: "c0000000-0000-4000-8000-000000000001",
    requestSha256: SHA,
    destinationId: DEST,
    draftAttemptId: "f0000000-0000-4000-8000-000000000001",
    gmailDraftId: "r-123",
  };
  const detail = (artifact: Record<string, unknown>) => ({ output: { artifact } });

  it("binds to request, hash, destination and draft", () => {
    expect(sendConfirmationBindingError(detail({ ...expected }), expected)).toBeNull();
  });

  it.each([
    ["request hash", { requestSha256: "c".repeat(64) }],
    ["Gmail draft", { gmailDraftId: "r-999" }],
    ["destination", { destinationId: OTHER_DEST }],
    ["draft attempt", { draftAttemptId: "f0000000-0000-4000-8000-000000000002" }],
    ["request", { correctionRequestId: "c0000000-0000-4000-8000-000000000002" }],
  ])("refuses a confirmation for another %s", (label, change) => {
    expect(sendConfirmationBindingError(detail({ ...expected, ...change }), expected)).toMatch(new RegExp(label));
  });

  it("refuses a confirmation with nothing to bind", () => {
    expect(sendConfirmationBindingError({ output: {} }, expected)).toMatch(/does not carry/);
    expect(sendConfirmationBindingError(detail({ ...expected, gmailDraftId: undefined }), expected)).toMatch(/Gmail draft/);
  });
});
