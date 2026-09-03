/**
 * Touch 2 / Touch 3 templates for the competitive-mismatch sequence
 * (spec 127). Pure render over the FROZEN Touch 1 evidence snapshot plus a
 * scoped deterministic copy linter. Copy lives in docs/13-prompts.md.
 */
import {
  FOLLOWUP_SEVERAL_QUESTIONS_MIN,
  FOLLOWUP_TEMPLATE_VERSIONS,
  OUTREACH_FORBIDDEN_FOOTER_HOST,
  OUTREACH_PUBLIC_WEBSITE,
  type FollowupTemplateVersion,
} from "@/lib/prospects/constants";
import { marketShortName, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import type { DraftQaIssue } from "@/lib/prospects/draft-qa";

export type FollowupBranch = "engaged" | "no_engagement";

export function followupTemplateFor(touch: 2 | 3, branch: FollowupBranch): FollowupTemplateVersion {
  if (touch === 2) {
    return branch === "engaged"
      ? FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged
      : FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement;
  }
  return branch === "engaged"
    ? FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged
    : FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement;
}

/** New thread only for the re-earn-attention Touch 2; everything else
 * replies into the most recent sequence thread. */
export function followupStartsNewThread(version: FollowupTemplateVersion): boolean {
  return version === FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement;
}

export interface FollowupRenderInput {
  firstName: string;
  marketName: string;
  snapshot: MismatchEvidenceSnapshot;
  /** Distinct frozen-run questions where the competitor was recommended. */
  distinctCompetitorQuestions: number;
  /** Postal + opt-out lines copied verbatim from the Touch 1 footer. */
  footerTail: string[];
}

export interface RenderedFollowup {
  version: FollowupTemplateVersion;
  /** Null when the touch replies into an existing thread (subject = Re: parent). */
  subject: string | null;
  body: string;
  claimVariant: "several_questions" | "side_by_side" | null;
}

const SEPARATOR = "--";
const FIRST = "Francisco";

function footer(full: boolean, tail: string[]): string[] {
  const sig = full ? [FIRST, "Recommended First", OUTREACH_PUBLIC_WEBSITE] : [FIRST];
  return ["", SEPARATOR, ...sig, ...tail];
}

export function renderFollowup(
  version: FollowupTemplateVersion,
  input: FollowupRenderInput
): RenderedFollowup {
  const s = input.snapshot;
  const first = input.firstName.trim();
  const market = marketShortName(input.marketName);
  const comp = s.competitor.name;
  const n = s.answerCount;
  const pc = s.prospect.recommendationCount;
  const cc = s.competitor.recommendationCount;
  const pd = s.prospect.productionDisplay;
  const cd = s.competitor.productionDisplay;
  let lines: string[];
  let subject: string | null = null;
  let claimVariant: RenderedFollowup["claimVariant"] = null;
  switch (version) {
    case FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement:
      subject = `${first} - one thing I found`;
      lines = [
        `${first},`, ``,
        `I found something odd when I tested which ${market} teams AI recommends to buyers and sellers.`, ``,
        `RealTrends has your team at ${pd}, ahead of ${comp} at ${cd}.`, ``,
        `But in the same test:`, ``,
        `Your team: recommended in ${pc} of ${n} answers`,
        `${comp}: recommended in ${cc} of ${n}`, ``,
        `I put the exact questions and answers into a private report for your team.`, ``,
        `Want me to send it?`,
        ...footer(true, input.footerTail),
      ];
      break;
    case FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged: {
      const several = input.distinctCompetitorQuestions >= FOLLOWUP_SEVERAL_QUESTIONS_MIN;
      claimVariant = several ? "several_questions" : "side_by_side";
      lines = several
        ? [
            `${first},`, ``,
            `One more thing I noticed after I sent this.`, ``,
            `The gap wasn't coming from one unusual question. ${comp} showed up across several of the buyer and seller questions I tested.`, ``,
            `That's why I thought it was worth flagging.`, ``,
            `I already have the exact questions and answers pulled together for your team.`, ``,
            `Happy to send them over if you want to see it.`,
            ...footer(false, input.footerTail),
          ]
        : [
            `${first},`, ``,
            `One more thing I wanted to flag.`, ``,
            `The side-by-side is what stood out: your team closed more, but ${comp} was still recommended more often in the same test.`, ``,
            `I already have the exact questions and answers pulled together for your team.`, ``,
            `Happy to send them over if you want to see it.`,
            ...footer(false, input.footerTail),
          ];
      break;
    }
    case FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged:
      lines = [
        `${first},`, ``,
        `The part I find most interesting is that your sales numbers aren't the issue. You're already ahead of ${comp}.`, ``,
        `So the question is why AI keeps showing them more often than your team.`, ``,
        `That's what I started breaking down in the private report.`, ``,
        `Want me to send it?`,
        ...footer(false, input.footerTail),
      ];
      break;
    case FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement:
      lines = [
        `${first},`, ``,
        `Last note from me on this.`, ``,
        `RealTrends has your team at ${pd} versus ${comp} at ${cd}, but they were recommended ${cc} times versus ${pc} for your team in the same test.`, ``,
        `If you want the exact questions and answers, I have the private report ready.`, ``,
        `Worth sending over?`,
        ...footer(false, input.footerTail),
      ];
      break;
    default:
      throw new Error(`unknown follow-up template ${String(version)}`);
  }
  return { version, subject, body: lines.join("\n"), claimVariant };
}

/** Frozen-evidence fragments a rendered body must still state, per template. */
export function followupFragments(
  version: FollowupTemplateVersion,
  s: MismatchEvidenceSnapshot
): string[] {
  const comp = s.competitor.name;
  switch (version) {
    case FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement:
      return [
        `your team at ${s.prospect.productionDisplay}, ahead of ${comp} at ${s.competitor.productionDisplay}`,
        `Your team: recommended in ${s.prospect.recommendationCount} of ${s.answerCount} answers`,
        `${comp}: recommended in ${s.competitor.recommendationCount} of ${s.answerCount}`,
      ];
    case FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement:
      return [
        `your team at ${s.prospect.productionDisplay} versus ${comp} at ${s.competitor.productionDisplay}`,
        `recommended ${s.competitor.recommendationCount} times versus ${s.prospect.recommendationCount} for your team`,
      ];
    default:
      return [comp];
  }
}

const BANNED_TERMS: RegExp[] = [
  /\b(AEO|GEO|LLMs?)\b/,
  /\b(entity optimization|citation acquisition|visibility engineering|prompt engineering|generative engine optimization|generative search)\b/i,
  /\b(citations?|prompts?|retrieval|semantic|share of voice|authority signals?|benchmark(s|ing)?|optimization framework|technical accessibility|model architecture)\b/i,
  /\b(AI visibility|source intelligence|private benchmark)\b/i,
  /\b(just following up|bumping this|circling back|checking in|touching base|did you see my last email)\b/i,
  /\b(calendly|book a call|pricing|retainer|consultation)\b/i,
];
const PLACEHOLDER = /\{[^}]*\}|\bnull\b|\bundefined\b|\bNaN\b|\[object/;
const URL = /https?:\/\/|\bcal\.com\b/i;
const HTML = /<\/?[a-z][^>]*>|&[a-z]+;/i;

/** Deterministic copy gate scoped to the follow-up templates. */
export function lintFollowupCopy(subject: string | null, body: string): DraftQaIssue[] {
  const issues: DraftQaIssue[] = [];
  const text = `${subject ?? ""}\n${body}`;
  for (const re of BANNED_TERMS) {
    const m = text.match(re);
    if (m) issues.push({ check: "followup_copy", detail: `contains "${m[0]}".` });
  }
  if (PLACEHOLDER.test(text)) issues.push({ check: "followup_copy", detail: "placeholder or artifact in copy." });
  if (URL.test(text)) issues.push({ check: "followup_copy", detail: "follow-ups carry no links." });
  if (HTML.test(text)) issues.push({ check: "followup_copy", detail: "HTML artifact in copy." });
  if (text.toLowerCase().includes(OUTREACH_FORBIDDEN_FOOTER_HOST)) {
    issues.push({ check: "followup_copy", detail: `legacy ${OUTREACH_FORBIDDEN_FOOTER_HOST} footer.` });
  }
  if ((body.match(new RegExp(`^${SEPARATOR}$`, "gm")) ?? []).length !== 1) {
    issues.push({ check: "followup_copy", detail: "exactly one signature block expected." });
  }
  if ((body.match(/\bunsubscribe\b/gi) ?? []).length === 0) {
    issues.push({ check: "followup_copy", detail: "opt-out line missing." });
  }
  return issues;
}

/** Frozen-evidence check: the body must state the template's fragments and
 * must not state any competing figure. */
export function qaFollowupEvidence(
  version: FollowupTemplateVersion,
  body: string,
  s: MismatchEvidenceSnapshot
): DraftQaIssue[] {
  const issues: DraftQaIssue[] = [];
  for (const fragment of followupFragments(version, s)) {
    if (!body.includes(fragment)) {
      issues.push({ check: "followup_evidence", detail: `body no longer states "${fragment}".` });
    }
  }
  const ofN = [...body.matchAll(/\b(\d+) of (\d+)\b/g)];
  for (const m of ofN) {
    if (Number(m[2]) !== s.answerCount) {
      issues.push({ check: "followup_evidence", detail: `denominator ${m[2]} is not the frozen ${s.answerCount}.` });
    }
    const c = Number(m[1]);
    if (c !== s.prospect.recommendationCount && c !== s.competitor.recommendationCount) {
      issues.push({ check: "followup_evidence", detail: `count ${c} is not a frozen count.` });
    }
  }
  return issues;
}
