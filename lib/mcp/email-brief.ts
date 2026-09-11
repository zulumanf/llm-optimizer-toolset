/**
 * Email-brief composition for the remote MCP tool `get_email_brief`
 * (spec 126). Pure — the only payload an external drafting agent (Grok's
 * Email Drafter) may trust. Every number comes from the caller-supplied
 * capture facts; when there is no capture, the brief refuses measurement
 * claims outright (`allowed_to_claim_measurement: false`) and hands back a
 * first line that asserts nothing about the team. Copy follows the
 * prospect-voice skill: counted moments, no fabricated losses — the unit
 * tests hold every generated line to `findProhibitedPhrase`.
 */

export interface EmailBriefCapture {
  validAnswers: number;
  mentionedCount: number;
  recommendedCount: number;
  /** Recommended competitors (prospect excluded), best first. */
  competitorsNamed: string[];
  /** Most-cited domain in the capture, if any. */
  topDomain: { domain: string; citations: number } | null;
  /** Citations of the team's own site domain (0 when unknown/absent). */
  teamDomainCitations: number;
  /** The team's website domain, when the record has one. */
  teamWebsiteDomain: string | null;
}

export interface EmailBriefInput {
  teamName: string;
  marketName: string;
  capture: EmailBriefCapture | null;
}

export interface EmailBrief {
  allowed_to_claim_measurement: boolean;
  team_name: string;
  market_name: string;
  appeared: boolean;
  recommended: boolean;
  recommended_count: number;
  valid_answers: number;
  competitors_named: string[];
  one_source_gap: string | null;
  allowed_first_line: string;
  do_not_say: string[];
}

const MAX_COMPETITORS = 3;

const ALWAYS_FORBIDDEN = [
  "guarantees of rankings or of being recommended by AI assistants",
  "lost, missed, or at-risk revenue, deals, or commissions (prohibited-phrases gate)",
  "any count, percentage, or provider not present in this brief",
];

export function buildEmailBrief(input: EmailBriefInput): EmailBrief {
  const { teamName, marketName, capture } = input;
  if (!capture || capture.validAnswers <= 0) {
    return {
      allowed_to_claim_measurement: false,
      team_name: teamName,
      market_name: marketName,
      appeared: false,
      recommended: false,
      recommended_count: 0,
      valid_answers: 0,
      competitors_named: [],
      one_source_gap: null,
      // No measurement exists, so the line may not claim one — and above
      // all may not claim the team was missing from anything.
      allowed_first_line: `Buyers and sellers in ${marketName} increasingly ask AI assistants who to hire before they ever search — we run counted benchmarks of who those assistants recommend.`,
      do_not_say: [
        ...ALWAYS_FORBIDDEN,
        `any claim that we measured or tested ${teamName}'s AI visibility`,
        `that ${teamName} was missing from ChatGPT or any assistant`,
      ],
    };
  }

  const appeared = capture.mentionedCount > 0;
  const recommended = capture.recommendedCount > 0;
  const n = capture.validAnswers;
  let firstLine: string;
  if (recommended) {
    firstLine = `Across ${n} AI answers we captured about ${marketName}, ${teamName} was recommended in ${capture.recommendedCount}.`;
  } else if (appeared) {
    firstLine = `Across ${n} AI answers we captured about ${marketName}, ${teamName} was mentioned in ${capture.mentionedCount} but was not among the recommended teams in any of them.`;
  } else {
    firstLine = `Across ${n} AI answers we captured about ${marketName}, ${teamName} did not appear.`;
  }

  let oneSourceGap: string | null = null;
  const top = capture.topDomain;
  if (
    top &&
    (!capture.teamWebsiteDomain || top.domain !== capture.teamWebsiteDomain) &&
    top.citations > capture.teamDomainCitations
  ) {
    oneSourceGap = `AI answers cited ${top.domain} ${top.citations} times vs the team's own site ${capture.teamDomainCitations} times.`;
  }

  return {
    allowed_to_claim_measurement: true,
    team_name: teamName,
    market_name: marketName,
    appeared,
    recommended,
    recommended_count: capture.recommendedCount,
    valid_answers: n,
    competitors_named: capture.competitorsNamed.slice(0, MAX_COMPETITORS),
    one_source_gap: oneSourceGap,
    allowed_first_line: firstLine,
    do_not_say: ALWAYS_FORBIDDEN,
  };
}
