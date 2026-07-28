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

const subject: CompanyOutcome = {
  companyId: "s",
  name: "Parva",
  isSubject: true,
  mentionRate: 0.25,
  recommendationRate: 0,
};
const leader: CompanyOutcome = {
  companyId: "l",
  name: "Linktree",
  isSubject: false,
  mentionRate: 0.69,
  recommendationRate: 0.31,
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
