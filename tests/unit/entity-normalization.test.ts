import { describe, expect, it } from "vitest";
import {
  domainBelongsTo,
  entityMatchIndex,
  normalizeEntityText,
  normalizeOwnerDomain,
  scanAliases,
  textNamesTerm,
} from "@/lib/parsing/prepass";

describe("domainBelongsTo (spec 151 A6 regression)", () => {
  it("rejects a suffix that is not a dot boundary", () => {
    expect(domainBelongsTo("notacme.com", "acme.com")).toBe(false);
    expect(domainBelongsTo("bestacme.com", "acme.com")).toBe(false);
  });
  it("accepts the exact host and true subdomains", () => {
    expect(domainBelongsTo("acme.com", "acme.com")).toBe(true);
    expect(domainBelongsTo("blog.acme.com", "acme.com")).toBe(true);
    expect(domainBelongsTo("www.acme.com", "acme.com")).toBe(true);
  });
  it("normalizes stored owner domains (scheme, www, path, case, port)", () => {
    expect(normalizeOwnerDomain("https://WWW.Acme.com/about")).toBe("acme.com");
    expect(normalizeOwnerDomain("acme.com:443")).toBe("acme.com");
    expect(domainBelongsTo("acme.com", "https://www.acme.com/")).toBe(true);
  });
  it("missing inputs never match", () => {
    expect(domainBelongsTo(null, "acme.com")).toBe(false);
    expect(domainBelongsTo("acme.com", null)).toBe(false);
    expect(domainBelongsTo("acme.com", "")).toBe(false);
  });
});

describe("normalizeEntityText", () => {
  it("folds &, possessives, punctuation and case; keeps domain periods", () => {
    expect(normalizeEntityText("Smith & Jones' Realty, LLC").text).toBe("smith and jones realty|llc");
    expect(normalizeEntityText("The Kirsch Team's agents").text).toBe("the kirsch team agents");
    expect(normalizeEntityText("Visit lumina.com today").text).toBe("visit lumina.com today");
  });
  it("maps normalized positions back to the raw text", () => {
    const raw = "Try  Smith & Jones";
    const { text, map } = normalizeEntityText(raw);
    const idx = text.indexOf("smith");
    expect(raw.slice(map[idx] as number, (map[idx] as number) + 5)).toBe("Smith");
  });
});

describe("entity matching recall gains (multi-token, measured)", () => {
  const cases: [string, string][] = [
    ["Smith & Jones Realty is a strong choice.", "Smith and Jones Realty"],
    ["Smith and Jones Realty is a strong choice.", "Smith & Jones Realty"],
    ["I'd look at the Kirsch Team's listings.", "Kirsch Team"],
    ["Blu House — Grand Rapids is active.", "Blu House Grand Rapids"],
  ];
  for (const [text, term] of cases) {
    it(`finds "${term}" in "${text}"`, () => {
      expect(entityMatchIndex(text, term)).toBeGreaterThanOrEqual(0);
    });
  }
  it("reports a raw-text position for a normalized hit", () => {
    const text = "Top picks: Smith & Jones Realty";
    expect(entityMatchIndex(text, "Smith and Jones Realty")).toBe(text.indexOf("Smith"));
  });
});

describe("entity matching precision guards", () => {
  it("never matches inside a domain continuation", () => {
    expect(textNamesTerm("See bluhouse.com for details", "Blu House")).toBe(false);
    expect(textNamesTerm("lumina.com", "Lumina")).toBe(false);
  });
  it("never matches inside a longer word", () => {
    expect(textNamesTerm("an encompassing view", "Compass")).toBe(false);
    expect(textNamesTerm("The Smith Jonesboro office", "Smith Jones")).toBe(false);
  });
  it("single-token names gain no normalized path (no new partial hits)", () => {
    expect(entityMatchIndex("Elite's", "Elite")).toBe(0);
    expect(entityMatchIndex("Elites", "Elite")).toBe(-1);
  });
  it("person, team and brokerage stay distinct entities", () => {
    const hits = scanAliases("Jane Kirsch of the Kirsch Team at Compass", [
      { id: "person", name: "Jane Kirsch", aliases: [] },
      { id: "team", name: "Kirsch Team", aliases: [] },
      { id: "brokerage", name: "Compass", aliases: [] },
      { id: "other-team", name: "Kirsch Group", aliases: [] },
    ]);
    expect(hits.map((h) => h.companyId).sort()).toEqual(["brokerage", "person", "team"]);
  });
});

describe("normalization never matches across sentence or list boundaries (review H2)", () => {
  it.each([
    ["Agents in Charleston. Real estate agents there…", "Charleston Real Estate"],
    ["Teams in North Carolina. One agent stood out.", "Carolina One"],
    ["Try Smith, Jones Realty, or others.", "Smith Jones Realty"],
    ["Top: Keller\nWilliams Realty is not this", "Keller Williams Realty"],
  ])("%s ✗ %s", (text, term) => {
    expect(entityMatchIndex(text, term)).toBe(-1);
  });
  it("still matches inside a sentence", () => {
    expect(entityMatchIndex("I like Smith & Jones Realty a lot.", "Smith and Jones Realty")).toBeGreaterThan(0);
  });
});
