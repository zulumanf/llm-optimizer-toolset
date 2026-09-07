/**
 * Spec 120 — brokerage-name normalization: naming variants must land in the
 * same cap bucket; genuinely different licensees must not.
 */
import { describe, expect, it } from "vitest";
import { normalizeBrokerage } from "@/lib/prospects/constants";

describe("normalizeBrokerage", () => {
  it("cuts a trailing corporate suffix", () => {
    expect(normalizeBrokerage("Long & Foster Real Estate Inc.")).toBe("long & foster real estate");
    expect(normalizeBrokerage("Long & Foster Real Estate")).toBe("long & foster real estate");
    expect(normalizeBrokerage("Acme Homes LLC")).toBe("acme homes");
  });
  it("cuts everything from the first comma", () => {
    expect(normalizeBrokerage("Carriage Properties, LLC.")).toBe("carriage properties");
  });
  it("keeps distinct licensees distinct and does not eat look-alike words", () => {
    expect(normalizeBrokerage("Compass GA LLC")).toBe("compass ga");
    expect(normalizeBrokerage("Compass")).toBe("compass");
    expect(normalizeBrokerage("Compass GA LLC")).not.toBe(normalizeBrokerage("Compass"));
    // "Inclusion" ends in letters that contain "inc" but is not the token.
    expect(normalizeBrokerage("Realty ONE Group Inclusion")).toBe("realty one group inclusion");
  });
  it("trims and lowercases", () => {
    expect(normalizeBrokerage("  eXp Realty  ")).toBe("exp realty");
  });
});
