/**
 * Spec 076: the slug is prospect-visible URL text — known-answer tested.
 * The key's length/alphabet is pinned because it IS the credential: a
 * regression to fewer bits weakens every link minted after it.
 */
import { describe, expect, it } from "vitest";
import { newLinkKey, slugifyBusinessName } from "@/lib/prospects/links";

describe("slugifyBusinessName", () => {
  it("kebab-cases ordinary names", () => {
    expect(slugifyBusinessName("NK Real Estate Group")).toBe("nk-real-estate-group");
    expect(slugifyBusinessName("The Foster Tucker Team")).toBe("the-foster-tucker-team");
  });

  it("handles punctuation, ampersands, and diacritics", () => {
    expect(slugifyBusinessName("Smith & Sons, LLC.")).toBe("smith-and-sons-llc");
    expect(slugifyBusinessName("Café Real Estate — José's Team")).toBe(
      "cafe-real-estate-jose-s-team"
    );
  });

  it("collapses runs and trims edge dashes", () => {
    expect(slugifyBusinessName("  --Team   Moza--  ")).toBe("team-moza");
  });

  it("caps length without a trailing dash", () => {
    const slug = slugifyBusinessName("A".repeat(200) + " " + "B".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("never returns an empty slug", () => {
    expect(slugifyBusinessName("株式会社")).toBe("audit");
    expect(slugifyBusinessName("!!!")).toBe("audit");
  });
});

describe("newLinkKey", () => {
  it("is 16 base64url characters (96 bits)", () => {
    for (let i = 0; i < 20; i += 1) {
      const key = newLinkKey();
      expect(key).toMatch(/^[A-Za-z0-9_-]{16}$/);
    }
  });

  it("does not repeat", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => newLinkKey()));
    expect(keys.size).toBe(1000);
  });
});
