/** Cell expansion + cost estimation (spec 003). Pure functions. */
import type { FrozenPrompt } from "@/lib/prompts/types";
import type { ProviderId } from "@/lib/ai/types";
import { PRICING } from "@/lib/ai/pricing";

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  repetitions: number;
}

export interface Cell {
  promptId: string;
  promptText: string;
  provider: ProviderId;
  model: string;
  repetition: number;
}

export function expandCells(
  prompts: FrozenPrompt[],
  providers: ProviderConfig[]
): Cell[] {
  const ordered = [...prompts].sort((a, b) => a.position - b.position);
  const cells: Cell[] = [];
  for (const prompt of ordered) {
    for (const config of providers) {
      for (let rep = 1; rep <= config.repetitions; rep += 1) {
        cells.push({
          promptId: prompt.promptId,
          promptText: prompt.text,
          provider: config.provider,
          model: config.model,
          repetition: rep,
        });
      }
    }
  }
  return cells;
}

/**
 * Estimation assumptions (shown to the operator as an estimate, never billed):
 * input ≈ prompt chars / 4 tokens; output ≈ 600 tokens per answer. Real cost
 * is accumulated from provider-reported usage during the run.
 */
const CHARS_PER_TOKEN = 4;
const ESTIMATED_OUTPUT_TOKENS = 600;

export interface RunEstimate {
  cellCount: number;
  estimatedMicroUsd: number;
  unverifiedPricing: string[];
}

export function estimateRun(
  prompts: FrozenPrompt[],
  providers: ProviderConfig[]
): RunEstimate {
  const cells = expandCells(prompts, providers);
  let micro = 0;
  const unverified = new Set<string>();
  for (const cell of cells) {
    const pricing = PRICING[cell.model];
    if (!pricing) {
      unverified.add(cell.model);
      continue;
    }
    if (!pricing.verified) unverified.add(cell.model);
    const tokensIn = Math.ceil(cell.promptText.length / CHARS_PER_TOKEN);
    micro += Math.round(
      tokensIn * pricing.inputPerMTok +
        ESTIMATED_OUTPUT_TOKENS * pricing.outputPerMTok
    );
  }
  return {
    cellCount: cells.length,
    estimatedMicroUsd: micro,
    unverifiedPricing: [...unverified],
  };
}
