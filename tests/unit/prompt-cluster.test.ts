/**
 * Spec 035 — deterministic prompt clustering: category separation, salient
 * term overlap, placeholder stripping, stability, honest singletons.
 */
import { describe, expect, it } from "vitest";
import {
  clusterPrompts,
  PROMPT_CLUSTER_VERSION,
  salientTokens,
  type PromptForClustering,
} from "@/lib/prompts/cluster";

const prompt = (
  id: string,
  text: string,
  category: PromptForClustering["category"] = "recommendation"
): PromptForClustering => ({ id, text, category });

describe("salientTokens", () => {
  it("drops stopwords and template placeholders", () => {
    const tokens = salientTokens("What's the best {category} for {audience} in Jersey City?");
    expect(tokens.has("best")).toBe(false); // stopword by design
    expect(tokens.has("category")).toBe(false); // placeholder stripped
    expect(tokens.has("jersey")).toBe(true);
    expect(tokens.has("city")).toBe(true);
  });
});

describe("clusterPrompts", () => {
  it("groups shared-topic prompts and separates topics", () => {
    const clusters = clusterPrompts([
      prompt("a", "Best CRM for real estate agents"),
      prompt("b", "Which CRM should a real estate team use?"),
      prompt("c", "Top staging tips for photographers"),
    ]);
    const byId = (id: string) => clusters.find((c) => c.promptIds.includes(id))!;
    expect(byId("a")).toBe(byId("b"));
    expect(byId("c")).not.toBe(byId("a"));
    expect(byId("c").promptIds).toHaveLength(1); // singleton clusters are real
  });

  it("never merges across categories, even with identical wording", () => {
    const clusters = clusterPrompts([
      prompt("a", "pricing for staging services", "recommendation"),
      prompt("b", "pricing for staging services", "problem"),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it("is stable across repeated calls", () => {
    const input = [
      prompt("a", "Best CRM for agents"),
      prompt("b", "CRM for a small agent team"),
      prompt("c", "Email drip tools compared", "comparison"),
    ];
    const first = clusterPrompts(input);
    const second = clusterPrompts(input);
    expect(second).toEqual(first);
  });

  it("labels clusters with their most frequent salient terms", () => {
    const [cluster] = clusterPrompts([
      prompt("a", "Best CRM for real estate agents"),
      prompt("b", "Which CRM should a real estate team pick?"),
    ]);
    expect(cluster!.label).toContain("crm");
    expect(cluster!.key.startsWith("recommendation:")).toBe(true);
  });

  it("exports a version string for provenance", () => {
    expect(PROMPT_CLUSTER_VERSION).toBe("prompt-cluster-v1+deterministic");
  });
});
