/**
 * Site discovery ranking and filtering.
 *
 * The network parts are exercised against real sites by hand; what is tested
 * here is the logic that decides WHICH urls are worth fetching, because that
 * is where a capped crawl silently wastes its budget.
 *
 * The placeholder case is from the first real crawl: jcluxury.com's sitemap
 * contained nine URLs like `/agents/{{slug}}` and `/agents/${makeLnk(i)}`,
 * left over from client-side templating. They sit under a high-value path, so
 * they sorted to the very top and consumed the entire page budget before the
 * actual team page was reached.
 */
import { describe, expect, it } from "vitest";
import { rankUrls, shouldSkipUrl, scoreUrlForAudit } from "@/lib/knowledge/sources/discover";

describe("audit value scoring", () => {
  it("ranks the roster and project pages above general content", () => {
    expect(scoreUrlForAudit("https://x.com/team").score).toBeGreaterThan(
      scoreUrlForAudit("https://x.com/blog/some-post").score
    );
    expect(scoreUrlForAudit("https://x.com/developments").score).toBeGreaterThan(
      scoreUrlForAudit("https://x.com/contact").score
    );
  });

  it("labels why a page was ranked, not just how highly", () => {
    expect(scoreUrlForAudit("https://x.com/agents/jane-doe").kind).toBe("roster");
    expect(scoreUrlForAudit("https://x.com/developments/the-summit").kind).toBe("projects");
    expect(scoreUrlForAudit("https://x.com/about-us").kind).toBe("about");
    expect(scoreUrlForAudit("https://x.com/").kind).toBe("homepage");
  });

  it("treats an unrecognised path as background, not as valuable", () => {
    expect(scoreUrlForAudit("https://x.com/random-thing").score).toBeLessThan(20);
  });
});

describe("skip rules", () => {
  it("skips unrendered template syntax in both raw and encoded form", () => {
    // These are always 404s and they outrank real pages, because the path
    // prefix looks valuable.
    for (const url of [
      "https://x.com/agents/{{slug}}",
      "https://x.com/agents/${makeLnk(1)}",
      "https://x.com/agents/%7B%7BfeedUrl%7D%7D",
      "https://x.com/agents/$%7Bresult.placeUrl%7D",
    ]) {
      expect(shouldSkipUrl(url), url).toBe(true);
    }
  });

  it("keeps the real pages that sit alongside them", () => {
    expect(shouldSkipUrl("https://x.com/agents/alexander-calle")).toBe(false);
    expect(shouldSkipUrl("https://x.com/team")).toBe(false);
    expect(shouldSkipUrl("https://x.com/developments")).toBe(false);
  });

  it("skips boilerplate, assets and endless listing detail", () => {
    for (const url of [
      "https://x.com/privacy-policy",
      "https://x.com/wp-json/v2/posts",
      "https://x.com/hero.jpg",
      "https://x.com/listings/jersey-city/123-main-st",
      "https://x.com/blog/page/7",
    ]) {
      expect(shouldSkipUrl(url), url).toBe(true);
    }
  });

  it("drops tracking parameters rather than fetching the same page twice", () => {
    expect(shouldSkipUrl("https://x.com/team?utm_source=newsletter")).toBe(true);
  });
});

describe("queue ranking", () => {
  it("puts the pages an audit needs ahead of the ones it does not", () => {
    const ranked = rankUrls([
      "https://x.com/blog/market-update",
      "https://x.com/contact",
      "https://x.com/team",
      "https://x.com/developments",
      "https://x.com/",
    ]);
    // Roster, homepage, projects — the homepage ranks high because it carries
    // the entity description an audit needs most, and a client-side-rendered
    // roster often leaves it as the only page stating who the team is.
    expect(ranked.slice(0, 3)).toEqual([
      "https://x.com/team",
      "https://x.com/",
      "https://x.com/developments",
    ]);
    // Everything an audit actually needs outranks contact details and blog.
    expect(ranked.indexOf("https://x.com/contact")).toBeGreaterThan(
      ranked.indexOf("https://x.com/developments")
    );
  });

  it("removes skipped urls from the queue entirely", () => {
    const ranked = rankUrls([
      "https://x.com/agents/{{slug}}",
      "https://x.com/team",
      "https://x.com/privacy",
    ]);
    expect(ranked).toEqual(["https://x.com/team"]);
  });
});
