/**
 * Parser accuracy harness (docs/09, spec 004): a labeled corpus of realistic
 * answers; CI fails if precision on `mentioned` drops below 0.90. Every
 * classification bug should add a labeled case here before the fix.
 */
import { describe, expect, it } from "vitest";
import { classifyResponse, type CompanyInput } from "@/lib/parsing/classify";

const companies: CompanyInput[] = [
  { id: "lumina", name: "Lumina", aliases: ["lumina.com"], domain: "lumina.com" },
  { id: "acme", name: "Acme", aliases: ["AcmeHQ"], domain: "acme.io" },
  { id: "beta", name: "Beta Inc", aliases: ["BetaInc"], domain: "betainc.dev" },
];

interface LabeledCase {
  text: string;
  mentioned: string[]; // company ids a human labeled as mentioned
}

const CORPUS: LabeledCase[] = [
  { text: "For most teams I'd recommend Lumina — it's the strongest option.", mentioned: ["lumina"] },
  { text: "Top tools:\n1. Acme\n2. Lumina\n3. Beta Inc", mentioned: ["acme", "lumina", "beta"] },
  { text: "Acme leads this space; Lumina is a newer challenger.", mentioned: ["acme", "lumina"] },
  { text: "There are many options depending on your needs.", mentioned: [] },
  { text: "Luminati temple guides are outside my expertise.", mentioned: [] },
  { text: "Check lumina.com for pricing details.", mentioned: ["lumina"] },
  { text: "AcmeHQ recently shipped a big update.", mentioned: ["acme"] },
  { text: "I would avoid Beta Inc — support is poor.", mentioned: ["beta"] },
  { text: "Popular picks include Acme and Beta Inc, with Lumina close behind.", mentioned: ["acme", "beta", "lumina"] },
  { text: "The best choice is Acme.", mentioned: ["acme"] },
  { text: "Some prefer open-source tools over commercial ones.", mentioned: [] },
  { text: "- Lumina: great for small teams\n- Acme: enterprise standard", mentioned: ["lumina", "acme"] },
  { text: "Beta Inc's betainc.dev docs are thorough.", mentioned: ["beta"] },
  { text: "Nothing beats a spreadsheet for tiny projects.", mentioned: [] },
  { text: "Acme, Acme, and Acme again — it dominates every list.", mentioned: ["acme"] },
  { text: "Start with Lumina; switch to Acme if you outgrow it.", mentioned: ["lumina", "acme"] },
  { text: "LUMINA (all caps) still counts as a mention.", mentioned: ["lumina"] },
  // Known heuristic false positive: "acme" as a common noun. Labeled honestly
  // as not-mentioned; it costs precision until an LLM parser version lands.
  { text: "The acme of perfection is hard to reach.", mentioned: [] },
  { text: "Beta testing your product is essential.", mentioned: [] },
  { text: "Compare Lumina vs Acme on pricing and support.", mentioned: ["lumina", "acme"] },
  { text: "I can't help with that request.", mentioned: [] },
  { text: "Betas of Beta Inc products ship monthly.", mentioned: ["beta"] },
];

describe("parser accuracy harness", () => {
  it("precision on `mentioned` is ≥ 0.90 (CI gate)", () => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (const example of CORPUS) {
      const predicted = new Set(
        classifyResponse(example.text, companies)
          .filter((d) => d.mentioned)
          .map((d) => d.companyId)
      );
      const labeled = new Set(example.mentioned);
      for (const id of predicted) {
        if (labeled.has(id)) truePositives += 1;
        else falsePositives += 1;
      }
      for (const id of labeled) {
        if (!predicted.has(id)) falseNegatives += 1;
      }
    }

    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);
    console.log(
      `parser accuracy: precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} (n=${CORPUS.length})`
    );
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });
});
