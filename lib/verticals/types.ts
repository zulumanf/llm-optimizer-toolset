/**
 * Vertical pack shapes (spec 012). A pack is everything that changes between
 * industries — prompt templates, claim vocabulary, compliance rules — so
 * onboarding a realtor and onboarding a surgeon are the same operation with
 * different data, never different code.
 */
import type { PromptCategory } from "@/lib/constants";

/** Operator-supplied values collected once at onboarding. Multi-valued
 * variables (markets, procedures) expand combinatorially into prompts. */
export interface PackVariable {
  key: string;
  label: string;
  help: string;
  example: string;
  required: boolean;
  multi: boolean;
}

/**
 * Intent tiers from the agency blueprint: 1 = narrow high-intent (closest to
 * a buying decision), 4 = broad category. Tiers drive nothing automatically —
 * they tell the operator what a prompt is for. Persisted on prompts and in
 * frozen snapshots (migration 030) so reports CAN segment by commercial
 * value; no report does yet.
 */
export type IntentTier = 1 | 2 | 3 | 4;

export interface PromptTemplate {
  /** Text with {variable} placeholders; {brand} and {competitor} are reserved
   * and filled from the client registry, never typed by hand. */
  text: string;
  category: PromptCategory;
  tier: IntentTier;
  /** Holdout templates produce prompts excluded from headline metrics
   * (spec 011 evidence rules) — a blind check the client cannot game. */
  isHoldout?: boolean;
}

export interface ClaimKeySuggestion {
  key: string;
  label: string;
  example: string;
}

/** Deterministic compliance rules applied to drafted content for this
 * vertical (spec 010's gate is generic; packs add industry rules). */
export interface ComplianceRule {
  id: string;
  /** Human-readable rule, shown when it fires. */
  rule: string;
  /** Case-insensitive regex source matched against draft text. */
  pattern: string;
  severity: "block" | "warn";
}

export interface VerticalPackDefinition {
  key: string;
  version: number;
  name: string;
  description: string;
  variables: PackVariable[];
  promptTemplates: PromptTemplate[];
  claimKeys: ClaimKeySuggestion[];
  suggestedCompetitors: string[];
  compliance: ComplianceRule[];
}
