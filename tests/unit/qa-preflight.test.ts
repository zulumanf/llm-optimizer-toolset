/**
 * QA preflight (spec 065): known-answer tests for every pure check builder,
 * settle precedence, and the source-link liveness runner with an injected
 * fetch (the suite never touches the network — docs/09).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  QA_PREFLIGHT_VERSION,
  settlePreflight,
  checkMethodologyVersion,
  checkIncludedRunsHealthy,
  checkNoUnexaminedFailedRuns,
  checkMeasurementFresh,
  checkNoMockResponses,
  deadSourceLinks,
  setSourceLinkFetchDeps,
  SOURCE_LINK_MAX_CHECKS,
} from "@/lib/qa/preflight";
import { FRESHNESS_WINDOWS_DAYS } from "@/lib/prospects/constants";

afterEach(() => setSourceLinkFetchDeps(null));

describe("settlePreflight", () => {
  it("separates failing blockers from failing warnings and ignores passes", () => {
    const result = settlePreflight([
      { id: "a", level: "block", ok: true, detail: "fine" },
      { id: "b", level: "block", ok: false, detail: "bad" },
      { id: "c", level: "warn", ok: false, detail: "iffy" },
      { id: "d", level: "warn", ok: true, detail: "fine" },
    ]);
    expect(result.version).toBe(QA_PREFLIGHT_VERSION);
    expect(result.blockers.map((c) => c.id)).toEqual(["b"]);
    expect(result.warnings.map((c) => c.id)).toEqual(["c"]);
  });
});

describe("checkMethodologyVersion", () => {
  it("blocks on a missing or empty scoring version", () => {
    expect(checkMethodologyVersion(undefined).ok).toBe(false);
    expect(checkMethodologyVersion("").ok).toBe(false);
    expect(checkMethodologyVersion(null).ok).toBe(false);
    expect(checkMethodologyVersion(undefined).level).toBe("block");
  });

  it("passes with a version and names it", () => {
    const check = checkMethodologyVersion("v1.1");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("v1.1");
  });
});

describe("checkIncludedRunsHealthy", () => {
  it("passes when every included run completed", () => {
    expect(
      checkIncludedRunsHealthy([
        { label: "week 31", status: "completed", statusDetail: null },
      ]).ok
    ).toBe(true);
  });

  it("warns with the run's own status detail when a run finished partial", () => {
    const check = checkIncludedRunsHealthy([
      { label: "week 32", status: "partial", statusDetail: "3 of 24 cells failed" },
    ]);
    expect(check.ok).toBe(false);
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("week 32");
    expect(check.detail).toContain("3 of 24 cells failed");
  });
});

describe("checkNoUnexaminedFailedRuns", () => {
  it("passes on an empty window and names the silent holes otherwise", () => {
    expect(checkNoUnexaminedFailedRuns([]).ok).toBe(true);
    const check = checkNoUnexaminedFailedRuns([{ label: "retry run" }]);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('"retry run"');
  });
});

describe("checkMeasurementFresh", () => {
  const now = new Date("2026-08-13T00:00:00Z");

  it("passes inside the benchmark freshness window", () => {
    expect(checkMeasurementFresh("2026-08-01T00:00:00Z", now).ok).toBe(true);
  });

  it("warns past the window, stating the age", () => {
    const check = checkMeasurementFresh("2026-01-01T00:00:00Z", now);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(`${FRESHNESS_WINDOWS_DAYS.benchmark}-day`);
  });

  it("warns when the current run has no start date at all", () => {
    expect(checkMeasurementFresh(null, now).ok).toBe(false);
  });
});

describe("checkNoMockResponses", () => {
  it("blocks mock responses when the policy disallows them", () => {
    const check = checkNoMockResponses(["mock", "openai"], false);
    expect(check.ok).toBe(false);
    expect(check.level).toBe("block");
  });

  it("permits mock where the environment allows it, and real providers always", () => {
    expect(checkNoMockResponses(["mock"], true).ok).toBe(true);
    expect(checkNoMockResponses(["openai", "anthropic"], false).ok).toBe(true);
  });
});

describe("deadSourceLinks", () => {
  const stub = ((url: RequestInfo | URL) => {
    const target = String(url);
    return Promise.resolve(
      new Response(target.includes("dead") ? "gone" : "ok", {
        status: target.includes("dead") ? 404 : 200,
      })
    );
  }) as typeof fetch;

  it("reports only the dead links, deduped", async () => {
    const dead = await deadSourceLinks(
      [
        "https://example.com/alive",
        "https://example.com/dead-page",
        "https://example.com/dead-page",
      ],
      { fetchImpl: stub, lookupImpl: null }
    );
    expect(dead).toHaveLength(1);
    expect(dead[0]?.url).toBe("https://example.com/dead-page");
    expect(dead[0]?.note).toContain("404");
  });

  it("caps the number of publish-time fetches", async () => {
    let calls = 0;
    const counting = ((url: RequestInfo | URL) => {
      calls += 1;
      return stub(url);
    }) as typeof fetch;
    const urls = Array.from(
      { length: SOURCE_LINK_MAX_CHECKS + 4 },
      (_, i) => `https://example.com/page-${i}`
    );
    await deadSourceLinks(urls, { fetchImpl: counting, lookupImpl: null });
    expect(calls).toBe(SOURCE_LINK_MAX_CHECKS);
  });

  it("records a thrown fetch as a dead link, never as an exception", async () => {
    const failing = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const dead = await deadSourceLinks(["https://example.com/x"], {
      fetchImpl: failing,
      lookupImpl: null,
    });
    expect(dead).toHaveLength(1);
    expect(dead[0]?.note).toContain("ECONNREFUSED");
  });

  it("is skipped entirely under the test kill-switch with no injected fetch", async () => {
    // tests/setup.ts sets QA_SOURCE_LINK_CHECKS=off for the whole suite.
    const dead = await deadSourceLinks(["https://example.com/dead-page"]);
    expect(dead).toEqual([]);
  });

  it("the injected test seam takes precedence over the kill-switch", async () => {
    setSourceLinkFetchDeps({ fetchImpl: stub, lookupImpl: null });
    const dead = await deadSourceLinks(["https://example.com/dead-page"]);
    expect(dead).toHaveLength(1);
  });
});
