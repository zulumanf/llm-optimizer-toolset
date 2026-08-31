/**
 * Deterministic reply-first outreach draft (spec 032, target §10). Template,
 * not model: the first version is generated from the approved finding's own
 * evidence-backed sentences, so nothing an operator did not approve can
 * appear. Structure: why reviewed → one surprising observation → brief
 * competitive context → low-friction question. No calendar links, no jargon,
 * no urgency.
 */
import {
  MISMATCH_TEMPLATE_VERSION,
  OUTREACH_TEMPLATE_VERSION,
} from "@/lib/prospects/constants";
import { consumerAnchoredModelPhrase } from "@/lib/prospects/terminology";
import {
  formatProductionDisplay,
  implicationLine,
  marketShortName,
  recencyPhrase,
  PRODUCTION_METRIC_COPY,
  type CompetitiveMismatchReview,
  type MismatchCandidate,
} from "@/lib/prospects/mismatch";

export interface OutreachDraftInput {
  prospectName: string;
  teamLeader: string | null;
  marketName: string;
  findingTitle: string;
  findingExplanation: string;
  providers: string[];
  sampleSize: number;
  /** Published audit page link (plan 3.1). Null = not published or no
   * APP_URL; the draft falls back to the pure reply-first ask. */
  auditUrl?: string | null;
}

export interface GeneratedDraft {
  subject: string;
  body: string;
  tone: string;
  cta: string;
  promptVersion: string;
}

const providerLabel = (providers: string[]): string => {
  if (providers.length === 0) return "AI assistants";
  if (providers.length === 1) return providers[0]!;
  return `${providers.slice(0, -1).join(", ")} and ${providers[providers.length - 1]}`;
};

export function generateReplyFirstEmail(input: OutreachDraftInput): GeneratedDraft {
  const greetingName = input.teamLeader?.split(" ")[0] ?? "there";
  // With a published audit the link does the proving and the ask matches the
  // page's own CTA chip ("show me"). Without one, ask-first as before.
  const cta = input.auditUrl
    ? `If it's useful, reply "show me" and I'll walk you through it — 15 minutes.`
    : "Would it be useful if I sent the benchmark over?";
  const proofParagraph = input.auditUrl
    ? `The full benchmark is here — every question and complete answer included, ` +
      `so you can search for your own name: ${input.auditUrl}`
    : `I put together the supporting benchmark with the exact prompts and responses.`;
  const body = [
    `Hi ${greetingName},`,
    ``,
    `I was benchmarking several leading ${input.marketName} teams across buyer and ` +
      `seller questions in ${providerLabel(input.providers)} (${input.sampleSize} ` +
      `monitored responses).`,
    ``,
    `One result about ${input.prospectName} surprised me: ${input.findingExplanation}`,
    ``,
    `${proofParagraph}${input.auditUrl ? `\n\n${cta}` : ` ${cta}`}`,
  ].join("\n");

  return {
    subject: `${/^[AEIOU]/i.test(input.marketName) ? "An" : "A"} ${input.marketName} benchmark result about ${input.prospectName}`,
    body,
    tone: "curious, factual, low-pressure",
    cta,
    promptVersion: OUTREACH_TEMPLATE_VERSION,
  };
}

/**
 * Competitive-mismatch template (spec 124). Touch 1 sells only the
 * comparison: no bio, no links, no attachments, no meeting ask, no jargon.
 * Plain text; the compliant footer is appended by the caller
 * (optOutFooter), exactly like the reply-first template. The tested system
 * is named per the terminology rule — the OpenAI model(s) behind ChatGPT,
 * never "we asked ChatGPT".
 * Caller guarantees `review.evaluation.eligible` and passes the selected
 * (or operator-chosen eligible) candidate — this function only renders.
 */
export function generateCompetitiveMismatchEmail(
  review: CompetitiveMismatchReview,
  competitor: MismatchCandidate,
  now: Date = new Date()
): GeneratedDraft {
  const firstName = review.firstName!;
  const benchmark = review.benchmark!;
  const metricType = competitor.metricType!;
  const prospectValue =
    metricType === "closed_volume"
      ? review.prospect.production!.volumeUsd
      : review.prospect.production!.sides;
  const competitorValue =
    metricType === "closed_volume"
      ? competitor.production!.volumeUsd
      : competitor.production!.sides;
  const recency = recencyPhrase(
    benchmark.capturedAt ?? review.benchmarkCompletedAt ?? now,
    now
  );
  const systemPhrase = consumerAnchoredModelPhrase(
    benchmark.provider,
    benchmark.modelCount
  );
  const pronoun = benchmark.modelCount > 1 ? "They" : "It";
  const n = benchmark.answerCount;
  const cta = "I have the exact questions and the side-by-side. Want me to send them?";
  const body = [
    `${firstName} —`,
    ``,
    `${recency} I ran ${review.scopeCopy} through ${systemPhrase}. ` +
      `${pronoun} recommended ${competitor.displayName} more often than your team, ` +
      `even though RealTrends has you ahead on ${PRODUCTION_METRIC_COPY[metricType]}.`,
    ``,
    `Your team: ${formatProductionDisplay(metricType, prospectValue)} · recommended in ${review.prospect.recommendationCount} of ${n} answers`,
    `${competitor.displayName}: ${formatProductionDisplay(metricType, competitorValue)} · recommended in ${competitor.recommendationCount} of ${n} answers`,
    ``,
    implicationLine(review.audiences),
    ``,
    cta,
  ].join("\n");
  return {
    subject: `${firstName} — ${marketShortName(review.marketName)}`,
    body,
    tone: "direct, factual, peer-to-peer",
    cta,
    promptVersion: MISMATCH_TEMPLATE_VERSION,
  };
}
