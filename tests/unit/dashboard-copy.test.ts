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

  it("spec 099: contacted means transmitted; sessions are never 'repeat visitors'; latency carries n", () => {
    expect(source).toContain("Contacted = transmitted sends");
    expect(source).not.toMatch(/repeat visitor|repeat activity/i);
    expect(source).toContain("multiple sessions");
    expect(source).toContain("attribution unresolved");
    expect(source).toContain("LATENCY_MIN_SAMPLE");
    // Every rendered time goes through the zoned formatter — a bare
    // toLocaleString on a UTC server once showed 3:05 PM for an 11:05 AM send.
    expect(source).not.toMatch(/toLocaleString\(undefined/);
  });

  it("the open pixel route stays public — the auth redirect once ate every open", () => {
    const middleware = readFileSync(
      join(__dirname, "..", "..", "middleware.ts"),
      "utf8"
    );
    expect(middleware).toContain('"/api/open"');
  });

  it("the tracking pixel is never display:none — hidden images suppress real opens", () => {
    const html = readFileSync(
      join(__dirname, "..", "..", "lib/text/html.ts"),
      "utf8"
    );
    expect(html).not.toContain("display:none");
  });
});
