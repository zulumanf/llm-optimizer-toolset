/**
 * EVIDENCE_CORRECTION copy (founder framing 2026-09-06). Renders the STRONG
 * correction message for a prospect whose delivered Touch 1 stated counts
 * that a spec 130 correction changed, while the corrected frozen evidence
 * still supports the original comparison. Pure: the sent claim comes from
 * the delivered Touch 1's frozen snapshot, the corrected counts from the
 * correction on the SAME run, production from the same snapshot. Nothing
 * here creates drafts or sends; the message is a separate operational
 * category from T1/T2/T3 and must never be reported with them.
 *
 * Prospects whose corrected evidence invalidates the conclusion are NOT
 * rendered here (EVIDENCE_CORRECTION_CORRECT_ONLY: no CTA, no restart);
 * that path stays the integrity-first stop.
 */
import { lintFollowupCopy } from "@/lib/prospects/followup-templates";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { marketShortName, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

export const STRONG_CORRECTION_TEMPLATE_VERSION = "evidence_correction_strong_v1";
export const CORRECTION_CTA = "Want me to send the exact questions?";
export const CORRECTION_TRUST_LINE = "I wanted to correct that before sending you anything else.";
const LARGER_LINE = "So the mismatch is actually larger than I first showed:";
const SMALLER_LINE_ONE_SIDE = "With the corrected count, the comparison is:";
const SMALLER_LINE_BOTH = "With the corrected numbers:";

export type CorrectionEntityType = "individual" | "team";

export interface StrongCorrectionInput {
  firstName: string;
  marketName: string;
  entityType: CorrectionEntityType;
  /** What the delivered Touch 1 stated (frozen). */
  original: MismatchEvidenceSnapshot;
  /** The correction on the same run (frozen). */
  corrected: MismatchEvidenceSnapshot;
  /** Signature + compliance lines exactly as the Touch 1 carried them. */
  footer: string[];
}

export interface RenderedCorrection {
  version: typeof STRONG_CORRECTION_TEMPLATE_VERSION;
  body: string;
  cta: string;
  /** Which side(s) the correction changed. */
  change: "competitor" | "prospect" | "both";
  gapIncreased: boolean;
}

/** Deterministic entity wording: never inferred from copy. */
export function correctionLabels(entityType: CorrectionEntityType): { subject: string; object: string } {
  return entityType === "team" ? { subject: "Your team", object: "your team" } : { subject: "You", object: "you" };
}

export function gapOf(s: MismatchEvidenceSnapshot): number {
  return s.competitor.recommendationCount - s.prospect.recommendationCount;
}

export function renderStrongCorrection(input: StrongCorrectionInput): RenderedCorrection {
  const o = input.original, n = input.corrected;
  const N = n.answerCount;
  const comp = n.competitor.name;
  const { subject, object } = correctionLabels(input.entityType);
  const stillVerb = input.entityType === "team" ? "is" : "are";
  const prospectChanged = o.prospect.recommendationCount !== n.prospect.recommendationCount;
  const competitorChanged = o.competitor.recommendationCount !== n.competitor.recommendationCount;
  const change: RenderedCorrection["change"] = prospectChanged && competitorChanged ? "both" : prospectChanged ? "prospect" : "competitor";
  const gapIncreased = gapOf(n) > gapOf(o);

  const correction: string[] = [];
  if (change === "both") {
    correction.push(`I originally had ${object} at ${o.prospect.recommendationCount} of ${N} and ${comp} at ${o.competitor.recommendationCount}. The correct count from the same ${N} answers is ${n.prospect.recommendationCount} versus ${n.competitor.recommendationCount}.`);
  } else if (change === "competitor") {
    correction.push(`I originally had ${comp} at ${o.competitor.recommendationCount} of ${N} answers. The correct count from the same ${N} answers is ${n.competitor.recommendationCount}.`);
    correction.push(``, `${subject} ${stillVerb} still ${n.prospect.recommendationCount} of ${N}.`);
  } else {
    correction.push(`I originally had ${object} at ${o.prospect.recommendationCount} of ${N} answers. The correct count from the same ${N} answers is ${n.prospect.recommendationCount}.`);
    correction.push(``, `${comp} is still ${n.competitor.recommendationCount} of ${N}.`);
  }
  const lead = gapIncreased ? LARGER_LINE : change === "both" ? SMALLER_LINE_BOTH : SMALLER_LINE_ONE_SIDE;
  const body = [
    `${input.firstName},`, ``,
    `I rechecked the ${marketShortName(input.marketName)} results before following up and caught one correction.`, ``,
    ...correction, ``,
    lead, ``,
    `${subject}: ${n.prospect.productionDisplay} · ${n.prospect.recommendationCount} of ${N}`,
    `${comp}: ${n.competitor.productionDisplay} · ${n.competitor.recommendationCount} of ${N}`, ``,
    CORRECTION_TRUST_LINE, ``,
    CORRECTION_CTA, ``,
    ...input.footer,
  ].join("\n");
  return { version: STRONG_CORRECTION_TEMPLATE_VERSION, body, cta: CORRECTION_CTA, change, gapIncreased };
}

const JARGON = /\b(entity[- ]matching|entity[- ]resolution|alias(es)?|reconcil\w*|data pipeline|pipeline|counting bug|system error|takeaway)\b/i;
const ADVERSARIAL = /\b(worse for you|even worse)\b/i;

export interface CorrectionQaContext {
  /** Body of the delivered Touch 1 (the sent claim must be what it states). */
  touch1Body: string;
  entityType: CorrectionEntityType | null;
  entityConfidence: "high" | "medium" | "low";
}

/** Fail-closed QA for a rendered strong correction. Every issue blocks. */
export function qaStrongCorrection(
  subject: string | null,
  body: string,
  original: MismatchEvidenceSnapshot,
  corrected: MismatchEvidenceSnapshot,
  ctx: CorrectionQaContext
): { check: string; detail: string }[] {
  const issues: { check: string; detail: string }[] = [];
  const add = (check: string, detail: string): void => { issues.push({ check, detail }); };
  const N = corrected.answerCount;
  // 1. The sent claim really is what the Touch 1 stated.
  for (const f of [
    `in ${original.prospect.recommendationCount} of ${original.answerCount} answers`,
    `in ${original.competitor.recommendationCount} of ${original.answerCount} answers`,
    original.competitor.name,
  ]) if (!ctx.touch1Body.includes(f)) add("correction_history", `the delivered Touch 1 does not state "${f}".`);
  // 2. Same frozen run and denominator; production canonical (unchanged).
  if (original.runId !== corrected.runId) add("correction_run", "corrected evidence is not from the same frozen run.");
  if (original.answerCount !== N) add("correction_run", `denominator changed ${original.answerCount} → ${N}.`);
  if (original.prospect.productionDisplay !== corrected.prospect.productionDisplay || original.competitor.productionDisplay !== corrected.competitor.productionDisplay) {
    add("correction_production", "production values differ between the sent claim and the correction.");
  }
  if (original.prospect.recommendationCount === corrected.prospect.recommendationCount && original.competitor.recommendationCount === corrected.competitor.recommendationCount) {
    add("correction_material", "nothing changed; a correction message has no basis.");
  }
  // 3. Still eligible after correction; entity confidence high; entity level known.
  const ratio = corrected.competitor.productionRatio;
  if (gapOf(corrected) < MISMATCH_THRESHOLDS.minRecommendationGap || (ratio !== null && ratio > MISMATCH_THRESHOLDS.maxCompetitorProductionRatio)) {
    add("correction_eligibility", "corrected evidence no longer passes the mismatch gate; use the correct-only path.");
  }
  if (ctx.entityConfidence !== "high") add("correction_entity", `entity confidence is ${ctx.entityConfidence}; strong corrections need high.`);
  if (!ctx.entityType) add("correction_entity", "entity level unknown; you/your team wording fails closed.");
  // 4. The body states the original and corrected numbers, plainly.
  const origFragments = [String(original.competitor.recommendationCount), String(original.prospect.recommendationCount)];
  if (!body.includes(`I originally had`)) add("correction_copy", "body does not state what was originally sent.");
  for (const f of origFragments) if (!body.includes(f)) add("correction_copy", `original number ${f} not stated.`);
  for (const f of [
    `· ${corrected.prospect.recommendationCount} of ${N}`,
    `· ${corrected.competitor.recommendationCount} of ${N}`,
    corrected.prospect.productionDisplay,
    corrected.competitor.productionDisplay,
  ]) if (!body.includes(f)) add("correction_copy", `corrected block does not state "${f}".`);
  // 5. "larger" only when mathematically true; never adversarial.
  if (body.includes(LARGER_LINE) && gapOf(corrected) <= gapOf(original)) add("correction_claim", "claims a larger mismatch but the gap did not increase.");
  if (!body.includes(LARGER_LINE) && gapOf(corrected) > gapOf(original)) add("correction_claim", "gap increased but the body does not say so; wording drifted from the template.");
  if (ADVERSARIAL.test(body)) add("correction_tone", "adversarial phrasing.");
  // 6. Entity wording.
  if (ctx.entityType === "team" && !body.includes("Your team:")) add("correction_entity_wording", "team prospect but no \"Your team\" line.");
  if (ctx.entityType === "individual" && !body.includes("You:")) add("correction_entity_wording", "individual prospect but no \"You\" line.");
  if (ctx.entityType === "individual" && /\byour team\b/i.test(body)) add("correction_entity_wording", "individual prospect addressed as a team.");
  // 7. Language: no jargon, no em dash, no pricing/link/call/meeting (shared follow-up lint).
  if (JARGON.test(body)) add("correction_jargon", `technical wording: ${body.match(JARGON)?.[0]}.`);
  if (body.includes("—") || (subject ?? "").includes("—")) add("correction_punctuation", "em dash present.");
  if (/https?:\/\//i.test(body)) add("correction_link", "link present; no report link before a reply.");
  // Shared follow-up lint (pricing, calls, links, jargon, signature, opt-out),
  // minus its ban on "following up": the approved opener says "before
  // following up" as a statement of fact, not the "just following up" bump.
  issues.push(
    ...lintFollowupCopy(subject, body)
      .filter((i) => i.detail !== 'contains "following up".')
      .map((i) => ({ check: `correction_${i.check}`, detail: i.detail }))
  );
  return issues;
}
