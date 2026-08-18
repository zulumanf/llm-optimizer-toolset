import { describe, expect, it } from "vitest";
import { classifySource } from "@/lib/sources/classify";

const context = {
  subjectDomain: "lumina.io",
  competitorDomains: ["gambino.com", "elliman.com"],
};

describe("classifySource (deterministic v1)", () => {
  it("owned domains are client_site regardless of type lists", () => {
    expect(classifySource("lumina.io", context)).toEqual({
      sourceType: "client_site",
      relationship: "owned",
    });
    expect(classifySource("blog.lumina.io", context)).toEqual({
      sourceType: "client_site",
      relationship: "owned",
    });
  });

  it("tracked competitor domains classify as competitor", () => {
    expect(classifySource("gambino.com", context).relationship).toBe("competitor");
    // A competitor that is also a known brokerage keeps the brokerage type.
    expect(classifySource("elliman.com", context)).toEqual({
      sourceType: "brokerage",
      relationship: "competitor",
    });
    // Unknown competitor domain defaults to brokerage type (their site).
    expect(classifySource("gambino.com", context).sourceType).toBe("brokerage");
  });

  it("classifies well-known third-party categories", () => {
    expect(classifySource("zillow.com", context).sourceType).toBe("portal");
    expect(classifySource("www.zillow.com", context).sourceType).toBe("portal");
    expect(classifySource("therealdeal.com", context).sourceType).toBe("news");
    expect(classifySource("youtube.com", context).sourceType).toBe("video");
    expect(classifySource("linkedin.com", context).sourceType).toBe("social");
    expect(classifySource("yelp.com", context).sourceType).toBe("review");
    expect(classifySource("nyc.gov", context).sourceType).toBe("government");
    for (const domain of ["zillow.com", "therealdeal.com", "nyc.gov"]) {
      expect(classifySource(domain, context).relationship).toBe("third_party");
    }
  });

  it("unknown domains are honest 'other', never guessed", () => {
    expect(classifySource("somebodysblog.net", context)).toEqual({
      sourceType: "other",
      relationship: "third_party",
    });
  });

  it("no subject domain → nothing is owned", () => {
    const result = classifySource("lumina.io", {
      subjectDomain: null,
      competitorDomains: [],
    });
    expect(result.relationship).toBe("third_party");
  });

  it("suffix matching never crosses domain boundaries", () => {
    // notlumina.io must not match lumina.io
    expect(classifySource("notlumina.io", context).relationship).toBe("third_party");
  });

  it("v2: industry rankings and local press classify as their own types", () => {
    expect(classifySource("realtrends.com", context).sourceType).toBe(
      "industry_ranking"
    );
    expect(classifySource("www.realtrends.com", context).sourceType).toBe(
      "industry_ranking"
    );
    expect(classifySource("jerseydigs.com", context).sourceType).toBe("local_press");
    expect(classifySource("nj.com", context).sourceType).toBe("local_press");
    // National real-estate press stays news, not local_press.
    expect(classifySource("therealdeal.com", context).sourceType).toBe("news");
  });

  it("v2: market packs can extend local press via context", () => {
    expect(
      classifySource("hudsonreporter.com", {
        ...context,
        localPressDomains: ["hudsonreporter.com"],
      }).sourceType
    ).toBe("local_press");
    // Without the context entry it stays honest 'other'.
    expect(classifySource("hudsonreporter.com", context).sourceType).toBe("other");
  });

  it("v2: an owned domain outranks every type list, including the new ones", () => {
    expect(
      classifySource("jerseydigs.com", {
        subjectDomain: "jerseydigs.com",
        competitorDomains: [],
      })
    ).toEqual({ sourceType: "client_site", relationship: "owned" });
  });
});
