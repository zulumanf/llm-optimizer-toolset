/**
 * Score blurbs (spec 084, verbiage pass 2026-08-17): the stored breakdown
 * rendered as one plain-language, decision-first line for the prospects
 * table. Deterministic — never a model. The two facts an operator decides
 * by lead every blurb: the prospect's proven track record and how much
 * room they have to grow in AI answers. Bookkeeping facts (contact info,
 * timing research) appear only when they are MISSING — having an email on
 * file is not a strength of the business.
 */

interface BreakdownShape {
  components?: Record<string, number | null>;
  missing?: string[];
  archetype?: string | null;
}

const n = (value: number): string => `${Math.round(value)}/100`;

/** One muted line under the business name, or null when no breakdown. */
export function scoreBlurb(breakdown: unknown): string | null {
  const b = breakdown as BreakdownShape | null;
  if (!b || typeof b !== "object" || !b.components) return null;
  const c = b.components;

  const parts: string[] = [];
  if (typeof c.commercialAuthority === "number") {
    parts.push(`track record ${n(c.commercialAuthority)}`);
  }
  if (typeof c.visibilityGap === "number") {
    parts.push(`room to grow in AI answers ${n(c.visibilityGap)}`);
  }
  if (parts.length === 0) return null;

  // Bookkeeping gaps — noted only when absent, never counted as strengths.
  if (typeof c.contactability !== "number") parts.push("no contact info yet");
  if (typeof c.buyingSignals !== "number") parts.push("recent activity unknown");

  if (b.archetype === "verified_authority_underrepresented") {
    parts.push("priority: proven producer, barely recommended by AI");
  }
  const blurb = parts.join(" · ");
  return blurb.charAt(0).toUpperCase() + blurb.slice(1);
}
