/**
 * Deterministic screen-recording plan (spec 032, target §11). A storyboard
 * for a 2–3 minute prospect-first recording: context → evidence → benchmark
 * → explanation → opportunity → CTA. Claims that need on-camera verification
 * are listed explicitly so the recorder never improvises a fact.
 */
import { RECORDING_GENERATOR_VERSION } from "@/lib/prospects/constants";

export interface RecordingPlanInput {
  prospectName: string;
  marketName: string;
  findingTitle: string;
  findingExplanation: string;
  competitorNames: string[];
  providers: string[];
  sampleSize: number;
  /** representative prompt texts to show on screen (max ~2 used) */
  examplePrompts: string[];
}

export interface StoryboardSegment {
  start: string;
  end: string;
  title: string;
  screen: string;
  talkingPoints: string[];
}

export interface GeneratedRecordingPlan {
  script: string;
  storyboard: StoryboardSegment[];
  estimatedDurationSeconds: number;
  claimsToVerify: string[];
  cta: string;
  generatorVersion: string;
}

export function generateRecordingPlan(input: RecordingPlanInput): GeneratedRecordingPlan {
  const prompts = input.examplePrompts.slice(0, 2);
  const rivals =
    input.competitorNames.length > 0
      ? input.competitorNames.slice(0, 2).join(" and ")
      : "several direct competitors";
  const cta = `If AI recommendations matter for ${input.marketName} sellers this year, is this worth a 20-minute look together?`;

  const storyboard: StoryboardSegment[] = [
    {
      start: "0:00",
      end: "0:20",
      title: "Context",
      screen: "Benchmark overview page for the market",
      talkingPoints: [
        `I benchmarked leading ${input.marketName} teams across buyer and seller questions.`,
        `One result about ${input.prospectName} stood out: ${input.findingTitle}.`,
      ],
    },
    {
      start: "0:20",
      end: "0:55",
      title: "Evidence",
      screen: "One or two live prompts with responses",
      talkingPoints: [
        ...(prompts.length > 0
          ? prompts.map((p) => `Show the prompt: "${p}" and who appears in the answer.`)
          : ["Show a representative recommendation prompt and who appears."]),
        `Note which teams appear — ${rivals} — and who is absent.`,
        "Make clear this is a pattern across many responses, not one answer.",
      ],
    },
    {
      start: "0:55",
      end: "1:30",
      title: "Benchmark",
      screen: "Prospect audit page: metrics section",
      talkingPoints: [
        input.findingExplanation,
        `Sample: ${input.sampleSize} monitored responses across ${input.providers.join(", ") || "the tested engines"}.`,
      ],
    },
    {
      start: "1:30",
      end: "2:10",
      title: "Explanation",
      screen: "Citation/source view",
      talkingPoints: [
        "What the assistants cite when they recommend competitors.",
        "Observation vs hypothesis: the gap is measured; the cause is our working theory.",
      ],
    },
    {
      start: "2:10",
      end: "2:40",
      title: "Opportunity",
      screen: "High-priority opportunities section of the audit",
      talkingPoints: [
        "The two or three areas we would investigate first.",
        "No internal tactics — direction, not the playbook.",
      ],
    },
    {
      start: "2:40",
      end: "3:00",
      title: "CTA",
      screen: "Audit page header",
      talkingPoints: [cta],
    },
  ];

  const script = storyboard
    .map(
      (s) =>
        `## ${s.start}–${s.end} — ${s.title}\n**Screen:** ${s.screen}\n` +
        s.talkingPoints.map((t) => `- ${t}`).join("\n")
    )
    .join("\n\n");

  return {
    script,
    storyboard,
    estimatedDurationSeconds: 180,
    claimsToVerify: [
      `The finding wording matches the approved finding exactly: "${input.findingTitle}".`,
      `Sample size on screen matches ${input.sampleSize}.`,
      "Every prompt shown live is one from the monitored set.",
      "No revenue or causality claims are spoken.",
    ],
    cta,
    generatorVersion: RECORDING_GENERATOR_VERSION,
  };
}
