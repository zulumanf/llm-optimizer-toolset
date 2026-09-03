/**
 * Deterministic reply classification (spec 124). Pure pattern rules over
 * the reply text — no LLM, no I/O — so the positive-reply KPI is computed
 * the same way forever and a misfire is a reviewable diff, not a model
 * mood. Order matters: compliance signals (unsubscribe) beat everything,
 * autoresponders beat sentiment, explicit rejection beats interest, and
 * interest beats the generic question bucket. An operator can override at
 * record time; the override is stored, the classifier version alongside.
 */
import type { ReplyClassification } from "@/lib/prospects/constants";

export const REPLY_CLASSIFIER_VERSION = "reply-classifier-v1+deterministic";

interface Rule {
  classification: ReplyClassification;
  patterns: RegExp[];
}

/** First matching rule wins. Patterns match case-insensitively against the
 * whitespace-normalized reply text. */
const RULES: Rule[] = [
  {
    classification: "unsubscribe",
    patterns: [
      /\bunsubscribe\b/i,
      /\bopt\s*(me\s*)?out\b/i,
      /\b(remove|take)\s+me\s+(from|off)\b/i,
      /\bstop\s+(emailing|contacting)\b/i,
      /\bdo\s+not\s+(email|contact)\s+me\b/i,
    ],
  },
  {
    classification: "out_of_office",
    patterns: [
      /\bout\s+of\s+(the\s+)?office\b/i,
      /\bon\s+(vacation|leave|pto)\b/i,
      /\bauto[- ]?(reply|response|matic reply)\b/i,
      /\baway\s+from\s+(my\s+)?(email|desk)\b/i,
      /\blimited\s+access\s+to\s+email\b/i,
    ],
  },
  {
    classification: "not_interested",
    patterns: [
      /\bnot?\s+interested\b/i,
      /\bno\s+thank(s| you)\b/i,
      /\bplease\s+don'?t\b/i,
      /\bwe'?re\s+(all\s+set|good|not\s+looking)\b/i,
      /\bpass\b/i,
    ],
  },
  {
    classification: "referral",
    patterns: [
      /\b(reach\s+out|talk|speak)\s+to\s+(my|our)\b/i,
      /\bforward(ed|ing)?\s+(this|your\s+email)\s+to\b/i,
      /\b(right|wrong)\s+person\b.*\b(is|would\s+be|try)\b/i,
      /\bhandles?\s+(this|our\s+marketing)\b/i,
    ],
  },
  {
    classification: "proof_request",
    patterns: [
      /\bhow\s+did\s+you\s+(get|find|measure|run|test)\b/i,
      /\bwhere\s+(did|does)\s+(this|that|the\s+data)\s+come\s+from\b/i,
      /\b(prove|proof|verify|legit(imate)?)\b/i,
      /\bis\s+this\s+real\b/i,
    ],
  },
  {
    classification: "positive_interest",
    patterns: [
      /^(yes|yep|yeah|sure|ok(ay)?|please|interested|absolutely|definitely)\b/i,
      /\bsend\s+(it|them|that|those|the\s+(comparison|questions|side[- ]by[- ]side|benchmark|report))(\s+over)?\b/i,
      /\bwhat\s+did\s+you\s+find\b/i,
      /\b(let'?s|love\s+to|like\s+to|want\s+to)\s+see\s+(it|them|that)\b/i,
      /\b(i'?m|we'?re|i\s+am|sounds?)\s+(interested|intrigued|curious)\b/i,
      /\bshow\s+me\b/i,
      /\btell\s+me\s+more\b/i,
      /\bsend\s+(me\s+)?(over\s+)?(the|more)\b/i,
    ],
  },
  {
    classification: "objection",
    patterns: [
      /\b(that'?s|this\s+is|seems?|looks?)\s+(not\s+(right|accurate|correct)|wrong|off|inaccurate|misleading)\b/i,
      /\bdisagree\b/i,
      /\bwe\s+already\s+(have|work\s+with|use|do)\b/i,
      /\bdon'?t\s+(believe|buy|think\s+that'?s)\b/i,
    ],
  },
  {
    classification: "question",
    patterns: [/\?/],
  },
];

/** Drop quoted history and signature-less trailers so the classifier sees
 * only what the human typed: everything from an "On … wrote:" line, any
 * "> " quoted lines, and anything after a "--" / "From:" boundary. Our own
 * footer ("reply \"unsubscribe\"") must never classify the reply. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^on .{3,120} wrote:$/i.test(t) || /^-{2,}\s*(original|forwarded) message/i.test(t) || /^from:\s/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  const body = out.join("\n").trim();
  return body.length > 0 ? body : text.trim();
}

export function classifyReplyText(text: string): ReplyClassification {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "unclear";
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(normalized))) return rule.classification;
  }
  return "unclear";
}

/** Classifications that record a real human conversation — they advance the
 * prospect to `replied`. Autoresponders and unsubscribes do not. */
export const CONVERSATION_CLASSIFICATIONS: readonly ReplyClassification[] = [
  "positive_interest",
  "question",
  "objection",
  "proof_request",
  "referral",
  "not_interested",
  "unclear",
];
