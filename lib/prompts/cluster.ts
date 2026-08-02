/**
 * Deterministic prompt clustering (spec 035). Groups a set's prompts by
 * category, then by shared salient terms — greedy, order-stable (prompts
 * arrive in position order), computed on read. v1 exists to make coverage
 * discussable ("the pricing cluster", "the alternatives cluster"), not to
 * be clever; smarter clustering ships only with a validation set.
 */
import type { PromptCategory } from "@/lib/constants";

export const PROMPT_CLUSTER_VERSION = "prompt-cluster-v1+deterministic";
export const CLUSTER_OVERLAP_THRESHOLD = 0.34;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "of", "in", "on", "at", "to",
  "is", "are", "was", "were", "be", "been", "do", "does", "did", "can",
  "could", "should", "would", "will", "what", "whats", "which", "who", "how",
  "why", "when", "where", "i", "we", "you", "my", "our", "your", "me", "us",
  "it", "its", "this", "that", "there", "with", "from", "by", "as", "if",
  "not", "no", "so", "than", "then", "them", "they", "their", "any", "some",
  "about", "into", "want", "need", "get", "use", "using", "good", "best",
  "top", "better", "vs", "versus", "compare", "comparison", "alternative",
  "alternatives", "recommend", "recommended", "2025", "2026",
]);

export interface PromptForClustering {
  id: string;
  text: string;
  category: PromptCategory;
}

export interface PromptCluster {
  key: string;
  label: string;
  category: PromptCategory;
  promptIds: string[];
}

/** Salient tokens: lowercase words minus stopwords and {placeholders}. */
export function salientTokens(text: string): Set<string> {
  const cleaned = text.replace(/\{[^}]*\}/g, " ").toLowerCase();
  const words = cleaned.match(/[a-z][a-z0-9'-]{1,}/g) ?? [];
  return new Set(
    words.map((w) => w.replace(/'s$/, "")).filter((w) => !STOPWORDS.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface WorkingCluster {
  category: PromptCategory;
  tokens: Map<string, number>; // term -> frequency across members
  promptIds: string[];
}

export function clusterPrompts(prompts: PromptForClustering[]): PromptCluster[] {
  const clusters: WorkingCluster[] = [];

  for (const prompt of prompts) {
    const tokens = salientTokens(prompt.text);
    let joined = false;
    for (const cluster of clusters) {
      if (cluster.category !== prompt.category) continue;
      if (jaccard(tokens, new Set(cluster.tokens.keys())) >= CLUSTER_OVERLAP_THRESHOLD) {
        cluster.promptIds.push(prompt.id);
        for (const t of tokens) cluster.tokens.set(t, (cluster.tokens.get(t) ?? 0) + 1);
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({
        category: prompt.category,
        tokens: new Map([...tokens].map((t) => [t, 1])),
        promptIds: [prompt.id],
      });
    }
  }

  return clusters.map((cluster) => {
    const top = [...cluster.tokens.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 2)
      .map(([t]) => t);
    const label = top.length > 0 ? top.join(" · ") : "(no salient terms)";
    return {
      key: `${cluster.category}:${top.join("+") || "misc"}`,
      label,
      category: cluster.category,
      promptIds: cluster.promptIds,
    };
  });
}
