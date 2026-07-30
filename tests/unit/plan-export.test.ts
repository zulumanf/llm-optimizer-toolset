/**
 * Client-facing plan export.
 *
 * What is tested is mostly what must NOT appear. An export is the one artefact
 * that leaves the platform and gets read by someone who cannot ask us what a
 * word meant, so internal provenance, operator-voiced exclusion reasons and
 * anything resembling a guarantee are all failures.
 */
import { describe, expect, it } from "vitest";
import { renderPlanHtml, renderPlanMarkdown } from "@/lib/plans/export";
import type { PlanSummary } from "@/lib/plans/service";

function plan(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "90-day program",
    status: "approved",
    horizonDays: 90,
    compositionHash: "deadbeefcafef00ddeadbeefcafef00d",
    supersededId: null,
    createdAt: new Date("2026-07-30"),
    approvedAt: new Date("2026-07-30"),
    baseline: {
      organicMentionRate: 0.03,
      topCompetitor: "Compass",
      topCompetitorRate: 0.33,
      ownDomainCited: false,
      citedDomains: [
        { domain: "zillow.com", citations: 92 },
        { domain: "realtor.com", citations: 72 },
      ],
      composedAt: "2026-07-30",
      findingCount: 4,
    },
    items: [
      {
        phase: "foundation",
        position: 1,
        playKey: "correct_entity_record",
        title: "Fix what AI thinks you are",
        rationale: "AI assistants mention you in 3% of relevant answers.",
        steps: ["Add one plain line to the homepage.", "Match the wording everywhere."],
        sourceFindingId: "33333333-3333-4333-8333-333333333333",
        evidenceIds: [],
        effortHours: 6,
        owner: "shared",
        measurement: "Ask AI directly who you are.",
        status: "planned",
        exclusionReason: null,
      },
      {
        phase: "compounding",
        position: 1,
        playKey: "review_velocity",
        title: "Build steady review volume",
        rationale: "zillow.com weights recent reviews heavily.",
        steps: ["Ask every closing client for a review."],
        sourceFindingId: null,
        evidenceIds: [],
        effortHours: 8,
        owner: "client",
        measurement: "Track review count and recency.",
        status: "planned",
        exclusionReason: null,
      },
      {
        phase: "foundation",
        position: 9,
        playKey: "publish_brokerage_affiliation",
        title: "Put the brokerage on your own site",
        rationale: "The brokerage lists you but your site does not.",
        steps: [],
        sourceFindingId: null,
        evidenceIds: [],
        effortHours: 2,
        owner: "client",
        measurement: "Ask AI for that brokerage's agents.",
        status: "excluded",
        exclusionReason: "No verified brokerage on file. Confirm it first.",
      },
    ],
    ...overrides,
  };
}

describe("what the client export must not contain", () => {
  const md = renderPlanMarkdown(plan(), "JC Luxury Group");

  it("never leaks internal provenance", () => {
    expect(md).not.toContain("deadbeef"); // composition hash
    expect(md).not.toContain("33333333"); // finding id
    expect(md).not.toContain("composer");
    expect(md).not.toMatch(/playKey|play_key/);
  });

  it("never shows an operator-voiced exclusion reason", () => {
    // "No verified brokerage on file. Confirm it first." is an instruction to
    // us. To a client it reads as either jargon or an accusation.
    expect(md).not.toContain("No verified brokerage on file");
    expect(md).not.toContain("Confirm it first");
  });

  it("makes no promise about rankings or outcomes", () => {
    expect(md).toMatch(/do not guarantee/i);
    expect(md).not.toMatch(/we will (rank|get you|guarantee)/i);
  });
});

describe("what it must contain", () => {
  const md = renderPlanMarkdown(plan(), "JC Luxury Group");

  it("leads with the honest starting position, including the bad number", () => {
    // A plan that hides the starting position cannot show progress later.
    expect(md).toContain("3% of relevant answers");
    expect(md).toContain("Compass is mentioned in 33%");
    expect(md).toContain("**never cited**");
  });

  it("names the sources AI actually drew on", () => {
    expect(md).toContain("zillow.com (92 times)");
    expect(md).toContain("realtor.com (72 times)");
  });

  it("phases the work with plain headings", () => {
    expect(md).toContain("Days 0–30 — Get found correctly");
    expect(md).toContain("Days 61–90 — Compound and check");
  });

  it("says who does each item in the client's language", () => {
    expect(md).toContain("We do this together");
    expect(md).toContain("You do this");
  });

  it("gives the client one list of their own obligations, marking joint work", () => {
    const section = md.slice(md.indexOf("## What we need from you"), md.indexOf("---"));
    // Theirs alone.
    expect(section).toContain("Build steady review volume");
    // Joint work belongs here too, but labelled: "together" and "yours alone"
    // are different asks, and a client who cannot tell them apart assumes the
    // smaller one.
    expect(section).toContain("Fix what AI thinks you are** *(together)*");
  });

  it("leaves items we own entirely out of the client's list", () => {
    const operatorOwned = renderPlanMarkdown(
      plan({
        items: [
          {
            ...plan().items[0]!,
            owner: "operator",
            title: "Something we do alone",
          },
        ],
      }),
      "X"
    );
    expect(operatorOwned).not.toContain("## What we need from you");
  });

  it("states what could not be assessed rather than hiding it", () => {
    expect(md).toContain("What we could not assess yet");
    expect(md).toContain("Put the brokerage on your own site");
    expect(md).toContain("more information");
  });

  it("keeps every step and every measurement", () => {
    expect(md).toContain("Add one plain line to the homepage.");
    expect(md).toContain("How we check it worked:");
  });

  it("reports 'not measured' rather than 0% when nothing was observed", () => {
    const unmeasured = renderPlanMarkdown(
      plan({ baseline: { organicMentionRate: null, composedAt: "2026-07-30" } }),
      "X"
    );
    expect(unmeasured).toContain("not measured");
    expect(unmeasured).not.toContain("mentioned in 0%");
  });
});

describe("html rendering", () => {
  const html = renderPlanHtml(plan(), "JC Luxury Group");

  it("is a self-contained printable document", () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("@media print");
    // No external requests: a client should be able to open it offline.
    expect(html).not.toMatch(/<script|src=|<link/i);
  });

  it("escapes client-supplied text rather than trusting it", () => {
    const nasty = renderPlanHtml(plan(), '<script>alert("x")</script>');
    expect(nasty).not.toContain("<script>alert");
    expect(nasty).toContain("&lt;script&gt;");
  });

  it("carries the same content as the markdown", () => {
    expect(html).toContain("Get found correctly");
    expect(html).toContain("do not guarantee");
  });
});
