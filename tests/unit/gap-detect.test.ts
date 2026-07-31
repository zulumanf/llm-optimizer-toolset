import { describe, expect, it } from "vitest";
import {
  detectGaps,
  type PromptOutcome,
  type CompanyOutcome,
  type DomainCitation,
} from "@/lib/gaps/detect";

function prompt(overrides: Partial<PromptOutcome>): PromptOutcome {
  return {
    promptId: "p1",
    category: "recommendation",
    responses: 4,
    subjectMentioned: 0,
    subjectRecommended: 0,
    subjectCited: 0,
    ...overrides,
  };
}

// Organic rates match the overall ones here: no prompt in this fixture names
// a company, so every response is organic evidence for every company.
const subject: CompanyOutcome = {
  companyId: "s",
  name: "Parva",
  isSubject: true,
  mentionRate: 0.25,
  recommendationRate: 0,
  organicMentionRate: 0.25,
  organicRecommendationRate: 0,
  organicResponses: 16,
};
const leader: CompanyOutcome = {
  companyId: "l",
  name: "Linktree",
  isSubject: false,
  mentionRate: 0.69,
  recommendationRate: 0.31,
  organicMentionRate: 0.69,
  organicRecommendationRate: 0.31,
  organicResponses: 16,
};

describe("detectGaps (day-zero client shape — the real Parva case)", () => {
  const findings = detectGaps({
    subjectName: "Parva",
    subjectDomain: "parva.io",
    prompts: [
      prompt({ promptId: "p1", category: "recommendation" }),
      prompt({ promptId: "p2", category: "problem" }),
      prompt({ promptId: "p3", category: "branded", responses: 2, subjectMentioned: 0 }),
      prompt({ promptId: "p4", category: "comparison", subjectMentioned: 4 }),
    ],
    companies: [subject, leader],
    domains: [
      { domain: "linktr.ee", citations: 3, ownedBySubject: false },
      { domain: "zapier.com", citations: 2, ownedBySubject: false },
    ],
  });
  const types = findings.map((f) => f.gapType);

  it("finds the entity gap when unbranded prompts exclude the subject", () => {
    expect(types).toContain("entity");
    const entity = findings.find((f) => f.gapType === "entity")!;
    expect(entity.finding).toContain("Linktree");
    expect(entity.severity).toBeCloseTo(1);
  });

  it("finds branded-recognition failure", () => {
    expect(types).toContain("branded_recognition");
  });

  it("finds the mentioned-but-never-recommended gap", () => {
    expect(types).toContain("recommendation");
  });

  it("finds the citation gap when owned domain is never cited", () => {
    expect(types).toContain("citation");
  });

  it("lists third-party source targets ordered by citations", () => {
    const target = findings.find((f) => f.gapType === "source_target")!;
    expect(target.finding).toContain("linktr.ee (3×)");
  });

  it("ranks findings by opportunity score descending", () => {
    const scores = findings.map((f) => f.opportunityScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("detectGaps (healthy client shape)", () => {
  it("reports no entity/branded/recommendation gaps for a strong subject", () => {
    const strong: CompanyOutcome = {
      ...subject,
      mentionRate: 0.7,
      recommendationRate: 0.4,
      // Organic too: a client is only genuinely strong when answers name them
      // without the question having done it first.
      organicMentionRate: 0.7,
      organicRecommendationRate: 0.4,
    };
    const domains: DomainCitation[] = [
      { domain: "parva.io", citations: 2, ownedBySubject: true },
      { domain: "zapier.com", citations: 1, ownedBySubject: false },
    ];
    const findings = detectGaps({
      subjectName: "Parva",
      subjectDomain: "parva.io",
      prompts: [
        prompt({ subjectMentioned: 3, subjectRecommended: 2 }),
        prompt({ promptId: "p2", category: "branded", subjectMentioned: 4 }),
      ],
      companies: [strong, leader],
      domains,
    });
    const types = findings.map((f) => f.gapType);
    expect(types).not.toContain("entity");
    expect(types).not.toContain("branded_recognition");
    expect(types).not.toContain("recommendation");
    expect(types).not.toContain("citation");
  });

  it("returns nothing meaningful with no prompts", () => {
    const findings = detectGaps({
      subjectName: "X",
      subjectDomain: null,
      prompts: [],
      companies: [subject, leader],
      domains: [],
    });
    expect(findings.filter((f) => f.gapType !== "recommendation")).toHaveLength(0);
  });
});

describe("brand-anchored prompts must not read as visibility", () => {
  /**
   * The bug this pins: a probe run built around brand names ("Who are the best
   * SERHANT agents in Jersey City?") produced a finding that the client "gets
   * mentioned 25% of the time" — entirely because three of twelve prompts
   * named the client. Reported to a client, that is a false reassurance built
   * on a question we asked ourselves.
   */
  const anchored: CompanyOutcome = {
    companyId: "s",
    name: "JC Luxury Group",
    isSubject: true,
    // Every mention came from a prompt that named them…
    mentionRate: 0.25,
    recommendationRate: 0,
    // …so organically they are invisible.
    organicMentionRate: 0,
    organicRecommendationRate: 0,
    organicResponses: 9,
  };
  const brandLeader: CompanyOutcome = {
    companyId: "b",
    name: "SERHANT.",
    isSubject: false,
    mentionRate: 0.5,
    recommendationRate: 0.1,
    organicMentionRate: 0.08,
    organicRecommendationRate: 0,
    organicResponses: 12,
  };

  it("does not claim a recommendation gap from echoed mentions", () => {
    const findings = detectGaps({
      subjectName: "JC Luxury Group",
      subjectDomain: "jcluxury.com",
      prompts: [prompt({ subjectMentioned: 0 })],
      companies: [anchored, brandLeader],
      domains: [],
    });
    // 25% overall would have fired this. 0% organic must not.
    expect(findings.map((f) => f.gapType)).not.toContain("recommendation");
  });

  it("ranks competitors on organic rate, not on prompts that named them", () => {
    const findings = detectGaps({
      subjectName: "JC Luxury Group",
      subjectDomain: "jcluxury.com",
      prompts: [prompt({ responses: 40, subjectMentioned: 0 })],
      companies: [
        anchored,
        brandLeader, // 50% overall, 8% organic
        {
          companyId: "c",
          name: "Compass",
          isSubject: false,
          mentionRate: 0.35,
          recommendationRate: 0.2,
          organicMentionRate: 0.35,
          organicRecommendationRate: 0.2,
          organicResponses: 40,
        },
      ],
      domains: [],
    });
    const entity = findings.find((f) => f.gapType === "entity");
    // Compass genuinely out-competes them; SERHANT's 50% was our own question.
    expect(entity?.finding).toContain("Compass");
    expect(entity?.finding).not.toContain("SERHANT");
  });

  it("ignores a competitor with no organic sample rather than scoring it zero", () => {
    const findings = detectGaps({
      subjectName: "JC Luxury Group",
      subjectDomain: "jcluxury.com",
      prompts: [prompt({ subjectMentioned: 0 })],
      companies: [
        anchored,
        {
          companyId: "x",
          name: "Named In Every Prompt",
          isSubject: false,
          mentionRate: 1,
          recommendationRate: 1,
          organicMentionRate: null,
          organicResponses: 0,
          organicRecommendationRate: null,
        },
      ],
      domains: [],
    });
    // No organic competitor evidence ⇒ no entity comparison can be made.
    expect(findings.map((f) => f.gapType)).not.toContain("entity");
  });
});
