/**
 * Spec 145B — `dom.extract_canonical_claims`.
 *
 * The node composes ingestSource → extractClaimsFromSource. These tests pin the
 * composition: tenant scope comes only from the run, the source artifact id is
 * the one ingestion returned, test runs and unchanged pages stop safely, and
 * nothing is extracted from a fetch that did not observe a page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeContext } from "@/lib/workflow/types";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  systemUser: vi.fn(),
  runModeFor: vi.fn(),
  ingestSource: vi.fn(),
  extractClaimsFromSource: vi.fn(),
  loadClientSubjectIdentity: vi.fn(),
}));

vi.mock("@/db/client", () => ({ sql: mocks.sql }));
vi.mock("@/lib/auth", () => ({ systemUser: mocks.systemUser }));
vi.mock("@/lib/automation/testmode", () => ({ runModeFor: mocks.runModeFor }));
vi.mock("@/lib/knowledge/sources/ingest", () => ({ ingestSource: mocks.ingestSource }));
vi.mock("@/lib/knowledge/extraction/claims", () => ({
  extractClaimsFromSource: mocks.extractClaimsFromSource,
}));
vi.mock("@/lib/knowledge/entities/subject-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/entities/subject-identity")>()),
  loadClientSubjectIdentity: mocks.loadClientSubjectIdentity,
}));

import { extractCanonicalProfileClaims } from "@/lib/automation/nodes/claim-extraction";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_URL = "https://profiles.example.com/agent/ana-perez";

const IDENTITY = {
  name: "Perez Realty Group",
  aliases: ["Perez Realty", " perez realty ", ""],
  domain: "perezrealty.example",
  principals: ["Ana Perez", "Luis Perez", "Maya Chen"],
};
const ALLOW_LIST = ["Perez Realty Group", "Perez Realty", "Ana Perez", "Luis Perez", "Maya Chen"];

const SYSTEM = {
  id: "00000000-0000-4000-a000-000000000001",
  email: "system@avos.internal",
  name: "AI Visibility OS",
  role: "operator",
};

const PROPOSED = [
  {
    claimId: "55555555-5555-4555-8555-555555555555",
    subject: "Ana Perez",
    predicate: "is affiliated with",
    object: "Compass",
    originalWording: "Ana Perez is an agent with Compass",
    normalizedWording: "Ana Perez is affiliated with Compass.",
    category: "affiliation",
    asOf: null,
    value: null,
    confidence: 0.9,
    locator: "",
    materiality: "ordinary",
    requiresIndependentVerification: false,
    subjectEntityId: null,
    excerptVerified: true,
  },
];

function fetchOutput(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    ok: true,
    capability: "cms.fetch_public_page",
    provider: "wordpress",
    data: { url: PROFILE_URL, status: 200, reachable: true, excerpt: "<html><head>", ...data },
    mode: "live",
    ...overrides,
  };
}

function ctx(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    nodeKey: "canonical_extract",
    fanKey: "",
    attempt: 1,
    inputs: { fetch_profile: fetchOutput() },
    workflowInput: { payload: { profileUrl: PROFILE_URL } },
    config: { contextPath: "fetch_profile" },
    node: {} as NodeContext["node"],
    remainingCostMicroUsd: null,
    ...overrides,
  };
}

function ingestOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      sourceArtifactId: ARTIFACT_ID,
      sha256: "abc123",
      storageKey: "sources/abc123",
      mimeType: "text/html",
      sourceType: "website",
      duplicate: false,
      extractionStatus: "extracted",
      extractedTextLength: 1200,
      spanCount: 4,
      normalizations: 0,
      extractionError: null,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.systemUser.mockResolvedValue(SYSTEM);
  mocks.runModeFor.mockResolvedValue({
    mode: "live",
    fixtures: { connectorResponses: {}, agentResponses: {} },
    allowCrmWrites: false,
  });
  mocks.ingestSource.mockResolvedValue(ingestOk());
  mocks.extractClaimsFromSource.mockResolvedValue({
    ok: true,
    data: {
      sourceArtifactId: ARTIFACT_ID,
      proposed: PROPOSED,
      matched: [],
      rejected: [{ wording: "we are the best", reason: "Subjective" }],
      contradictionsDetected: 0,
      costMicroUsd: 1234,
    },
  });
  mocks.sql.mockResolvedValue([]);
  mocks.loadClientSubjectIdentity.mockResolvedValue({ status: "resolved", identity: IDENTITY });
});

function expectNothingIngested(): void {
  expect(mocks.ingestSource).not.toHaveBeenCalled();
  expect(mocks.extractClaimsFromSource).not.toHaveBeenCalled();
}

describe("dom.extract_canonical_claims", () => {
  it("refuses to run without a client scope", async () => {
    const result = await extractCanonicalProfileClaims(ctx({ projectId: null }));
    expect(result.outcome).toBe("failed_terminal");
    expect(result.error).toContain("client scope");
    expectNothingIngested();
  });

  it("safe-stops in test mode without ingesting or extracting", async () => {
    mocks.runModeFor.mockResolvedValue({
      mode: "test",
      fixtures: { connectorResponses: {}, agentResponses: {} },
      allowCrmWrites: false,
    });
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("safe_stop");
    expect(result.reason).toContain("test mode");
    expect(result.output?.sourceArtifactId).toBeUndefined();
    expectNothingIngested();
  });

  it.each([
    ["a failed fetch", fetchOutput({ ok: false })],
    ["a test-mode-refused fetch", fetchOutput({ skipped: true })],
    ["an unreachable page", fetchOutput({}, { reachable: false })],
    ["a fetch with no URL", fetchOutput({}, { url: undefined })],
    ["a missing fetch output", undefined],
  ])("safe-stops on %s", async (_label, fetched) => {
    const result = await extractCanonicalProfileClaims(
      ctx({ inputs: fetched === undefined ? {} : { fetch_profile: fetched } })
    );
    expect(result.outcome).toBe("safe_stop");
    expectNothingIngested();
  });

  it("ingests the observed URL canonically as the system user, scoped to the run's client", async () => {
    await extractCanonicalProfileClaims(ctx());
    expect(mocks.systemUser).toHaveBeenCalledTimes(1);
    expect(mocks.ingestSource).toHaveBeenCalledTimes(1);
    expect(mocks.ingestSource).toHaveBeenCalledWith(SYSTEM, {
      projectId: PROJECT_ID,
      url: PROFILE_URL,
      origin: "url_fetch",
      sourceType: "website",
      privacy: "public",
      provider: "wordpress",
      workflowRunId: RUN_ID,
    });
  });

  it("omits an invalid provider rather than inventing one", async () => {
    await extractCanonicalProfileClaims(
      ctx({ inputs: { fetch_profile: fetchOutput({ provider: "" }) } })
    );
    const [, input] = mocks.ingestSource.mock.calls[0]!;
    expect(input).not.toHaveProperty("provider");
  });

  it("ignores a project id supplied by the payload or upstream data", async () => {
    await extractCanonicalProfileClaims(
      ctx({
        inputs: { fetch_profile: fetchOutput({ projectId: OTHER_PROJECT_ID }, { projectId: OTHER_PROJECT_ID }) },
        workflowInput: { payload: { profileUrl: PROFILE_URL, projectId: OTHER_PROJECT_ID } },
      })
    );
    const [, input] = mocks.ingestSource.mock.calls[0]!;
    expect(input.projectId).toBe(PROJECT_ID);
  });

  it("extracts from the artifact ingestion returned and outputs proposed claims with cost", async () => {
    const result = await extractCanonicalProfileClaims(ctx());
    expect(mocks.extractClaimsFromSource).toHaveBeenCalledWith(SYSTEM, {
      sourceArtifactId: ARTIFACT_ID,
      subjectAllowList: ALLOW_LIST,
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.output).toEqual({
      sourceArtifactId: ARTIFACT_ID,
      sha256: "abc123",
      duplicate: false,
      claims: PROPOSED,
      claimCount: 1,
      proposedCount: 1,
      matchedCount: 0,
      rejectedCount: 1,
      rejected: [{ wording: "we are the best", reason: "Subjective" }],
    });
    expect(result.costMicroUsd).toBe(1234);
  });

  it("fails terminally when ingestion fails, and extracts nothing", async () => {
    mocks.ingestSource.mockResolvedValue({
      ok: false,
      error: { kind: "internal", message: "Fetching returned 503" },
    });
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("failed_terminal");
    expect(result.error).toContain("Fetching returned 503");
    expect(mocks.extractClaimsFromSource).not.toHaveBeenCalled();
  });

  it("safe-stops on a new artifact with no usable text, keeping the artifact id", async () => {
    mocks.ingestSource.mockResolvedValue(ingestOk({ extractedTextLength: 0 }));
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("safe_stop");
    expect(result.reason).toContain(ARTIFACT_ID);
    expect(mocks.extractClaimsFromSource).not.toHaveBeenCalled();
  });

  it("safe-stops on an unchanged page whose claims were already proposed", async () => {
    mocks.ingestSource.mockResolvedValue(
      ingestOk({ duplicate: true, extractedTextLength: 0 })
    );
    mocks.sql.mockResolvedValue([{ processingStatus: "claims_proposed" }]);
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("safe_stop");
    expect(result.reason).toContain(ARTIFACT_ID);
    expect(mocks.extractClaimsFromSource).not.toHaveBeenCalled();
    // The status read is scoped to the run's client.
    const [, ...values] = mocks.sql.mock.calls[0]!;
    expect(values).toEqual([ARTIFACT_ID, PROJECT_ID]);
  });

  it("extracts a duplicate artifact that was never extracted", async () => {
    mocks.ingestSource.mockResolvedValue(
      ingestOk({ duplicate: true, extractedTextLength: 0 })
    );
    mocks.sql.mockResolvedValue([{ processingStatus: "normalized" }]);
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("succeeded");
    expect(mocks.extractClaimsFromSource).toHaveBeenCalledWith(SYSTEM, {
      sourceArtifactId: ARTIFACT_ID,
      subjectAllowList: ALLOW_LIST,
    });
  });

  it("fails terminally when a duplicate artifact is outside the client's scope", async () => {
    mocks.ingestSource.mockResolvedValue(ingestOk({ duplicate: true }));
    mocks.sql.mockResolvedValue([]);
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("failed_terminal");
    expect(mocks.extractClaimsFromSource).not.toHaveBeenCalled();
  });

  it("fails terminally when extraction fails, passing the reason through", async () => {
    mocks.extractClaimsFromSource.mockResolvedValue({
      ok: false,
      error: { kind: "conflict", message: "The source has no extracted text." },
    });
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("failed_terminal");
    expect(result.error).toContain("The source has no extracted text.");
  });
});

describe("dom.extract_canonical_claims subject filtering (spec 145D)", () => {
  it("reads identity for the run's client only, before ingesting", async () => {
    await extractCanonicalProfileClaims(
      ctx({
        workflowInput: {
          payload: { profileUrl: PROFILE_URL, projectId: OTHER_PROJECT_ID, subjectName: "Payload Name" },
        },
      })
    );
    expect(mocks.loadClientSubjectIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.loadClientSubjectIdentity).toHaveBeenCalledWith(PROJECT_ID);
    expect(mocks.loadClientSubjectIdentity.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.ingestSource.mock.invocationCallOrder[0]!
    );
  });

  it("passes only the recorded identity as the allow list, never page or payload names", async () => {
    await extractCanonicalProfileClaims(
      ctx({
        inputs: {
          fetch_profile: fetchOutput({}, { title: "Greystar Apartments", subject: "Other Agent" }),
        },
        workflowInput: { payload: { profileUrl: PROFILE_URL, subjectName: "Payload Name" } },
        config: { contextPath: "fetch_profile", subjectAllowList: ["Config Name"] },
      })
    );
    const [, request] = mocks.extractClaimsFromSource.mock.calls[0]!;
    expect(request.subjectAllowList).toEqual(ALLOW_LIST);
    for (const foreign of ["Greystar Apartments", "Other Agent", "Payload Name", "Config Name"]) {
      expect(request.subjectAllowList).not.toContain(foreign);
    }
  });

  it.each([["client_not_found"], ["no_subject_company"]])(
    "safe-stops on unresolved identity (%s) without ingesting or extracting",
    async (status) => {
      mocks.loadClientSubjectIdentity.mockResolvedValue({ status });
      const result = await extractCanonicalProfileClaims(ctx());
      expect(result.outcome).toBe("safe_stop");
      expect(result.reason).toContain("no subject company");
      expectNothingIngested();
    }
  );

  it("safe-stops on an identity that yields an empty allow list, never sending []", async () => {
    mocks.loadClientSubjectIdentity.mockResolvedValue({
      status: "resolved",
      identity: { name: "   ", aliases: ["", " "], domain: null, principals: [] },
    });
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("safe_stop");
    expect(result.reason).toContain("no usable name");
    expectNothingIngested();
  });

  it("returns out-of-scope rejections without adding them to the proposed claims", async () => {
    const outOfScope = {
      wording: "Greystar manages The James",
      reason: 'The subject "Greystar" is not this client or one of its people.',
    };
    mocks.extractClaimsFromSource.mockResolvedValue({
      ok: true,
      data: {
        sourceArtifactId: ARTIFACT_ID,
        proposed: PROPOSED,
        matched: [],
        rejected: [outOfScope],
        contradictionsDetected: 0,
        costMicroUsd: 10,
      },
    });
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("succeeded");
    expect(result.output?.rejected).toEqual([outOfScope]);
    expect(result.output?.claims).toEqual(PROPOSED);
    expect(result.output?.claimCount).toBe(1);
  });
});

describe("dom.extract_canonical_claims cross-artifact matches (spec 145E)", () => {
  const MATCHED = [
    {
      ...PROPOSED[0]!,
      claimId: "66666666-6666-4666-8666-666666666666",
      normalizedWording: "Ana Perez closed 40 homes.",
      existingStatus: "rejected",
      resolution: "already_known",
      evidenceId: "77777777-7777-4777-8777-777777777777",
    },
    {
      ...PROPOSED[0]!,
      claimId: "88888888-8888-4888-8888-888888888888",
      existingStatus: "proposed",
      resolution: "linked",
      evidenceId: "99999999-9999-4999-8999-999999999999",
    },
  ];

  it("hands compare both newly proposed and already-known observations", async () => {
    mocks.extractClaimsFromSource.mockResolvedValue({
      ok: true,
      data: {
        sourceArtifactId: ARTIFACT_ID,
        proposed: PROPOSED,
        matched: MATCHED,
        rejected: [],
        contradictionsDetected: 0,
        costMicroUsd: 5,
      },
    });
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("succeeded");
    expect(result.output?.claims).toEqual([...PROPOSED, ...MATCHED]);
    expect(result.output?.claimCount).toBe(3);
    expect(result.output?.proposedCount).toBe(1);
    expect(result.output?.matchedCount).toBe(2);
    const claims = result.output?.claims as { existingStatus?: string }[];
    expect(claims.map((c) => c.existingStatus)).toEqual([undefined, "rejected", "proposed"]);
  });

  it("still succeeds when every observation is already known", async () => {
    mocks.extractClaimsFromSource.mockResolvedValue({
      ok: true,
      data: {
        sourceArtifactId: ARTIFACT_ID,
        proposed: [],
        matched: MATCHED,
        rejected: [],
        contradictionsDetected: 0,
        costMicroUsd: 5,
      },
    });
    const result = await extractCanonicalProfileClaims(ctx());
    expect(result.outcome).toBe("succeeded");
    expect(result.output?.claims).toEqual(MATCHED);
    expect(result.output?.proposedCount).toBe(0);
  });
});

