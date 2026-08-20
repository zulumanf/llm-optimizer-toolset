/** Spec 095: the dashboard's honesty labels are load-bearing copy. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("prospecting dashboard copy discipline", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "app/prospects/dashboard/page.tsx"),
    "utf8"
  );

  it("opens are labeled an upper bound, views labeled human-like", () => {
    expect(source).toContain("upper bound");
    expect(source).toContain("human-like external views");
  });

  it("the funnel names its basis and never trusts the stage column alone", () => {
    expect(source).toMatch(/never the stage field alone/);
  });
});
