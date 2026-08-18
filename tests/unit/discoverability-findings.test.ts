/**
 * Finding derivation invariants (spec 088): unknown data never becomes a
 * negative finding, severity stays separate from priority, orphan detection
 * respects exclusions, and schema findings retain their evidence.
 */
import { describe, it, expect } from "vitest";
import { deriveFindings, type ScannedPage } from "@/lib/discoverability/findings";
import type { RobotsReport } from "@/lib/discoverability/robots";
import { checkStructuredData } from "@/lib/discoverability/schema-check";
import type { PageKind } from "@/lib/discoverability/constants";

const CURRENT_YEAR = 2026;

function robots(overrides: Partial<RobotsReport> = {}): RobotsReport {
  return {
    fetchStatus: 200,
    present: true,
    fetchError: null,
    sitemapRefs: [],
    crawlerAccess: [
      { crawler: "Googlebot", rootAllowed: true, viaSpecificGroup: false, disallow: [] },
      { crawler: "GPTBot", rootAllowed: true, viaSpecificGroup: false, disallow: [] },
    ],
    bodyExcerpt: "",
    ...overrides,
  };
}

function page(url: string, kind: PageKind, overrides: Partial<ScannedPage> = {}): ScannedPage {
  return {
    url,
    finalUrl: url,
    discoveredVia: "sitemap",
    httpStatus: 200,
    ok: true,
    pageKind: kind,
    importance: 80,
    title: null,
    canonicalUrl: null,
    metaRobots: null,
    xRobotsTag: null,
    noindex: null,
    inSitemap: true,
    sitemapLastmod: null,
    textLength: 2000,
    latestYearReferenced: null,
    outlinks: [],
    jsonLd: [],
    jsonLdError: null,
    ...overrides,
  };
}

function derive(pages: ScannedPage[], overrides: Partial<Parameters<typeof deriveFindings>[0]> = {}) {
  return deriveFindings({
    domain: "client.com",
    robots: robots(),
    sitemapFound: true,
    pages,
    subjectNames: ["Lumina Group"],
    monitoredDimensions: { neighborhoods: [], buildings: [] },
    currentYear: CURRENT_YEAR,
    ...overrides,
  });
}

describe("unknown never becomes a negative finding", () => {
  it("healthy connected pages produce no findings", () => {
    const home = page("https://client.com/", "homepage", {
      outlinks: [{ url: "https://client.com/team", anchor: "Team" }],
      jsonLd: [
        {
          "@type": "RealEstateAgent",
          name: "Lumina Group",
          url: "https://client.com/",
          address: "x",
          areaServed: "Jersey City",
          telephone: "y",
          image: "z",
        },
      ],
    });
    const team = page("https://client.com/team", "team", {
      outlinks: [{ url: "https://client.com/", anchor: "Home" }],
      jsonLd: [
        {
          "@type": "RealEstateAgent",
          name: "Lumina Group",
          url: "https://client.com/team",
          address: "x",
          areaServed: "Jersey City",
          telephone: "y",
          image: "z",
        },
      ],
      latestYearReferenced: CURRENT_YEAR,
    });
    expect(derive([home, team])).toEqual([]);
  });

  it("unreachable robots, absent noindex signal, missing dates, and no sitemap produce nothing negative", () => {
    const findings = derive(
      [
        page("https://client.com/press", "press", {
          noindex: null, // unknown — no signal observed
          latestYearReferenced: null, // no dates — freshness unknown
          inSitemap: false,
          outlinks: [{ url: "https://client.com/team", anchor: "t" }],
        }),
        page("https://client.com/team", "team", {
          inSitemap: false,
          outlinks: [{ url: "https://client.com/press", anchor: "p" }],
          jsonLd: [{ "@type": "Organization", name: "Lumina Group", url: "u", sameAs: ["x"], address: "a" }],
        }),
      ],
      {
        robots: robots({
          fetchStatus: null,
          present: false,
          fetchError: "network down",
          crawlerAccess: [],
        }),
        sitemapFound: false, // nothing to be absent from
      }
    );
    expect(findings).toEqual([]);
  });
});

