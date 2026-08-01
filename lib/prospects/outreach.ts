/**
 * Deterministic reply-first outreach draft (spec 032, target §10). Template,
 * not model: the first version is generated from the approved finding's own
 * evidence-backed sentences, so nothing an operator did not approve can
 * appear. Structure: why reviewed → one surprising observation → brief
 * competitive context → low-friction question. No calendar links, no jargon,
 * no urgency.
 */
import { OUTREACH_TEMPLATE_VERSION } from "@/lib/prospects/constants";

export interface OutreachDraftInput {
  prospectName: string;
  teamLeader: string | null;
  marketName: string;
  findingTitle: string;
  findingExplanation: string;
  providers: string[];
  sampleSize: number;
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
  const cta = "Would it be useful if I sent the benchmark over?";
  const body = [
    `Hi ${greetingName},`,
    ``,
    `I was benchmarking several leading ${input.marketName} teams across buyer and ` +
      `seller questions in ${providerLabel(input.providers)} (${input.sampleSize} ` +
      `monitored responses).`,
    ``,
    `One result about ${input.prospectName} surprised me: ${input.findingExplanation}`,
    ``,
    `I put together the supporting benchmark with the exact prompts and responses. ${cta}`,
  ].join("\n");

  return {
    subject: `A ${input.marketName} benchmark result about ${input.prospectName}`,
    body,
    tone: "curious, factual, low-pressure",
    cta,
    promptVersion: OUTREACH_TEMPLATE_VERSION,
  };
}
