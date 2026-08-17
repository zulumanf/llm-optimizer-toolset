/**
 * Score blurbs (spec 084): the stored qualification breakdown rendered as
 * one plain-language line for the prospects table. Deterministic — never a
 * model. The number must explain itself; this is that explanation in words.
 */

/** Operator language for each component (docs/04 page voice: say what a
 * thing is FOR, not its internal name). */
const COMPONENT_PHRASES: Record<string, string> = {
  commercialAuthority: "verified authority",
  visibilityGap: "AI-visibility upside",
  adjustedFixability: "fixability",
  competitorAdvantage: "rival beatability",
  buyingSignals: "outreach timing",
  contactability: "reachability",
};

interface BreakdownShape {
  components?: Record<string, number | null>;
  missing?: string[];
  archetype?: string | null;
}

function phrase(key: string): string {
  return COMPONENT_PHRASES[key] ?? key;
}

/** One muted line under the score, or null when no breakdown is stored. */
export function scoreBlurb(breakdown: unknown): string | null {
  const b = breakdown as BreakdownShape | null;
  if (!b || typeof b !== "object" || !b.components) return null;

  const measured = Object.entries(b.components)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, z) => z[1] - a[1]);
  if (measured.length === 0) return null;

  const parts: string[] = [];
  const [bestKey, bestValue] = measured[0]!;
  parts.push(`strongest: ${phrase(bestKey)} (${Math.round(bestValue)})`);
  if (measured.length > 1) {
    const [worstKey, worstValue] = measured[measured.length - 1]!;
    parts.push(`weakest: ${phrase(worstKey)} (${Math.round(worstValue)})`);
  }
  const missing = (b.missing ?? []).map(phrase);
  if (missing.length > 0) {
    parts.push(`not yet measured: ${missing.join(", ")}`);
  }
  if (b.archetype === "verified_authority_underrepresented") {
    parts.push("priority boost: proven producer, barely recommended by AI");
  }
  const blurb = parts.join(" · ");
  return blurb.charAt(0).toUpperCase() + blurb.slice(1);
}