describe("robots + indexability findings", () => {
  it("aggregates blocked AI crawlers into one high-severity finding with evidence", () => {
    const findings = derive([], {
      robots: robots({
        crawlerAccess: [
          { crawler: "Googlebot", rootAllowed: true, viaSpecificGroup: false, disallow: [] },
          { crawler: "GPTBot", rootAllowed: false, viaSpecificGroup: true, disallow: ["/"] },
          { crawler: "OAI-SearchBot", rootAllowed: false, viaSpecificGroup: true, disallow: ["/"] },
        ],
      }),
    });
    const blocked = findings.filter((f) => f.checkType === "robots_blocks_ai_crawler");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.severity).toBe("high");
    expect(blocked[0]!.observation).toContain("GPTBot");
    expect(blocked[0]!.observation).toContain("OAI-SearchBot");
    expect(blocked[0]!.observation).not.toContain("Googlebot,");
    expect(blocked[0]!.inference).toContain("not a guarantee");
    expect(blocked[0]!.recommendation).toContain("intentional");
  });

  it("flags noindex, canonical mismatch, errors, and redirects with page evidence", () => {
    const findings = derive([
      page("https://client.com/team", "team", { noindex: true, metaRobots: "noindex" }),
      page("https://client.com/neighborhoods/paulus-hook", "neighborhood", {
        canonicalUrl: "https://other.com/paulus-hook",
        outlinks: [{ url: "https://client.com/team", anchor: "x" }],
      }),
      page("https://client.com/buildings/99-hudson", "building", { httpStatus: 404, ok: false }),
      page("https://client.com/press", "press", {
        finalUrl: "https://client.com/news",
      }),
    ]);
    const types = findings.map((f) => f.checkType);
    expect(types).toContain("page_noindex");
    expect(types).toContain("canonical_mismatch");
    expect(types).toContain("page_error");
    expect(types).toContain("page_redirected");
    const canonical = findings.find((f) => f.checkType === "canonical_mismatch")!;
    expect(canonical.severity).toBe("high"); // cross-host
    expect(canonical.detail.canonicalUrl).toBe("https://other.com/paulus-hook");
    const error = findings.find((f) => f.checkType === "page_error")!;
    expect(error.severity).toBe("high");
    expect(error.detail.httpStatus).toBe(404);
  });

  it("a canonical pointing at the page itself (formatting differences aside) is not a mismatch", () => {
    const findings = derive([
      page("https://client.com/team/", "team", {
        canonicalUrl: "https://client.com/team",
        outlinks: [{ url: "https://client.com/press", anchor: "x" }],
      }),
      page("https://client.com/press", "press", {
        outlinks: [{ url: "https://client.com/team/", anchor: "x" }],
      }),
    ]);
    expect(findings.map((f) => f.checkType)).not.toContain("canonical_mismatch");
  });
});

describe("orphans and sitemap coverage", () => {
  it("finds orphaned authority pages, counting inlinks across url and finalUrl", () => {
    const findings = derive([
      page("https://client.com/", "homepage", {
        outlinks: [{ url: "https://client.com/team", anchor: "Team" }],
      }),
      page("https://client.com/team", "team", { outlinks: [] }),
      page("https://client.com/buildings/99-hudson", "building", { outlinks: [] }),
    ]);
    const orphans = findings.filter((f) => f.checkType === "orphan_page");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.pageUrl).toBe("https://client.com/buildings/99-hudson");
    expect(orphans[0]!.observation).toContain("zero internal links");
    expect(orphans[0]!.observation).toContain("3 scanned pages");
  });

  it("excludes configured URLs and never calls the homepage an orphan", () => {
    const findings = derive(
      [
        page("https://client.com/", "homepage", { outlinks: [] }),
        page("https://client.com/buildings/99-hudson", "building", { outlinks: [] }),
      ],
      { orphanExcludeUrls: ["https://client.com/buildings/99-hudson"] }
    );
    expect(findings.filter((f) => f.checkType === "orphan_page")).toEqual([]);
  });

  it("flags authority pages missing from a discovered sitemap — observation phrasing only", () => {
    const findings = derive([
      page("https://client.com/press", "press", {
        inSitemap: false,
        discoveredVia: "crawl",
        outlinks: [{ url: "https://client.com/", anchor: "x" }],
      }),
      page("https://client.com/", "homepage", {
        outlinks: [{ url: "https://client.com/press", anchor: "x" }],
      }),
    ]);
    const missing = findings.find((f) => f.checkType === "missing_from_sitemap")!;
    expect(missing).toBeDefined();
    expect(missing.severity).toBe("low");
    expect(missing.observation).toContain("not found in any discovered sitemap");
    expect(missing.inference).toContain("not proof");
  });
});

