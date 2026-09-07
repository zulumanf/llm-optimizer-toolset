/**
 * Evidence-link health (2026-08-19): state derivation and presentation are
 * pure and known-answer tested. The invariant that matters: a KNOWN broken
 * receipt is never presented as a live link, while unknown (never checked)
 * URLs render unchanged — unknown is not broken.
 */
import { describe, expect, it } from "vitest";
import {
  collectSnapshotEvidenceUrls,
  deriveLinkState,
  evidenceHref,
  type EvidenceLinkHealth,
} from "@/lib/evidence/link-health";
import type { AuditSnapshot } from "@/lib/prospects/audits";

const health = (
  state: EvidenceLinkHealth["state"],
  finalUrl: string | null = null
): EvidenceLinkHealth => ({
  url: "https://example.com/a",
  state,
  finalUrl,
  httpStatus: null,
  checkedAt: "2026-08-19T00:00:00.000Z",
});

describe("deriveLinkState", () => {
  it("2xx at the same URL is healthy (trailing slash ignored)", () => {
    expect(
      deriveLinkState({
        ok: true,
        status: 200,
        url: "https://example.com/a",
        finalUrl: "https://example.com/a/",
      })
    ).toBe("healthy");
  });

  it("2xx after a redirect is redirected", () => {
    expect(
      deriveLinkState({
        ok: true,
        status: 200,
        url: "https://example.com/old",
        finalUrl: "https://example.com/new",
      })
    ).toBe("redirected");
  });

  it("4xx/5xx is broken", () => {
    expect(
      deriveLinkState({
        ok: false,
        status: 404,
        url: "https://example.com/a",
        finalUrl: "https://example.com/a",
      })
    ).toBe("broken");
  });
});

describe("evidenceHref — presentation of link health", () => {
  it("unknown (never checked) renders the original link — unknown is not broken", () => {
    expect(evidenceHref("https://example.com/a", null)).toEqual({
      href: "https://example.com/a",
      moved: false,
    });
  });

  it("healthy renders the original link", () => {
    expect(evidenceHref("https://example.com/a", health("healthy")).href).toBe(
      "https://example.com/a"
    );
  });

  it("redirected points at the current canonical page", () => {
    expect(
      evidenceHref(
        "https://example.com/a",
        health("redirected", "https://example.com/b")
      ).href
    ).toBe("https://example.com/b");
  });

  it("a KNOWN broken link is never rendered as a live link", () => {
    const broken = evidenceHref("https://example.com/a", health("broken"));
    expect(broken.href).toBeNull();
    expect(broken.moved).toBe(true);
    const unavailable = evidenceHref(
      "https://example.com/a",
      health("unavailable")
    );
    expect(unavailable.href).toBeNull();
  });
});

describe("collectSnapshotEvidenceUrls", () => {
  it("gathers every receipt URL exactly once; legacy snapshots yield none", () => {
    const minimal = {
      headline: "h",
      prospectName: "p",
      marketName: "m",
      benchmark: {
        dateRange: { from: "2026-08-01", to: null },
        providers: ["openai"],
        promptCount: 16,
        responseCount: 64,
        limitations: "",
      },
      keyFinding: { title: "t", explanation: "e", metrics: {} },
      comparison: [],
      promptEvidence: [],
      methodology: "",
      cta: "",
    } as unknown as AuditSnapshot;
    expect(collectSnapshotEvidenceUrls(minimal)).toEqual([]);

    const withReceipts = {
      ...minimal,
      verifiedProduction: { sourceUrl: "https://a.com/x" },
      humanFinding: { sourceUrl: "https://b.com/y" },
      authorityGap: {
        signals: [
          { label: "s", provenance: "verified", sourceUrl: "https://a.com/x" },
          { label: "s2", provenance: "verified", sourceUrl: null },
        ],
      },
    } as unknown as AuditSnapshot;
    expect(collectSnapshotEvidenceUrls(withReceipts).sort()).toEqual([
      "https://a.com/x",
      "https://b.com/y",
    ]);
  });
});
