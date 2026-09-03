import { describe, expect, it } from "vitest";
import { excerptAround } from "@/lib/prospects/audit-mismatch";

describe("excerptAround — the sentence around the competitor, markdown stripped", () => {
  const text =
    "Here are some of the **best-known luxury agents in Raleigh**:\n\n" +
    "1. **Gretchen Coley (Compass)** — widely recognized. ([compass.com](https://compass.com/x))\n" +
    "2. **David Worters (Hodge & Kittrell Sotheby's)** — known for luxury listings in Hayes Barton. ([site](https://x.y))\n" +
    "3. Another team.";
  it("finds the competitor and returns a clean sentence", () => {
    const q = excerptAround(text, "David Worters")!;
    expect(q).toContain("David Worters");
    expect(q).not.toContain("**");
    expect(q).not.toContain("https://");
    expect(q.length).toBeLessThanOrEqual(245);
  });
  it("is case-insensitive and null when absent", () => {
    expect(excerptAround(text, "david worters")).not.toBeNull();
    expect(excerptAround(text, "Steve Wall")).toBeNull();
  });
});
