/**
 * Spec 035 — deterministic prompt intent classification. Hand-labeled
 * fixtures across all five categories plus null cases; rule precedence is
 * specificity (comparison beats recommendation for "best alternative to X").
 */
import { describe, expect, it } from "vitest";
import { classifyPrompt, PROMPT_CLASSIFIER_VERSION } from "@/lib/prompts/classify";

const BRANDS = ["Lumina", "Acme Realty"];

const LABELED: { text: string; category: string; tier: number }[] = [
  { text: "What's the best CRM for solo agents?", category: "recommendation", tier: 1 },
  { text: "Top 5 tools for listing photos", category: "recommendation", tier: 1 },
  { text: "Which platform should I use for email drips?", category: "recommendation", tier: 1 },
  { text: "Recommend a transaction coordinator service", category: "recommendation", tier: 1 },
  { text: "HubSpot vs Salesforce for small teams", category: "comparison", tier: 2 },
  { text: "Best alternatives to Zillow for buyers", category: "comparison", tier: 2 },
  { text: "Is Follow Up Boss better than KVCore?", category: "comparison", tier: 2 },
  { text: "What can I use instead of a showing service?", category: "comparison", tier: 2 },
  { text: "How do I get more listing appointments?", category: "how-to", tier: 3 },
  { text: "How to price a condo in a slow market", category: "how-to", tier: 3 },
  { text: "Explain how to file a lien waiver", category: "how-to", tier: 3 },
  { text: "I can't get my open houses to convert", category: "problem", tier: 1 },
  { text: "I need to find off-market inventory", category: "problem", tier: 1 },
  { text: "My biggest issue is lead follow-up", category: "problem", tier: 1 },
  { text: "Is Lumina legit?", category: "branded", tier: 3 },
  { text: "Reviews of Acme Realty in Jersey City", category: "branded", tier: 3 },
];

describe("classifyPrompt", () => {
  it("classifies every hand-labeled fixture correctly", () => {
    for (const fixture of LABELED) {
      const result = classifyPrompt(fixture.text, { brandNames: BRANDS });
      expect(result, fixture.text).not.toBeNull();
      expect(result!.category, fixture.text).toBe(fixture.category);
      expect(result!.tier, fixture.text).toBe(fixture.tier);
    }
  });

  it("returns null rather than guessing", () => {
    expect(classifyPrompt("Jersey City waterfront condos")).toBeNull();
    expect(classifyPrompt("")).toBeNull();
    expect(classifyPrompt("   ")).toBeNull();
  });

  it("brand match is word-bounded and beats every other rule", () => {
    expect(classifyPrompt("Lumina vs HubSpot", { brandNames: BRANDS })?.category).toBe(
      "branded"
    );
    // Substring inside a longer word is not a brand mention.
    expect(
      classifyPrompt("Illuminated signage ideas", { brandNames: BRANDS })
    ).toBeNull();
    // Without a brand list the rule is inert.
    expect(classifyPrompt("Is Lumina legit?")).toBeNull();
  });

  it("comparison beats recommendation on mixed phrasing", () => {
    expect(classifyPrompt("Best alternatives to Zillow")?.category).toBe("comparison");
  });

  it("exports a version string for provenance", () => {
    expect(PROMPT_CLASSIFIER_VERSION).toBe("prompt-classifier-v1+deterministic");
  });
});
