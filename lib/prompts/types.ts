import type { PromptCategory } from "@/lib/constants";

/** One entry of a frozen snapshot (prompt_set_versions.frozen_prompts). */
export interface FrozenPrompt {
  promptId: string;
  text: string;
  category: PromptCategory;
  language: string;
  position: number;
}
