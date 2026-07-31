import type { PromptCategory } from "@/lib/constants";

/** One entry of a frozen snapshot (prompt_set_versions.frozen_prompts). */
export interface FrozenPrompt {
  promptId: string;
  text: string;
  category: PromptCategory;
  language: string;
  position: number;
  /** Holdout membership locks at freeze (evidence spec): holdout
   * observations run but stay out of standard metric denominators.
   * Absent on pre-evidence-spec versions = false. */
  isHoldout?: boolean;
  /** Intent tier 1–4 (lib/verticals/types.ts), locked at freeze so reports
   * can segment historical runs by funnel stage. Absent on pre-migration-030
   * versions and on untiered prompts = untiered. */
  tier?: number | null;
}
