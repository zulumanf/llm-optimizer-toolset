/**
 * Spec 147 slice 1 — `dom.fetch_public_profile` reads a public profile through
 * the existing safeFetch policy (the real one; only the network is stubbed),
 * needs no connector, and hands canonical extraction the contract it already
 * reads — so Spec 145B's ingest path is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeContext } from "@/lib/workflow/types";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  runModeFor: vi.fn(),
  executeCapability: vi.fn(),
  systemUser: vi.fn(),
  ingestSource: vi.fn(),
  extractClaimsFromSource: vi.fn(),
  loadClientSubjectIdentity: vi.fn(),
}));

vi.mock("@/db/client", () => ({ sql: mocks.sql }));
vi.mock("@/lib/automation/testmode", () => ({ runModeFor: mocks.runModeFor }));
vi.mock("@/lib/connectors/execute", () => ({ executeCapability: mocks.executeCapability }));
vi.mock("@/lib/auth", () => ({ systemUser: mocks.systemUser }));
vi.mock("@/lib/knowledge/sources/ingest", () => ({ ingestSource: mocks.ingestSource }));
vi.mock("@/lib/knowledge/extraction/claims", () => ({
  extractClaimsFromSource: mocks.extractClaimsFromSource,
}));
vi.mock("@/lib/knowledge/entities/subject-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/entities/subject-identity")>()),
  loadClientSubjectIdentity: mocks.loadClientSubjectIdentity,
}));

import { fetchPublicProfile } from "@/lib/automation/nodes/profile-correction";
import { extractCanonicalProfileClaims } from "@/lib/automation/nodes/claim-extraction";
import { SOURCE_MAX_BYTES } from "@/lib/knowledge/constants";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_URL = "https://www.zillow.com/profile/ana-perez";

function ctx(profileUrl: unknown, config: Record<string, unknown> = { urlPath: "payload.profileUrl" }): NodeContext {
  return {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    nodeKey: "fetch_profile",
    fanKey: "",
    attempt: 1,
    inputs: {},
    workflowInput: { payload: profileUrl === undefined ? {} : { profileUrl } },
    config,
    node: {} as NodeContext["node"],
    remainingCostMicroUsd: null,
  };
}

type Responder = (url: string) => Response | Promise<Response>;

function stubFetch(responder: Responder) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    void _init;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sql.mockResolvedValue([]);
  mocks.runModeFor.mockResolvedValue({
    mode: "live",
    fixtures: { connectorResponses: {}, agentResponses: {} },
    allowCrmWrites: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dom.fetch_public_profile", () => {
  it("reads a public https page with no connector", async () => {
    const fetchMock = stubFetch(() => new Response("<html>Ana</html>", { status: 200 }));
    const result = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(result.outcome).toBe("succeeded");
    expect(result.output).toEqual({
      ok: true,
      data: { url: PROFILE_URL, finalUrl: PROFILE_URL, status: 200, reachable: true },
    });
    expect(result.output).not.toHaveProperty("provider");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
    expect(mocks.executeCapability).not.toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://localhost:11434/api/tags",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/profile",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://metadata.internal/",
  ])("refuses the private target %s without fetching", async (target) => {
    const fetchMock = stubFetch(() => new Response("secret", { status: 200 }));
    const result = await fetchPublicProfile(ctx(target));
    expect(result.outcome).toBe("succeeded");
    expect(result.output).toMatchObject({ ok: false, reason: "policy_refused", errorKind: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["ftp://files.example/profile", "file:///etc/passwd", "not a url"])(
    "refuses the non-http(s) target %s",
    async (target) => {
      const fetchMock = stubFetch(() => new Response("x", { status: 200 }));
      const result = await fetchPublicProfile(ctx(target));
      expect(result.output).toMatchObject({ ok: false, reason: "policy_refused", errorKind: "validation" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("re-validates every redirect hop and refuses one into a private network", async () => {
    const fetchMock = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/" } })
    );
    const result = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(result.output).toMatchObject({ ok: false, reason: "policy_refused", errorKind: "forbidden" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect and reports where the page came from", async () => {
    stubFetch((url) =>
      url === PROFILE_URL
        ? new Response(null, { status: 301, headers: { location: "https://www.zillow.com/profile/ana" } })
        : new Response("<html>Ana</html>", { status: 200 })
    );
    const result = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(result.output).toEqual({
      ok: true,
      data: { url: PROFILE_URL, finalUrl: "https://www.zillow.com/profile/ana", status: 200, reachable: true },
    });
  });

  it("treats a redirect loop as unreachable, not as a refusal", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: PROFILE_URL } }));
    const result = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(result.output).toMatchObject({ ok: true, data: { reachable: false, status: null } });
  });

  it.each([404, 410, 500, 503])("reports HTTP %i as reachable: false", async (status) => {
    stubFetch(() => new Response("nope", { status }));
    const result = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(result.output).toEqual({
      ok: true,
      data: { url: PROFILE_URL, finalUrl: PROFILE_URL, status, reachable: false },
    });
  });

  it("reports a timeout or network failure as unreachable", async () => {
    stubFetch(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const timedOut = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(timedOut.output).toMatchObject({ ok: true, data: { reachable: false, status: null } });
    expect(String((timedOut.output as { data: { error: string } }).data.error)).toMatch(/exceeded/);

    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const failed = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(failed.output).toMatchObject({ ok: true, data: { reachable: false } });
  });

  it("enforces the ingestion size cap as a refusal", async () => {
    stubFetch(
      () =>
        new Response("x", {
          status: 200,
          headers: { "content-length": String(SOURCE_MAX_BYTES + 1) },
        })
    );
    const result = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(result.output).toMatchObject({ ok: false, reason: "policy_refused", errorKind: "validation" });
  });

  it("never invents a URL when the payload has none", async () => {
    const fetchMock = stubFetch(() => new Response("x", { status: 200 }));
    for (const value of [undefined, "", "   ", 42]) {
      const result = await fetchPublicProfile(ctx(value));
      expect(result).toEqual({ outcome: "succeeded", output: { ok: false, reason: "no_url" } });
    }
    const unconfigured = await fetchPublicProfile(ctx(PROFILE_URL, {}));
    expect(unconfigured.output).toEqual({ ok: false, reason: "no_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reach a live site in test mode", async () => {
    mocks.runModeFor.mockResolvedValue({ mode: "test", fixtures: {}, allowCrmWrites: false });
    const fetchMock = stubFetch(() => new Response("x", { status: 200 }));
    const result = await fetchPublicProfile(ctx(PROFILE_URL));
    expect(result.outcome).toBe("safe_stop");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("canonical extraction after the public fetch (spec 145B unchanged)", () => {
  const IDENTITY = { name: "Perez Realty Group", aliases: [], domain: null, principals: ["Ana Perez"] };

  beforeEach(() => {
    mocks.systemUser.mockResolvedValue({ id: "sys", email: "s@x", name: "S", role: "operator" });
    mocks.loadClientSubjectIdentity.mockResolvedValue({ status: "resolved", identity: IDENTITY });
    mocks.ingestSource.mockResolvedValue({
      ok: true,
      data: {
        sourceArtifactId: "44444444-4444-4444-8444-444444444444",
        sha256: "abc",
        storageKey: "k",
        mimeType: "text/html",
        sourceType: "website",
        duplicate: false,
        extractionStatus: "extracted",
        extractedTextLength: 100,
        spanCount: 1,
        normalizations: 0,
        extractionError: null,
      },
    });
    mocks.extractClaimsFromSource.mockResolvedValue({
      ok: true,
      data: { proposed: [], matched: [], rejected: [], costMicroUsd: 0 },
    });
  });

  function extractCtx(fetchOutput: unknown): NodeContext {
    return {
      ...ctx(PROFILE_URL),
      nodeKey: "canonical_extract",
      inputs: { fetch_profile: fetchOutput },
      config: { contextPath: "fetch_profile" },
    };
  }

  it("ingests the fetched URL through ingestSource(url_fetch), with no connector provider", async () => {
    stubFetch(() => new Response("<html>Ana</html>", { status: 200 }));
    const fetched = await fetchPublicProfile(ctx(PROFILE_URL));
    const result = await extractCanonicalProfileClaims(extractCtx(fetched.output));
    expect(result.outcome).toBe("succeeded");
    expect(mocks.ingestSource).toHaveBeenCalledTimes(1);
    const input = mocks.ingestSource.mock.calls[0]![1];
    expect(input).toMatchObject({ projectId: PROJECT_ID, url: PROFILE_URL, origin: "url_fetch", privacy: "public" });
    expect(input).not.toHaveProperty("provider");
    expect(mocks.extractClaimsFromSource).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unreachable page", () => new Response("down", { status: 503 })],
    ["a refused target", () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } })],
  ])("stops safely on %s without ingesting", async (_label, responder) => {
    stubFetch(responder);
    const fetched = await fetchPublicProfile(ctx(PROFILE_URL));
    const result = await extractCanonicalProfileClaims(extractCtx(fetched.output));
    expect(result.outcome).toBe("safe_stop");
    expect(mocks.ingestSource).not.toHaveBeenCalled();
  });
});
