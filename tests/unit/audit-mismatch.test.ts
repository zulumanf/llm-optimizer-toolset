import { describe, expect, it } from "vitest";
import {
  categorize,
  excerptAround,
  gapCategories,
  narrative,
  type MismatchQuestionRow,
} from "@/lib/prospects/audit-mismatch";

const q = (over: Partial<MismatchQuestionRow>): MismatchQuestionRow => ({
  text: "Who should I use to sell a condominiums in Mordecai?",
  audience: "seller", propertyType: "condominiums", neighborhood: "Mordecai", luxury: false,
  answers: 4, competitorRecommended: 0, prospectRecommended: 0, prospectMentioned: 0, excerpts: [],
  ...over,
});
const QUESTIONS: MismatchQuestionRow[] = [
  q({ text: "Who are the best luxury real estate agents in Raleigh, NC?", audience: "general", propertyType: null, neighborhood: null, luxury: true, competitorRecommended: 3, prospectRecommended: 1, prospectMentioned: 1 }),
  q({ competitorRecommended: 2 }),
  q({ text: "Who should I use to sell a townhomes in Hayes Barton?", propertyType: "townhomes", neighborhood: "Hayes Barton", competitorRecommended: 1 }),
  q({ text: "Which real estate agents specialize in Oberlin?", audience: "general", propertyType: null, neighborhood: "Oberlin" }),
  q({ text: "Who are the best agents for buyers in Raleigh?", audience: "buyer", propertyType: null, neighborhood: null }),
];

describe("excerptAround — the sentence around the competitor, markdown stripped", () => {
  const text =
    "Here are some of the **best-known luxury agents in Raleigh**:\n\n" +
    "1. **Gretchen Coley (Compass)** — widely recognized. ([compass.com](https://compass.com/x))\n" +
    "2. (zillow.com) - **David Worters (Hodge & Kittrell Sotheby's)** — known for luxury listings in Hayes Barton. ([site](https://x.y))\n" +
    "3. Another team.";
  it("finds the competitor and returns a clean sentence", () => {
    const e = excerptAround(text, "David Worters")!;
    expect(e.startsWith("David Worters")).toBe(true);
    expect(e).not.toContain("**");
    expect(e).not.toContain("https://");
    expect(e).not.toContain("zillow.com");
  });
  it("is case-insensitive and null when absent", () => {
    expect(excerptAround(text, "david worters")).not.toBeNull();
    expect(excerptAround(text, "Steve Wall")).toBeNull();
  });
});

describe("categorize / gaps — raw counts by question type, competitor-led only", () => {
  it("counts recommendations per audience, property type, luxury and neighborhood", () => {
    const cats = categorize(QUESTIONS);
    const by = Object.fromEntries(cats.map((c) => [c.key, c]));
    expect(by["audience:seller"]).toMatchObject({ questions: 2, prospect: 0, competitor: 3 });
    expect(by["audience:general"]).toMatchObject({ questions: 2, prospect: 1, competitor: 3 });
    expect(by["property:condominiums"]).toMatchObject({ questions: 1, competitor: 2 });
    expect(by["luxury"]).toMatchObject({ questions: 1, prospect: 1, competitor: 3 });
    expect(by["neighborhood"]).toMatchObject({ questions: 3, competitor: 3 });
    expect(cats[0]!.competitor).toBeGreaterThanOrEqual(cats[cats.length - 1]!.competitor);
  });
  it("gaps need competitor ≥ 2 and a lead; at most three, largest first", () => {
    const gaps = gapCategories(categorize(QUESTIONS));
    expect(gaps.length).toBeLessThanOrEqual(3);
    expect(gaps.every((g) => g.competitor >= 2 && g.competitor > g.prospect)).toBe(true);
    expect(gaps[0]!.competitor - gaps[0]!.prospect).toBeGreaterThanOrEqual(gaps[gaps.length - 1]!.competitor - gaps[gaps.length - 1]!.prospect);
    expect(gapCategories(categorize([q({ competitorRecommended: 1 })]))).toEqual([]);
  });
});

describe("narrative — typed, personalized, honest", () => {
  const input = {
    prospect: { name: "Steve Wall", productionDisplay: "$74.8M closed", productionYear: 2025, recommendationCount: 1 },
    competitor: { name: "David Worters", productionDisplay: "$41.4M closed", productionYear: 2025, recommendationCount: 6 },
    market: "Raleigh", answerCount: 256, questions: QUESTIONS,
    categories: categorize(QUESTIONS), gaps: gapCategories(categorize(QUESTIONS)),
    competitorNeighborhoods: ["Mordecai", "Hayes Barton"],
    sources: [{ domain: "zillow.com", citations: 900, category: "platform" }, { domain: "realtor.com", citations: 800, category: "platform" }],
    ownSiteCited: false,
    distinctQuestions: { prospect: 1, competitor: 3 },
  };
  const n = narrative(input);
  it("diagnosis separates observed, may mean and investigate; every area is evidence-backed", () => {
    expect(n.diagnosis.length).toBe(3);
    expect(n.diagnosis[0]!.observed).toContain("$74.8M closed");
    expect(n.diagnosis[0]!.observed).toContain("1 recommendation for your team against 6");
    expect(n.diagnosis[1]!.observed).toContain("Mordecai");
    expect(n.diagnosis[2]!.observed).toContain("zillow.com");
    expect(n.diagnosis[2]!.observed).toContain("your own site was not among");
    for (const d of n.diagnosis) {
      expect(d.mayMean).toMatch(/may|appear/);
      expect(d.investigate.length).toBeGreaterThan(20);
    }
  });
  it("drops areas without evidence", () => {
    const bare = narrative({ ...input, gaps: [], sources: null, ownSiteCited: null, competitorNeighborhoods: [] });
    expect(bare.diagnosis.length).toBe(1);
    expect(bare.priorities.length).toBe(1);
    expect(bare.note.question).toBeNull();
  });
  it("priorities max three; context questions personalized to neighborhoods, property types and the competitor", () => {
    expect(n.priorities.length).toBeLessThanOrEqual(3);
    expect(n.contextQuestions.some((c) => c.includes("Mordecai and Hayes Barton"))).toBe(true);
    expect(n.contextQuestions.some((c) => c.includes("David Worters"))).toBe(true);
    expect(n.contextQuestions.length).toBeLessThanOrEqual(4);
  });
  it("less-concerned checks state the actual status, including when the competitor was concentrated", () => {
    expect(n.lessConcerned[0]!.status).toContain("3 different questions");
    const one = narrative({ ...input, distinctQuestions: { prospect: 0, competitor: 1 } });
    expect(one.lessConcerned[0]!.status).toContain("only 1 question");
    expect(one.lessConcerned[1]!.status).toContain("not recommended in any");
  });
  it("the note explains why this team was contacted, with its own numbers", () => {
    expect(n.note.paragraphs.join(" ")).toContain("$74.8M closed against $41.4M closed");
    expect(n.note.question).toContain("Mordecai and Hayes Barton");
  });
  it("uses the reader's vocabulary only", () => {
    const text = JSON.stringify(n);
    expect(text).not.toMatch(/\b(AEO|GEO|LLM|prompt|citation|retrieval|semantic|benchmark|authority signal|share of voice|optimization)\b/i);
  });
});
