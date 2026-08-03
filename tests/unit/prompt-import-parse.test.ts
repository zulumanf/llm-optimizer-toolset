/**
 * Spec 035 — pure import parsing: header-detected CSV vs plain lines,
 * quoting, caps, per-row rejects with reasons, classifier suggestions.
 */
import { describe, expect, it } from "vitest";
import { IMPORT_MAX_ROWS, parsePromptImport } from "@/lib/prompts/import-parse";

describe("parsePromptImport", () => {
  it("plain lines: one prompt per line, commas preserved, empty lines skipped", () => {
    const parse = parsePromptImport(
      "Best CRM for solo agents\n\nI'm overwhelmed, I need to simplify my follow-up\n"
    );
    expect(parse.format).toBe("lines");
    expect(parse.rows).toHaveLength(2);
    expect(parse.rows[1]?.text).toContain("overwhelmed, I need");
    expect(parse.rows[0]?.category).toBe("recommendation");
    expect(parse.rows[0]?.suggestedByRule).toBe("recommendation");
  });

  it("CSV mode: header-mapped columns, explicit values win over rules", () => {
    const parse = parsePromptImport(
      [
        "text,category,language,tier",
        '"Best CRM, honestly?",problem,EN,4',
        "HubSpot vs Salesforce,,es,",
      ].join("\n")
    );
    expect(parse.format).toBe("csv");
    expect(parse.rows).toHaveLength(2);
    // Explicit category/tier respected even though the text matches the
    // recommendation rule.
    expect(parse.rows[0]).toMatchObject({
      text: "Best CRM, honestly?",
      category: "problem",
      language: "en",
      tier: 4,
      suggestedByRule: null,
    });
    // Blank category → rule suggestion, language kept.
    expect(parse.rows[1]).toMatchObject({
      category: "comparison",
      language: "es",
      tier: 2,
      suggestedByRule: "comparison",
    });
  });

  it("rejects rows with reasons instead of guessing or dropping silently", () => {
    const parse = parsePromptImport(
      [
        "text,category",
        "Jersey City waterfront condos,",
        "Some prompt,made-up-category",
        ",recommendation",
      ].join("\n")
    );
    expect(parse.rows).toHaveLength(0);
    expect(parse.rejected.map((r) => r.reason)).toEqual([
      "category required — no classification rule matched",
      'unknown category "made-up-category"',
      "empty prompt text",
    ]);
    // Line numbers point at the file, 1-based including the header.
    expect(parse.rejected[0]?.line).toBe(2);
  });

  it("unknown header columns are a hard validation error", () => {
    expect(() => parsePromptImport("text,volume\nfoo,100")).toThrow(/volume/);
  });

  it("enforces the row cap in both formats", () => {
    const lines = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `Best tool ${i}`);
    expect(() => parsePromptImport(lines.join("\n"))).toThrow(/cap/);
    expect(() =>
      parsePromptImport(["text", ...lines].join("\n"))
    ).toThrow(/cap/);
  });

  it("brand names flow into suggestions", () => {
    const parse = parsePromptImport("Is Lumina legit?", { brandNames: ["Lumina"] });
    expect(parse.rows[0]?.category).toBe("branded");
    expect(parse.rows[0]?.suggestedByRule).toBe("brand:Lumina");
  });
});
