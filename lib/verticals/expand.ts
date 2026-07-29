/**
 * Prompt-template expansion (spec 012). Turns a pack's templates plus the
 * operator's variable values into concrete candidate prompts.
 *
 * Deliberately deterministic and boring: the same inputs always produce the
 * same prompts in the same order, so two operators onboarding the same
 * client get the same benchmark. Nothing is auto-frozen — a human reviews
 * and edits before freezing (PRINCIPLES: software suggests, humans approve).
 */
import type { PromptTemplate, VerticalPackDefinition } from "@/lib/verticals/types";
import type { PromptCategory } from "@/lib/constants";

/** Hard ceiling so a client with 5 markets × 4 property types × 3 client
 * types cannot generate a 300-prompt benchmark nobody can afford to run. */
export const MAX_GENERATED_PROMPTS = 40;

export interface ExpansionInput {
  pack: VerticalPackDefinition;
  /** Operator-entered values; multi-valued variables carry several entries. */
  variables: Record<string, string[]>;
  /** Reserved: the client's own name. */
  brand: string;
  /** Reserved: tracked competitor names (capped to keep counts sane). */
  competitors: string[];
}

export interface GeneratedPrompt {
  text: string;
  category: PromptCategory;
  tier: number;
  isHoldout: boolean;
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;
const MAX_COMPETITOR_EXPANSIONS = 2;

function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string))];
}

/** Cartesian product over the placeholders a single template actually uses. */
function expandTemplate(
  template: PromptTemplate,
  values: Record<string, string[]>
): string[] {
  const keys = placeholdersIn(template.text);
  let outputs = [template.text];
  for (const key of keys) {
    const options = values[key];
    // A template referencing a variable the operator left blank is skipped
    // entirely rather than emitting "best realtor in {market}".
    if (!options || options.length === 0) return [];
    const next: string[] = [];
    for (const partial of outputs) {
      for (const option of options) {
        next.push(partial.replaceAll(`{${key}}`, option));
      }
    }
    outputs = next;
  }
  return outputs;
}

export function expandPack(input: ExpansionInput): GeneratedPrompt[] {
  const values: Record<string, string[]> = {};
  for (const [key, entries] of Object.entries(input.variables)) {
    const cleaned = entries.map((e) => e.trim()).filter((e) => e.length > 0);
    if (cleaned.length > 0) values[key] = cleaned;
  }
  values.brand = [input.brand];
  const competitors = input.competitors
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .slice(0, MAX_COMPETITOR_EXPANSIONS);
  if (competitors.length > 0) values.competitor = competitors;

  const seen = new Set<string>();
  const generated: GeneratedPrompt[] = [];
  // Tier order keeps the highest-intent prompts inside the cap when a
  // client's variable matrix is large.
  const ordered = [...input.pack.promptTemplates].sort((a, b) => a.tier - b.tier);

  for (const template of ordered) {
    for (const text of expandTemplate(template, values)) {
      const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      generated.push({
        text,
        category: template.category,
        tier: template.tier,
        isHoldout: Boolean(template.isHoldout),
      });
      if (generated.length >= MAX_GENERATED_PROMPTS) return generated;
    }
  }
  return generated;
}

/** Which required variables are still missing — surfaced before generation
 * so the operator fixes inputs rather than reviewing a half-empty set. */
export function missingRequiredVariables(
  pack: VerticalPackDefinition,
  variables: Record<string, string[]>
): string[] {
  return pack.variables
    .filter((v) => v.required)
    .filter((v) => (variables[v.key] ?? []).filter((s) => s.trim()).length === 0)
    .map((v) => v.label);
}
