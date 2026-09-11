import { describe, expect, it } from "vitest";
import { singular, withArticle } from "@/lib/markets/generate";

describe("pack question grammar — a {propertyType} reads as one property", () => {
  it("singularizes plural property types", () => {
    expect(singular("condominiums")).toBe("condominium");
    expect(singular("single-family homes")).toBe("single-family home");
    expect(singular("townhomes")).toBe("townhome");
    expect(singular("condo")).toBe("condo");
    expect(singular("townhouses")).toBe("townhouse");
    expect(singular("new development")).toBe("new development");
  });
  it("picks the article", () => {
    expect(withArticle(singular("condominiums"))).toBe("a condominium");
    expect(withArticle("apartment")).toBe("an apartment");
    expect(withArticle("")).toBe("");
  });
});
