import { describe, expect, it } from "vitest";
import { classifySource } from "@/lib/sources/classify";

const context = {
  subjectDomain: "parva.io",
  competitorDomains: ["gambino.com", "elliman.com"],
};

describe("classifySource (deterministic v1)", () => {
  it("owned domains are client_site regardless of type lists", () => {
    expect(classifySource("parva.io", context)).toEqual({
      sourceType: "client_site",
      relationship: "owned",
    });
    expect(classifySource("blog.parva.io", context)).toEqual({
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
    const result = classifySource("parva.io", {
      subjectDomain: null,
      competitorDomains: [],
    });
    expect(result.relationship).toBe("third_party");
  });

  it("suffix matching never crosses domain boundaries", () => {
    // notparva.io must not match parva.io
    expect(classifySource("notparva.io", context).relationship).toBe("third_party");
  });
});
