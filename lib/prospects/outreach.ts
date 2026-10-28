/**
 * Deterministic reply-first outreach draft (spec 032, target §10). Template,
 * not model: the first version is generated from the approved finding's own
 * evidence-backed sentences, so nothing an operator did not approve can
 * appear. Structure: why reviewed → one surprising observation → brief
 * competitive context → low-friction question. No calendar links, no jargon,
 * no urgency.
 */
import {
  LEADER_TEMPLATE_VERSION,
  MISMATCH_TEMPLATE_VERSION,
  OUTREACH_TEMPLATE_VERSION,
} from "@/lib/prospects/constants";
import { consumerAnchoredModelPhrase } from "@/lib/prospects/terminology";
import {
  prospectLabel,
  prospectReference,
  type ProspectEntityType,
} from "@/lib/prospects/followup-templates";
import {
  formatProductionDisplay,
  implicationLine,
  marketShortName,
  recencyPhrase,
  PRODUCTION_METRIC_COPY,
  type CompetitiveMismatchReview,
  type LeaderEvidenceSnapshot,
  type MismatchCandidate,
} from "@/lib/prospects/mismatch";

export interface OutreachDraftInput {
  prospectName: string;
  teamLeader: string | null;
  marketName: string;
  /** prospects.prospect_type — decides "agents" vs "teams" (spec 150). */
  prospectType: string;
  /** Prospect-readable names of providers with VALID answers in the
   * finding's own run (resolveFindingEvidence) — never configured ids. */
  providerNames: string[];
  /** Deterministic outreach sentence (findingOutreachObservation) — never
   * the audit-page explanation. */
  observation: string;
  /** The finding's own sample (metrics.sample_size). */
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

/** Plural noun for the kind of business a prospect is (spec 150): an
 * individual agent is never described as one of several "teams". */
export function entityPluralNoun(prospectType: string): string {
  switch (prospectType) {
    case "team":
      return "teams";
    case "individual_agent":
      return "agents";
    case "brokerage":
      return "brokerages";
    default:
      return "real estate firms";
  }
}

/** Entity level for "you" / "your team" wording; null when the prospect
 * type does not say (brokerage, developer…). */
export function entityTypeFromProspectType(prospectType: string): ProspectEntityType | null {
  if (prospectType === "team") return "team";
  if (prospectType === "individual_agent") return "individual";
  return null;
}

const joinNames = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** "an OpenAI model" / "models from OpenAI and Perplexity". */
export function providerModelPhrase(providerNames: string[]): string {
  if (providerNames.length === 1) {
    const name = providerNames[0]!;
    return `${/^[AEIOU]/i.test(name) ? "an" : "a"} ${name} model`;
  }
  return `models from ${joinNames(providerNames)}`;
}

export interface FindingObservationInput {
  kind: string;
  metrics: Record<string, unknown>;
  prospectName: string;
  /** Names of finding.competitor_company_ids, in order. */
  competitorNames: string[];
  /** Label of the finding's first evidenced authority signal. */
  anchorSignalLabel: string | null;
}

export type FindingObservation = { ok: true; sentence: string; sampleSize: number } | { ok: false; detail: string };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * The outreach sentence for an approved finding, built only from its
 * structured fields (spec 150). Audit-page prose (`explanation`) is never
 * pasted: it carries framing written for the page. Unknown kinds or missing
 * data fail closed — no sentence, no draft.
 */
export function findingOutreachObservation(f: FindingObservationInput): FindingObservation {
  // Stored snake_case; the db client camelCases JSON keys on read — accept both.
  const m = (snake: string): unknown =>
    f.metrics[snake] ?? f.metrics[snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
  const n = num(m("sample_size"));
  if (n === null || n <= 0 || !Number.isInteger(n)) {
    return { ok: false, detail: "The finding has no usable sample size." };
  }
  const count = (rate: unknown): number | null => {
    const r = num(rate);
    return r === null || r < 0 || r > 1 ? null : Math.round(r * n);
  };
  const p = f.prospectName;
  switch (f.kind) {
    case "competitor_contrast": {
      const competitor = f.competitorNames[0];
      const pc = count(m("prospect_recommendation_rate"));
      const cc = count(m("competitor_recommendation_rate"));
      if (!competitor || pc === null || cc === null) break;
      return {
        ok: true,
        sampleSize: n,
        sentence: `${competitor} was recommended in ${cc} of ${n} answers; ${p} was recommended in ${pc} of ${n}.`,
      };
    }
    case "authority_visibility_gap": {
      const rc = count(m("recommendation_rate"));
      const label = f.anchorSignalLabel?.trim().replace(/\.$/, "");
      if (rc === null || !label) break;
      return {
        ok: true,
        sampleSize: n,
        sentence: `${p} has a documented record (${label}), yet was recommended in ${rc} of ${n} answers.`,
      };
    }
    case "absence": {
      const mc = count(m("mention_rate"));
      if (mc === null) break;
      return {
        ok: true,
        sampleSize: n,
        sentence:
          mc === 0
            ? `${p} was not mentioned in any of the answers (${n} in total).`
            : `${p} was mentioned in ${mc} of ${n} answers.`,
      };
    }
    case "citation_gap": {
      if (f.competitorNames.length === 0) break;
      return {
        ok: true,
        sampleSize: n,
        sentence: `Those answers cited sources for ${joinNames(f.competitorNames)}, but none that referenced ${p}.`,
      };
    }
    default:
      return { ok: false, detail: `No outreach copy exists for finding kind "${f.kind}".` };
  }
  return { ok: false, detail: `The ${f.kind} finding is missing the data its outreach sentence needs.` };
}

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
    : `I put together the supporting benchmark with the exact questions and answers.`;
  const body = [
    `Hi ${greetingName},`,
    ``,
    `I was benchmarking how AI answers recommend ${input.marketName} ` +
      `${entityPluralNoun(input.prospectType)} across buyer and seller questions, using ` +
      `${providerModelPhrase(input.providerNames)} (${input.sampleSize} monitored answers).`,
    ``,
    `One result about ${input.prospectName} stood out: ${input.observation}`,
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
  now: Date = new Date(),
  /** Spec 150: "you" for an individual agent, "your team" for a team. The
   * draft path always passes it; the default keeps legacy scripts stable
   * and draft QA refuses a team phrasing on an individual prospect. */
  entityType: ProspectEntityType = "team"
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
  // Spec 167: one two-word reply, what it gets them, and how long it takes.
  const cta = `If you want the exact questions and the side-by-side, reply "show me". It's a five-minute read.`;
  const market = marketShortName(review.marketName);
  const body = [
    `${firstName} —`,
    ``,
    `${recency} I ran ${review.scopeCopy} through ${systemPhrase}. ` +
      `${pronoun} recommended ${competitor.displayName} more often than ${prospectReference(entityType)}, ` +
      `even though RealTrends has you ahead on ${PRODUCTION_METRIC_COPY[metricType]}.`,
    ``,
    `${prospectLabel(entityType)}: ${formatProductionDisplay(metricType, prospectValue)} · recommended in ${review.prospect.recommendationCount} of ${n} answers`,
    `${competitor.displayName}: ${formatProductionDisplay(metricType, competitorValue)} · recommended in ${competitor.recommendationCount} of ${n} answers`,
    ``,
    implicationLine(review.audiences),
    ``,
    // Spec 167: candor about variance, the outcome, and urgency through
    // mechanism (prospect-voice) — no projected losses, no guarantees.
    `Any single answer varies; the pattern across all ${n} is the finding. ` +
      `These answers change slowly, so whoever fixes this first becomes the default recommendation in ${market}.`,
    ``,
    // True scarcity: one retained client per market (docs/15-pricing-policy.md).
    `I work with one client per market. ${cta}`,
  ].join("\n");
  return {
    subject: `${firstName} — ${marketShortName(review.marketName)}`,
    body,
    tone: "direct, factual, peer-to-peer",
    cta,
    promptVersion: MISMATCH_TEMPLATE_VERSION,
  };
}

/** Spec 168, Hormozi-aligned like spec 167: the "market leader" Touch 1.
 * Two counts from one run, no production claim. Caller guarantees
 * `evaluateLeader(...).eligible`. */
export function generateLeaderEmail(
  review: CompetitiveMismatchReview,
  snapshot: LeaderEvidenceSnapshot,
  entityType: ProspectEntityType,
  now: Date = new Date()
): GeneratedDraft {
  const recency = recencyPhrase(snapshot.capturedAt ? new Date(snapshot.capturedAt) : (review.benchmarkCompletedAt ?? now), now);
  const pronoun = snapshot.modelCount > 1 ? "They" : "It";
  const n = snapshot.answerCount;
  const market = marketShortName(review.marketName);
  const cta = `If you want the exact questions and the side-by-side, reply "show me". It's a five-minute read.`;
  const body = [
    `${review.firstName!} —`,
    ``,
    `${recency} I ran ${snapshot.scopeCopy} through ${consumerAnchoredModelPhrase(snapshot.provider, snapshot.modelCount)}. ` +
      `${pronoun} recommended ${snapshot.competitor.name} far more often than ${prospectReference(entityType)}.`,
    ``,
    `${prospectLabel(entityType)}: recommended in ${snapshot.prospect.recommendationCount} of ${n} answers`,
    `${snapshot.competitor.name}: recommended in ${snapshot.competitor.recommendationCount} of ${n} answers`,
    ``,
    implicationLine(snapshot.audiences),
    ``,
    `Any single answer varies; the pattern across all ${n} is the finding. ` +
      `These answers change slowly, so whoever fixes this first becomes the default recommendation in ${market}.`,
    ``,
    `I work with one client per market. ${cta}`,
  ].join("\n");
  return {
    subject: `${review.firstName!} — ${market}`,
    body,
    tone: "direct, factual, peer-to-peer",
    cta,
    promptVersion: LEADER_TEMPLATE_VERSION,
  };
}