describe("freshness, schema, and intent coverage", () => {
  it("stale authority page is an update opportunity, never 'bad content'", () => {
    const findings = derive([
      page("https://client.com/neighborhoods/paulus-hook", "neighborhood", {
        latestYearReferenced: CURRENT_YEAR - 2,
        outlinks: [{ url: "https://client.com/team", anchor: "x" }],
      }),
      page("https://client.com/team", "team", {
        outlinks: [{ url: "https://client.com/neighborhoods/paulus-hook", anchor: "x" }],
        jsonLd: [{ "@type": "Organization", name: "Lumina Group", url: "u", sameAs: ["x"], address: "a" }],
      }),
    ]);
    const stale = findings.find((f) => f.checkType === "stale_authority_page")!;
    expect(stale).toBeDefined();
    expect(stale.severity).toBe("low");
    expect(stale.observation).toContain(String(CURRENT_YEAR - 2));
    expect(stale.inference).toContain("update opportunity");
  });

  it("schema findings retain the observed evidence and never invent values", () => {
    const findings = derive([
      page("https://client.com/team", "team", {
        outlinks: [{ url: "https://client.com/", anchor: "x" }],
        jsonLd: [{ "@type": "RealEstateAgent", name: "Someone Else Realty" }],
      }),
      page("https://client.com/", "homepage", {
        outlinks: [{ url: "https://client.com/team", anchor: "x" }],
        jsonLd: [],
      }),
    ]);
    const inconsistent = findings.find((f) => f.checkType === "inconsistent_entity_schema")!;
    expect(inconsistent).toBeDefined();
    const observed = (inconsistent.detail.observations as Record<string, unknown>[])[0]!;
    expect(observed.name).toBe("Someone Else Realty");
    const missing = findings.find(
      (f) => f.checkType === "missing_entity_schema" && f.pageUrl === "https://client.com/"
    );
    expect(missing).toBeDefined();
  });

  it("aggregates uncovered monitored dimensions into one finding", () => {
    const findings = derive(
      [
        page("https://client.com/neighborhoods/paulus-hook", "neighborhood", {
          title: "Paulus Hook",
          outlinks: [{ url: "https://client.com/", anchor: "x" }],
        }),
        page("https://client.com/", "homepage", {
          outlinks: [{ url: "https://client.com/neighborhoods/paulus-hook", anchor: "x" }],
          jsonLd: [{ "@type": "Organization", name: "Lumina Group", url: "u", sameAs: ["x"], address: "a" }],
        }),
      ],
      {
        monitoredDimensions: {
          neighborhoods: ["Paulus Hook", "The Heights"],
          buildings: ["99 Hudson"],
        },
      }
    );
    const coverage = findings.filter((f) => f.checkType === "intent_coverage_gap");
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.observation).toContain("The Heights");
    expect(coverage[0]!.observation).toContain("99 Hudson");
    expect(coverage[0]!.observation).not.toContain('"Paulus Hook"');
    expect(coverage[0]!.detail.missingNeighborhoods).toEqual(["The Heights"]);
  });
});

describe("severity vs priority", () => {
  it("keeps them separate: a low-severity schema gap can outrank nothing, an orphaned building page lands in a high band", () => {
    const findings = derive([
      page("https://client.com/", "homepage", {
        outlinks: [],
        jsonLd: [{ "@type": "Organization", name: "Lumina Group", url: "u", sameAs: ["x"], address: "a" }],
      }),
      page("https://client.com/buildings/99-hudson", "building", { outlinks: [] }),
      page("https://client.com/blog/some-post", "blog", {
        outlinks: [],
        canonicalUrl: "https://client.com/blog/other",
      }),
    ]);
    const orphan = findings.find((f) => f.checkType === "orphan_page")!;
    const blogCanonical = findings.find((f) => f.checkType === "canonical_mismatch")!;
    // Same-ish severity ordering does not decide priority: the authority
    // orphan outranks the blog canonical despite lower severity.
    expect(orphan.severity).toBe("medium");
    expect(blogCanonical.severity).toBe("medium");
    expect(orphan.priorityScore).toBeGreaterThan(blogCanonical.priorityScore);
    // Formula inputs are exposed for reproducibility.
    const priority = orphan.detail.priority as { formulaVersion: string; inputs: Record<string, number> };
    expect(priority.formulaVersion).toBe("site-priority-v1");
    expect(priority.inputs.commercial).toBe(1);
  });
});

describe("schema-check unit behavior", () => {
  it("no relevant blocks + not entity-expected = no observations at all", () => {
    expect(
      checkStructuredData({
        blocks: [{ "@type": "Recipe", name: "Soup" }],
        parseError: null,
        expectEntity: false,
        subjectNames: ["Lumina Group"],
      })
    ).toEqual([]);
  });

  it("complete entity block is informational only", () => {
    const observations = checkStructuredData({
      blocks: [
        {
          "@type": "RealEstateAgent",
          name: "Lumina Group",
          url: "https://client.com",
          address: "1 Main St",
          areaServed: "Jersey City",
          telephone: "201",
          image: "img",
        },
      ],
      parseError: null,
      expectEntity: true,
      subjectNames: ["Lumina Group"],
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]!.kind).toBe("informational");
  });
});
