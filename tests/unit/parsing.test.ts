import { describe, expect, it } from "vitest";
import {
  scanAliases,
  extractUrls,
  urlDomain,
  detectListItems,
  excerptFor,
} from "@/lib/parsing/prepass";
import { classifyResponse, type CompanyInput } from "@/lib/parsing/classify";

const lumina: CompanyInput = {
  id: "lumina",
  name: "Lumina",
  aliases: ["lumina.com", "Lumina App"],
  domain: "lumina.com",
};
const acme: CompanyInput = {
  id: "acme",
  name: "Acme",
  aliases: [],
  domain: "acme.io",
};
const companies = [lumina, acme];

describe("scanAliases", () => {
  it("matches with word boundaries, case-insensitively", () => {
    const hits = scanAliases("I like LUMINA a lot", [lumina]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tier).toBe("canonical");
  });

  it("does not match inside larger words (Lumina vs Luminati)", () => {
    expect(scanAliases("Luminati is a goddess", [lumina])).toHaveLength(0);
    expect(scanAliases("the luminader tool", [lumina])).toHaveLength(0);
  });

  it("falls back to alias tier when the canonical name is absent", () => {
    const hits = scanAliases("check out lumina.com today", [lumina]);
    expect(hits[0]?.tier).toBe("alias");
    expect(hits[0]?.matched).toBe("lumina.com");
  });
});

describe("extractUrls / urlDomain", () => {
  it("extracts urls and strips trailing punctuation", () => {
    const urls = extractUrls("See https://lumina.com/docs, or (https://acme.io).");
    expect(urls).toEqual(["https://lumina.com/docs", "https://acme.io"]);
    expect(urlDomain("https://www.Lumina.com/x")).toBe("lumina.com");
  });
});

describe("detectListItems", () => {
  it("detects numbered and bulleted lists with positions", () => {
    const items = detectListItems("Top picks:\n1. Acme\n2) Lumina\n- Other tool");
    expect(items.map((i) => [i.position, i.text])).toEqual([
      [1, "Acme"],
      [2, "Lumina"],
      [3, "Other tool"],
    ]);
  });
});

describe("excerptFor", () => {
  it("returns the verbatim sentence containing the term", () => {
    const text = "First sentence. Lumina is a solid option. Last sentence.";
    const excerpt = excerptFor(text, "Lumina");
    expect(excerpt).toBe("Lumina is a solid option.");
    expect(text.includes(excerpt as string)).toBe(true);
  });
});

describe("classifyResponse", () => {
  it("detects explicit recommendations with high confidence", () => {
    const drafts = classifyResponse(
      "I'd recommend Lumina for this — excellent tool.",
      companies
    );
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.recommended).toBe(true);
    expect(d.sentiment).toBe("positive");
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
    expect(d.needsReview).toBe(false);
  });

  it("treats top-of-list placement as a recommendation", () => {
    const drafts = classifyResponse("Options:\n1. Lumina\n2. Acme", companies);
    const p = drafts.find((d) => d.companyId === "lumina")!;
    const a = drafts.find((d) => d.companyId === "acme")!;
    expect(p.recommended).toBe(true);
    expect(p.listPosition).toBe(1);
    expect(a.recommended).toBe(false);
    expect(a.listPosition).toBe(2);
  });

  it("flags alias-only mixed-sentiment prose for review (< 0.7)", () => {
    const drafts = classifyResponse(
      "Some teams use lumina.com for planning. The features are solid but support can be limited.",
      companies
    );
    const d = drafts[0]!;
    expect(d.sentiment).toBe("mixed");
    expect(d.confidence).toBeLessThan(0.7);
    expect(d.needsReview).toBe(true);
  });

  it("attributes cited urls by company domain", () => {
    const drafts = classifyResponse(
      "Lumina (see https://lumina.com/pricing and https://other.com) is fine.",
      companies
    );
    expect(drafts[0]?.citedUrls).toEqual(["https://lumina.com/pricing"]);
  });

  it("produces no drafts for unmentioned companies or empty text", () => {
    expect(classifyResponse("Nothing relevant here.", companies)).toHaveLength(0);
    expect(classifyResponse("", companies)).toHaveLength(0);
  });
});
