/**
 * Known-answer tests for prospect ↔ company resolution (spec 041) and the
 * prospect-source registry guard.
 */
import { describe, expect, it } from "vitest";
import {
  resolveProspectCompany,
  MATCH_THRESHOLD,
  POSSIBLE_THRESHOLD,
  type CompanyRef,
} from "@/lib/prospects/resolve";
import { getProspectSource, PROSPECT_SOURCE_IDS } from "@/lib/prospects/providers/registry";
import { mockProspectSource } from "@/lib/prospects/providers/mock";

let n = 0;
const company = (name: string, over: Partial<CompanyRef> = {}): CompanyRef => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  name,
  aliases: [],
  domain: null,
  ...over,
});

describe("resolveProspectCompany", () => {
  it("matches an exact normalized name — The/Team/Group noise stripped", () => {
    const rivera = company("Rivera Team");
    const result = resolveProspectCompany(
      { businessName: "The Rivera Group" },
      [rivera, company("Acme")]
    );
    expect(result.verdict).toBe("match");
    expect(result.companyId).toBe(rivera.id);
    expect(result.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    expect(result.reasons.join(" ")).toContain("Business name matches");
  });

  it("matches via alias and via website domain", () => {
    const smith = company("Smith Group", { aliases: ["The Smith Team"] });
    const byAlias = resolveProspectCompany({ businessName: "Smith Team" }, [smith]);
    expect(byAlias.verdict).toBe("match");

    const domained = company("Something Different", { domain: "riverateam.com" });
    const byDomain = resolveProspectCompany(
      { businessName: "Rivera Homes", website: "https://www.riverateam.com/about" },
      [domained]
    );
    expect(byDomain.verdict).toBe("match");
    expect(byDomain.companyId).toBe(domained.id);
    expect(byDomain.reasons.join(" ")).toContain("domain");
  });

  it("a brokerage affiliation match is never proposed as the team's identity", () => {
    const compass = company("Compass");
    const result = resolveProspectCompany(
      { businessName: "Rivera Team", brokerageAffiliation: "Compass" },
      [compass]
    );
    expect(result.verdict).toBe("none");
    expect(result.companyId).toBeNull();
    expect(result.brokerageCollisions).toEqual([
      expect.objectContaining({ companyId: compass.id }),
    ]);
    expect(result.brokerageCollisions[0]!.reason).toContain("brokerage is not the team");
  });

  it("the brokerage rule yields to a domain tie — identity beats affiliation", () => {
    const compass = company("Compass", { domain: "riverateam.com" });
    const result = resolveProspectCompany(
      {
        businessName: "Rivera Team",
        brokerageAffiliation: "Compass",
        website: "riverateam.com",
      },
      [compass]
    );
    expect(result.verdict).toBe("match");
    expect(result.brokerageCollisions).toEqual([]);
  });

  it("partial-name containment is possible, not match — a human decides", () => {
    const result = resolveProspectCompany(
      { businessName: "John Smith Team at Compass" },
      [company("John Smith")]
    );
    expect(result.verdict).toBe("possible");
    expect(result.companyId).toBeNull(); // possible never auto-links
    expect(result.confidence).toBeGreaterThanOrEqual(POSSIBLE_THRESHOLD);
    expect(result.confidence).toBeLessThan(MATCH_THRESHOLD);
  });

  it("two equal top scores are ambiguity → possible with both listed", () => {
    const a = company("Rivera Team");
    const b = company("Rivera Team NYC", { aliases: ["Rivera Team"] });
    const result = resolveProspectCompany({ businessName: "Rivera Team" }, [a, b]);
    expect(result.verdict).toBe("possible");
    expect(result.companyId).toBeNull();
    expect(result.reasons[0]).toContain("score equally");
    expect(result.candidates.length).toBe(2);
  });

  it("the team leader's name in the company strengthens a weak match", () => {
    const weak = resolveProspectCompany(
      { businessName: "John Smith Team at Compass" },
      [company("John Smith")]
    );
    const strengthened = resolveProspectCompany(
      { businessName: "John Smith Team at Compass", teamLeader: "John Smith" },
      [company("John Smith")]
    );
    expect(strengthened.confidence).toBeGreaterThan(weak.confidence);
  });

  it("returns none — with a stated reason — when nothing is tracked or similar", () => {
    const result = resolveProspectCompany({ businessName: "Rivera Team" }, [
      company("Acme Realty"),
    ]);
    expect(result.verdict).toBe("none");
    expect(result.companyId).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("prospect source registry", () => {
  it("lists the mock adapter and serves it in tests", async () => {
    expect(PROSPECT_SOURCE_IDS).toContain("mock");
    const adapter = getProspectSource("mock");
    expect((await adapter.validateConfiguration()).ok).toBe(true);
  });

  it("rejects unknown providers", () => {
    expect(() => getProspectSource("zillow-premier")).toThrow(/Unknown prospect source/);
  });

  it("mock discovery returns deterministic enveloped fixtures", async () => {
    const first = await mockProspectSource.discoverProspects({ marketName: "Miami" });
    const second = await mockProspectSource.discoverProspects({ marketName: "Miami" });
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(3);
    for (const record of first) {
      expect(record.provider).toBe("mock");
      expect(record.provenance).toBe("publicly_sourced");
      expect(record.confidence).toBeGreaterThan(0);
      expect(record.retrievedAt).toBeTruthy();
      expect(record.sourceUrl).toContain("Miami");
      expect(record.data.businessName.length).toBeGreaterThan(0);
    }
    const limited = await mockProspectSource.discoverProspects({
      marketName: "Miami",
      limit: 1,
    });
    expect(limited.length).toBe(1);
  });
});
