/**
 * Technical discoverability — deterministic check invariants (spec 088):
 * robots rules per crawler, sitemap parsing with lastmod, page-fact
 * extraction, and the rule that unknown data never becomes a negative fact.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateCrawlers,
  extractSitemapRefs,
} from "@/lib/discoverability/robots";
import { parseSitemapDoc } from "@/lib/discoverability/sitemap";
import {
  detectNoindex,
  extractCanonical,
  extractJsonLd,
  extractLinksWithAnchors,
  extractMetaRobots,
  yearsReferenced,
} from "@/lib/discoverability/page-facts";
import { classifyPage } from "@/lib/discoverability/classify-page";

describe("robots evaluation", () => {
  const body = [
    "User-agent: *",
    "Disallow: /private/",
    "",
    "User-agent: GPTBot",
    "Disallow: /",
    "",
    "User-agent: PerplexityBot",
    "Disallow: /",
    "Allow: /press/",
    "",
    "Sitemap: https://example.com/sitemap.xml",
    "Sitemap: https://example.com/sitemap-news.xml",
  ].join("\n");

  it("evaluates each crawler against its own applicable group", () => {
    const access = evaluateCrawlers(body, ["Googlebot", "GPTBot", "PerplexityBot"]);
    const by = new Map(access.map((a) => [a.crawler, a]));
    // Googlebot falls to the wildcard: /private/ blocked, root open.
    expect(by.get("Googlebot")!.rootAllowed).toBe(true);
    expect(by.get("Googlebot")!.viaSpecificGroup).toBe(false);
    // GPTBot is named and fully blocked.
    expect(by.get("GPTBot")!.rootAllowed).toBe(false);
    expect(by.get("GPTBot")!.viaSpecificGroup).toBe(true);
    // PerplexityBot: root blocked even though /press/ is re-allowed.
    expect(by.get("PerplexityBot")!.rootAllowed).toBe(false);
    expect(by.get("PerplexityBot")!.disallow).toEqual(["/"]);
  });

  it("extracts Sitemap directives (the field the spec-027 parser skips)", () => {
    expect(extractSitemapRefs(body)).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/sitemap-news.xml",
    ]);
    expect(extractSitemapRefs("User-agent: *\nDisallow:")).toEqual([]);
  });
});

describe("sitemap parsing", () => {
  it("keeps url + lastmod + source from <url> blocks", () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://a.com/team</loc><lastmod>2024-05-01</lastmod></url>
      <url><loc>https://a.com/press</loc></url>
    </urlset>`;
    const { entries, children } = parseSitemapDoc(xml, "https://a.com/sitemap.xml");
    expect(children).toEqual([]);
    expect(entries).toEqual([
      { url: "https://a.com/team", lastmod: "2024-05-01", sitemapUrl: "https://a.com/sitemap.xml" },
      { url: "https://a.com/press", lastmod: null, sitemapUrl: "https://a.com/sitemap.xml" },
    ]);
  });

  it("treats a document of sitemap <loc>s as an index", () => {
    const xml = `<sitemapindex>
      <loc>https://a.com/sitemap-pages.xml</loc>
      <loc>https://a.com/team</loc>
    </sitemapindex>`;
    const { entries, children } = parseSitemapDoc(xml, "https://a.com/sitemap_index.xml");
    expect(children).toEqual(["https://a.com/sitemap-pages.xml"]);
    expect(entries.map((e) => e.url)).toEqual(["https://a.com/team"]);
  });
});

describe("page facts", () => {
  it("extracts canonical regardless of attribute order", () => {
    expect(
      extractCanonical(
        `<link rel="canonical" href="/team/">`,
        "https://a.com/team"
      )
    ).toBe("https://a.com/team/");
    expect(
      extractCanonical(
        `<link href="https://a.com/other" rel="canonical">`,
        "https://a.com/team"
      )
    ).toBe("https://a.com/other");
    expect(extractCanonical(`<link rel="stylesheet" href="x.css">`, "https://a.com/")).toBeNull();
  });

  it("meta robots + X-Robots-Tag combine into noindex; no signal stays unknown", () => {
    expect(extractMetaRobots(`<meta name="robots" content="noindex, follow">`)).toBe(
      "noindex, follow"
    );
    expect(detectNoindex("noindex, follow", null)).toBe(true);
    expect(detectNoindex("index, follow", null)).toBe(false);
    expect(detectNoindex(null, "noindex")).toBe(true);
    // Unknown is null — NOT false, and never a finding.
    expect(detectNoindex(null, null)).toBeNull();
  });

  it("collects same-host links with anchors, dropping off-site and junk", () => {
    const html = `
      <a href="/neighborhoods/paulus-hook">Paulus Hook <b>guide</b></a>
      <a href="https://a.com/team#staff">Team</a>
      <a href="https://elsewhere.com/x">off-site</a>
      <a href="mailto:x@y.com">mail</a>
      <a href="/neighborhoods/paulus-hook">duplicate</a>`;
    const links = extractLinksWithAnchors(html, "https://a.com/");
    expect(links).toEqual([
      { url: "https://a.com/neighborhoods/paulus-hook", anchor: "Paulus Hook guide" },
      { url: "https://a.com/team", anchor: "Team" },
    ]);
  });

  it("parses JSON-LD including @graph, and records unparseable blocks", () => {
    const html = `
      <script type="application/ld+json">{"@graph":[{"@type":"RealEstateAgent","name":"Team A"}]}</script>
      <script type="application/ld+json">{not json}</script>`;
    const { blocks, error } = extractJsonLd(html);
    expect(blocks).toEqual([{ "@type": "RealEstateAgent", name: "Team A" }]);
    expect(error).not.toBeNull();
  });

  it("bounds years to plausible references", () => {
    const years = yearsReferenced(
      "Sold 12 homes in 2024, ranked #1 in 2019. Call 201-555-0100. Zip 07302. Est. 1985.",
      2026
    );
    expect(years).toEqual([2019, 2024]);
  });
});

describe("page classification", () => {
  it("classifies real-estate page kinds from url and title", () => {
    expect(classifyPage("https://a.com/", null)).toBe("homepage");
    expect(classifyPage("https://a.com/team", null)).toBe("team");
    expect(classifyPage("https://a.com/neighborhoods/paulus-hook", null)).toBe("neighborhood");
    expect(classifyPage("https://a.com/buildings/99-hudson", null)).toBe("building");
    expect(classifyPage("https://a.com/sold", null)).toBe("transaction");
    expect(classifyPage("https://a.com/press", null)).toBe("press");
    expect(classifyPage("https://a.com/random-page", "Our Sold Transactions")).toBe("transaction");
    expect(classifyPage("https://a.com/random-page", null)).toBe("generic");
  });
});
