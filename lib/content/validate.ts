/**
 * Deterministic content gates (spec 010) — the hard checks that run no
 * matter what any agent says (same philosophy as the report evidence gate):
 * 1. Citation gate: every sentence naming the subject must cite an approved
 *    claim id; every citation must resolve.
 * 2. Number gate: no digits outside cited sentences (no invented stats).
 * 3. Compliance v1 (generic pack): superiority language about the subject
 *    requires a citation.
 */

const CLAIM_RE = /\[claim:([0-9a-f-]{36})\]/g;
const CLAIM_TEST = /\[claim:[0-9a-f-]{36}\]/;

const SUPERLATIVES =
  /\b(best|#1|number one|leading|top[- ]rated|guaranteed|unmatched|greatest)\b/i;

export interface ContentValidation {
  ok: boolean;
  uncitedSubjectSentences: string[];
  unresolvedCitations: string[];
  uncitedNumericSentences: string[];
  uncitedSuperlatives: string[];
}

function sentences(text: string): string[] {
  const raw = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^#{1,6}\s/.test(s) && !/^[-|*\d.)\s]+$/.test(s));
  // Models often place the citation AFTER the sentence period ("…agents.
  // [claim:id]") — a trailing all-citation segment belongs to the sentence
  // before it, not to a sentence of its own
  const merged: string[] = [];
  for (const segment of raw) {
    if (/^(\[claim:[0-9a-f-]{36}\]\s*)+$/.test(segment) && merged.length > 0) {
      merged[merged.length - 1] += ` ${segment}`;
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function mentionsSubject(sentence: string, terms: string[]): boolean {
  return terms.some((term) =>
    new RegExp(`(?<![\\w.])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)(?!\\.\\w)`, "i").test(
      sentence
    )
  );
}

export function validateContent(
  markdown: string,
  subjectTerms: string[],
  approvedClaimIds: Set<string>
): ContentValidation {
  const uncitedSubjectSentences: string[] = [];
  const unresolvedCitations: string[] = [];
  const uncitedNumericSentences: string[] = [];
  const uncitedSuperlatives: string[] = [];

  for (const match of markdown.matchAll(CLAIM_RE)) {
    if (!approvedClaimIds.has(match[1] as string)) {
      unresolvedCitations.push(match[0]);
    }
  }

  for (const sentence of sentences(markdown)) {
    const cited = CLAIM_TEST.test(sentence);
    const aboutSubject = mentionsSubject(sentence, subjectTerms);
    const stripped = sentence.replace(CLAIM_RE, "");

    if (aboutSubject && !cited) {
      // Headings that just name the subject are structure, not claims —
      // sentence splitter already drops markdown headings
      uncitedSubjectSentences.push(sentence.slice(0, 200));
    }
    if (/\d/.test(stripped) && !cited) {
      uncitedNumericSentences.push(sentence.slice(0, 200));
    }
    if (aboutSubject && SUPERLATIVES.test(sentence) && !cited) {
      uncitedSuperlatives.push(sentence.slice(0, 200));
    }
  }

  return {
    ok:
      uncitedSubjectSentences.length === 0 &&
      unresolvedCitations.length === 0 &&
      uncitedNumericSentences.length === 0 &&
      uncitedSuperlatives.length === 0,
    uncitedSubjectSentences,
    unresolvedCitations,
    uncitedNumericSentences,
    uncitedSuperlatives,
  };
}

/** Strip citation tokens for the publish package (readers never see them). */
export function renderPublishable(markdown: string): string {
  return markdown.replace(CLAIM_RE, "").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
}
