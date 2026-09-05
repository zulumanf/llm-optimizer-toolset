/**
 * Touch 2 / Touch 3 templates for the competitive-mismatch sequence
 * (spec 127, copy v2). Pure render over the FROZEN Touch 1 evidence snapshot
 * plus a scoped deterministic copy linter and evidence QA. Copy lives in
 * docs/13-prompts.md. The only goal of a follow-up is a human reply: no
 * links, no call ask, no pricing, no jargon, one CTA, no em dashes.
 */
import {
  FOLLOWUP_MAX_BODY_WORDS,
  FOLLOWUP_SEVERAL_QUESTIONS_MIN,
  FOLLOWUP_TEMPLATE_VERSIONS,
  OUTREACH_FORBIDDEN_FOOTER_HOST,
  OUTREACH_PUBLIC_WEBSITE,
  type FollowupTemplateVersion,
} from "@/lib/prospects/constants";
import { marketShortName, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import type { DraftQaIssue } from "@/lib/prospects/draft-qa";

export type FollowupBranch = "engaged" | "no_engagement";
/** RealTrends entity level of the prospect's frozen production record. */
export type ProspectEntityType = "individual" | "team";

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

/** "you" for an individual agent, "your team" for a team. An unknown
 * entity type renders a visible placeholder so the linter fails closed. */
export function prospectReference(entityType: ProspectEntityType | null): string {
  if (entityType === "team") return "your team";
  if (entityType === "individual") return "you";
  return "{prospect_reference}";
}
export function prospectLabel(entityType: ProspectEntityType | null): string {
  if (entityType === "team") return "Your team";
  if (entityType === "individual") return "You";
  return "{prospect_label}";
}

export const CATEGORY_LINE_PREFIX = "Most of the gap showed up around ";
export const DISTINCT_QUESTIONS_CLAIM = /\bcame up across (\d+) different questions\b/;
const REPORT_CLAIM = /\bprivate report\b/i;

export interface FollowupRenderInput {
  firstName: string;
  marketName: string;
  snapshot: MismatchEvidenceSnapshot;
  /** Distinct frozen-run questions where the competitor was recommended. */
  distinctCompetitorQuestions: number;
  /** Postal + opt-out lines copied verbatim from the Touch 1 footer. */
  footerTail: string[];
  entityType: ProspectEntityType | null;
  /** True only when a finished private report over this exact frozen
   * evidence exists for the prospect (truthfulness gate). */
  reportReady: boolean;
  /** Touch 3 engaged only: one frozen-evidence category line, or null. */
  categoryLine: string | null;
}

export interface RenderedFollowup {
  version: FollowupTemplateVersion;
  /** Null when the touch replies into an existing thread (subject = Re: parent). */
  subject: string | null;
  body: string;
  /** The single ask, verbatim. */
  cta: string;
  claimVariant: "distinct_questions" | "side_by_side" | null;
}

const SEPARATOR = "--";
const FIRST = "Francisco";

function footer(full: boolean, tail: string[]): string[] {
  const sig = full ? [FIRST, "Recommended First", OUTREACH_PUBLIC_WEBSITE] : [FIRST];
  return ["", SEPARATOR, ...sig, ...tail];
}

/** The promise + ask, truthful to whether a finished report exists. */
function offer(kind: "send_them" | "want_to_see" | "if_you_want", reportReady: boolean): { lines: string[]; cta: string } {
  const thing = reportReady ? "it" : "them";
  const have = reportReady ? "I have the private report ready" : "I have the exact questions and answers pulled together";
  switch (kind) {
    case "send_them": {
      const cta = `Want me to send ${thing}?`;
      return { lines: [`${have}.`, ``, cta], cta };
    }
    case "want_to_see": {
      const cta = `Just say yes and I'll send ${thing}.`;
      return { lines: [`${have} if you want to see ${thing}.`, ``, cta], cta };
    }
    case "if_you_want": {
      const cta = `If you want to see ${thing}, just say yes and I'll send ${thing}.`;
      return { lines: [`${have}.`, ``, cta], cta };
    }
  }
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
  const ref = prospectReference(input.entityType);
  const label = prospectLabel(input.entityType);
  const sideBySide = `RealTrends has ${ref} at ${pd} versus ${cd} for ${comp}`;
  let lines: string[];
  let subject: string | null = null;
  let claimVariant: RenderedFollowup["claimVariant"] = null;
  let ask: { lines: string[]; cta: string };
  switch (version) {
    case FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement:
      subject = `${first} - one thing I found`;
      ask = offer("send_them", input.reportReady);
      lines = [
        `${first},`, ``,
        `One more thing on ${market}.`, ``,
        `${sideBySide}.`, ``,
        `But in the same test:`, ``,
        `${label}: recommended in ${pc} of ${n} answers`,
        `${comp}: recommended in ${cc} of ${n}`, ``,
        ...ask.lines,
        ...footer(true, input.footerTail),
      ];
      break;
    case FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged: {
      const distinct = input.distinctCompetitorQuestions;
      const several = distinct >= FOLLOWUP_SEVERAL_QUESTIONS_MIN;
      claimVariant = several ? "distinct_questions" : "side_by_side";
      ask = offer("send_them", input.reportReady);
      lines = several
        ? [
            `${first},`, ``,
            `One thing I noticed after I sent this.`, ``,
            `This wasn't limited to one answer. ${comp} came up across ${distinct} different questions in the same ${market} test.`, ``,
            `That's why I thought it was worth flagging.`, ``,
            ...ask.lines,
            ...footer(false, input.footerTail),
          ]
        : [
            `${first},`, ``,
            `One more thing I noticed.`, ``,
            `The side-by-side is what stood out to me. ${sideBySide}, but the recommendation results went the other way.`, ``,
            ...ask.lines.map((l, i) => (i === 0 ? l.replace(/^I have/, "I already have") : l)),
            ...footer(false, input.footerTail),
          ];
      break;
    }
    case FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged:
      ask = offer("want_to_see", input.reportReady);
      lines = [
        `${first},`, ``,
        `Last note from me on this.`, ``,
        `The only reason I reached out is that the numbers looked backwards to me.`, ``,
        `RealTrends has ${ref} ahead of ${comp}, but ${comp} kept showing up more often in the questions I tested.`, ``,
        ...(input.categoryLine ? [input.categoryLine, ``] : []),
        `That's what made me take a closer look.`, ``,
        ...ask.lines,
        ...footer(false, input.footerTail),
      ];
      break;
    case FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement:
      ask = offer("if_you_want", input.reportReady);
      lines = [
        `${first},`, ``,
        `Last note from me on this.`, ``,
        `The only reason I emailed you is that ${sideBySide}, but the recommendation results went the other way.`, ``,
        ...ask.lines,
        ...footer(false, input.footerTail),
      ];
      break;
    default:
      throw new Error(`unknown follow-up template ${String(version)}`);
  }
  return { version, subject, body: lines.join("\n"), cta: ask.cta, claimVariant };
}

/** Frozen-evidence fragments a rendered body must still state, per template. */
export function followupFragments(
  version: FollowupTemplateVersion,
  s: MismatchEvidenceSnapshot,
  entityType: ProspectEntityType | null
): string[] {
  const comp = s.competitor.name;
  const ref = prospectReference(entityType);
  const sideBySide = `RealTrends has ${ref} at ${s.prospect.productionDisplay} versus ${s.competitor.productionDisplay} for ${comp}`;
  switch (version) {
    case FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement:
      return [
        `${sideBySide}.`,
        `${prospectLabel(entityType)}: recommended in ${s.prospect.recommendationCount} of ${s.answerCount} answers`,
        `${comp}: recommended in ${s.competitor.recommendationCount} of ${s.answerCount}`,
      ];
    case FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement:
      return [sideBySide];
    case FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged:
      return [`RealTrends has ${ref} ahead of ${comp}`];
    default:
      return [comp];
  }
}

const BANNED_TERMS: RegExp[] = [
  /\b(AEO|GEO|LLMs?)\b/,
  /\b(entity optimization|citation acquisition|visibility engineering|prompt engineering|generative engine optimization|generative search)\b/i,
  /\b(citations?|prompts?|retrieval|semantic|share of voice|authority signals?|benchmark(s|ing)?|optimization framework|technical accessibility|model architecture)\b/i,
  /\b(AI visibility|source intelligence|private benchmark)\b/i,
  /\b(just following up|following up|bumping this|circling back|checking in|touching base|did you see my last email|any thoughts)\b/i,
  /\b(calendly|book a call|quick call|15 minutes|fifteen minutes|zoom|demo|meeting|pricing|retainer|consultation|exclusiv\w*|scorecard|implementation|service package)\b/i,
  /\b(last chance|final opportunity|only one spot|closing soon|won't reach out again)\b/i,
  // Follow-ups never name the consumer app: API captures are "the OpenAI
  // model behind ChatGPT" in Touch 1 and unnamed here (terminology rule).
  /\bChatGPT\b/,
];
const PLACEHOLDER = /\{[^}]*\}|\bnull\b|\bundefined\b|\bNaN\b|\[object/;
const URL = /https?:\/\/|\bcal\.com\b|\bwww\.(?!RecommendedFirst\.com)/i;
const HTML = /<\/?[a-z][^>]*>|&[a-z]+;/i;
const EM_DASH = /—|―/;
const EN_DASH = /–|‒/;

function bodyBeforeSignature(body: string): string {
  const idx = body.indexOf(`\n${SEPARATOR}\n`);
  return idx >= 0 ? body.slice(0, idx) : body;
}

/** Deterministic copy gate scoped to the follow-up templates. */
export function lintFollowupCopy(subject: string | null, body: string): DraftQaIssue[] {
  const issues: DraftQaIssue[] = [];
  const text = `${subject ?? ""}\n${body}`;
  for (const re of BANNED_TERMS) {
    const m = text.match(re);
    if (m) issues.push({ check: "followup_copy", detail: `contains "${m[0]}".` });
  }
  if (EM_DASH.test(text)) issues.push({ check: "followup_copy", detail: "em dash (U+2014) in customer-facing copy." });
  if (EN_DASH.test(text)) issues.push({ check: "followup_copy", detail: "en dash (U+2013) in customer-facing copy." });
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
  const note = bodyBeforeSignature(body);
  const words = note.split(/\s+/).filter((w) => w.length > 0).length;
  if (words > FOLLOWUP_MAX_BODY_WORDS) {
    issues.push({ check: "followup_copy", detail: `${words} words before the signature (max ${FOLLOWUP_MAX_BODY_WORDS}).` });
  }
  if ((note.match(/\?/g) ?? []).length > 1) {
    issues.push({ check: "followup_copy", detail: "more than one ask." });
  }
  if (!/^\S[^\n]*,$/.test(note.split("\n")[0] ?? "")) {
    issues.push({ check: "followup_copy", detail: "first name greeting missing." });
  }
  return issues;
}

/** Facts the evidence QA needs beyond the snapshot; every field is derived
 * deterministically from frozen data or the current report state. */
export interface FollowupQaContext {
  entityType: ProspectEntityType | null;
  reportReady: boolean;
  distinctCompetitorQuestions: number;
  categoryLine: string | null;
}

/** Frozen-evidence check: the body must state the template's fragments, must
 * not state any competing figure, must use the right agent/team wording, may
 * claim N distinct questions only when N is the frozen count (≥ 3), may
 * claim a report only when one exists, and may carry only the one supported
 * category line. */
export function qaFollowupEvidence(
  version: FollowupTemplateVersion,
  body: string,
  s: MismatchEvidenceSnapshot,
  ctx: FollowupQaContext
): DraftQaIssue[] {
  const issues: DraftQaIssue[] = [];
  const push = (check: string, detail: string): void => { issues.push({ check, detail }); };
  if (!ctx.entityType) push("followup_entity", "prospect entity type (agent vs team) is unknown.");
  for (const fragment of followupFragments(version, s, ctx.entityType)) {
    if (!body.includes(fragment)) push("followup_evidence", `body no longer states "${fragment}".`);
  }
  const ofN = [...body.matchAll(/\b(\d+) of (\d+)\b/g)];
  for (const m of ofN) {
    if (Number(m[2]) !== s.answerCount) push("followup_evidence", `denominator ${m[2]} is not the frozen ${s.answerCount}.`);
    const c = Number(m[1]);
    if (c !== s.prospect.recommendationCount && c !== s.competitor.recommendationCount) {
      push("followup_evidence", `count ${c} is not a frozen count.`);
    }
  }
  const note = bodyBeforeSignature(body);
  if (ctx.entityType === "individual" && /\byour team\b/i.test(note)) {
    push("followup_entity", 'individual agent addressed as "your team".');
  }
  if (ctx.entityType === "team" && (/\bhas you\b/i.test(note) || /^You:/m.test(note))) {
    push("followup_entity", 'team addressed as "you".');
  }
  const claim = note.match(DISTINCT_QUESTIONS_CLAIM);
  if (claim) {
    const claimed = Number(claim[1]);
    if (claimed < FOLLOWUP_SEVERAL_QUESTIONS_MIN || claimed !== ctx.distinctCompetitorQuestions) {
      push("followup_claim", `claims ${claimed} distinct questions; frozen count is ${ctx.distinctCompetitorQuestions} (min ${FOLLOWUP_SEVERAL_QUESTIONS_MIN}).`);
    }
  }
  if (REPORT_CLAIM.test(note) && !ctx.reportReady) {
    push("followup_report", "claims a private report exists; none is finished for this prospect and evidence.");
  }
  const categoryLines = note.split("\n").filter((l) => l.startsWith(CATEGORY_LINE_PREFIX));
  if (categoryLines.length > 1) push("followup_claim", "more than one category line.");
  for (const l of categoryLines) {
    if (l !== ctx.categoryLine) push("followup_claim", `category line "${l}" is not supported by the frozen evidence.`);
  }
  return issues;
}
