/**
 * Crawlability surface (marketing site): robots, sitemap, llms.txt, canonical
 * metadata and JSON-LD all derive from the single page registry, so these
 * tests pin the invariants a crawler relies on.
 */
import { describe, expect, it } from "vitest";
import robots, { ROBOTS_DISALLOW } from "@/app/robots";
import sitemap from "@/app/sitemap";
import { llmsTxt } from "@/lib/marketing/llms-txt";
import { serializeJsonLd } from "@/components/marketing/json-ld";
import { MARKETING_DEFAULT_ORIGIN, MARKETING_PAGES, MARKETING_PREFIXES, marketingOrigin } from "@/lib/marketing/constants";
import { articleLd, breadcrumbLd, canonicalUrl, faqLd, marketingMetadata, organizationLd } from "@/lib/marketing/seo";
import { FAQ } from "@/lib/marketing/faq";

describe("marketingOrigin", () => {
  it("uses the first configured host, else the default", () => {
    expect(marketingOrigin("recommendedfirst.com,www.recommendedfirst.com")).toBe("https://recommendedfirst.com");
    expect(marketingOrigin(undefined)).toBe(MARKETING_DEFAULT_ORIGIN);
  });
});

describe("page registry", () => {
  it("every registered page lives under a public marketing prefix", () => {
    for (const p of MARKETING_PAGES) {
      expect(MARKETING_PREFIXES.some((prefix) => p.path === prefix || p.path.startsWith(`${prefix}/`))).toBe(true);
      expect(p.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.description.length).toBeGreaterThan(40);
    }
  });
  it("titles and descriptions are unique", () => {
    expect(new Set(MARKETING_PAGES.map((p) => p.title)).size).toBe(MARKETING_PAGES.length);
    expect(new Set(MARKETING_PAGES.map((p) => p.description)).size).toBe(MARKETING_PAGES.length);
  });
});

describe("robots", () => {
  it("allows everything except private and app surfaces, for every crawler", () => {
    const r = robots();
    expect(r.rules).toEqual([{ userAgent: "*", allow: "/", disallow: [...ROBOTS_DISALLOW] }]);
    for (const p of MARKETING_PAGES) {
      expect(ROBOTS_DISALLOW.some((d) => canonicalUrl(p.path).replace(marketingOrigin(), "").startsWith(d))).toBe(false);
    }
    expect(ROBOTS_DISALLOW).toEqual(expect.arrayContaining(["/report/", "/audit/", "/api/", "/portal/"]));
    expect(r.sitemap).toBe(`${marketingOrigin()}/sitemap.xml`);
  });
});

describe("sitemap", () => {
  it("lists every registered page once with its canonical URL", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual(MARKETING_PAGES.map((p) => canonicalUrl(p.path)));
    expect(urls[0]).toBe(`${marketingOrigin()}/`);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("llms.txt", () => {
  it("maps the site, links every page, and states that nothing is guaranteed", () => {
    const text = llmsTxt();
    expect(text.startsWith("# Recommended First")).toBe(true);
    for (const p of MARKETING_PAGES) expect(text).toContain(canonicalUrl(p.path));
    expect(text).toContain("do not guarantee rankings");
    expect(text).not.toMatch(/ChatGPT app.*recommend/);
  });
});

describe("metadata + JSON-LD", () => {
  it("canonicalizes /home to the origin root and sets robots index", () => {
    const m = marketingMetadata("/home");
    expect(m.alternates?.canonical).toBe(`${marketingOrigin()}/`);
    expect(marketingMetadata("/faq").alternates?.canonical).toBe(`${marketingOrigin()}/faq`);
    expect(m.robots).toEqual({ index: true, follow: true });
  });
  it("breadcrumbs nest research reports under /research", () => {
    const b = breadcrumbLd("/research/jersey-city-ai-visibility-report") as { itemListElement: { name: string }[] };
    expect(b.itemListElement.map((i) => i.name)).toEqual(["Recommended First", "Research", "Jersey City AI Visibility Report"]);
  });
  it("organization schema carries no ratings, reviews or awards", () => {
    const o = organizationLd();
    for (const k of ["aggregateRating", "review", "award", "address"]) expect(o).not.toHaveProperty(k);
  });
  it("article and FAQ schemas are well-formed and escape script terminators", () => {
    expect(articleLd("/research", { published: "2026-09-13", benchmarkWindow: "2026-08-31" })).toMatchObject({ "@type": "Article", datePublished: "2026-09-13" });
    expect((faqLd(FAQ) as { mainEntity: unknown[] }).mainEntity).toHaveLength(FAQ.length);
    expect(serializeJsonLd({ x: "</script>" })).not.toContain("</script>");
  });
});
