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
    // Post-offer rejection: the person weighed a price or scope and said no.
    // Sits before not_interested so "pass" inside a priced decline keeps
    // its objection flags (Ryan Ogle, 2026-09-07).
    classification: "decline",
    patterns: [
      /\b(price|cost|fee|number|that)\s+is\s+(higher|more)\s+than\s+(i|we)\b/i,
      /\btoo\s+(expensive|pricey|steep|much)\b/i,
      /\bnot\s+(in|within)\s+(the|our|my)\s+budget\b/i,
      /\bcan'?t\s+(justify|afford|swing)\b/i,
      /\b(going|decided)\s+to\s+(pass|hold\s+off)\b/i,
      /\bnot\s+going\s+to\s+move\s+forward\b/i,
      /\b(handle|do|work\s+on|improve|focus\s+on)\s+(this|it|that|our\s+\w+)\s+(ourselves|internally|in[- ]house|organically)\b/i,
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

/** Marker the connector layer substitutes for unreadable content. A body
 * that is (or contains) it cannot be classified — it stays "unclear". */
const REDACTED_MARKER = /\[redacted[^\]]*\]/i;
/** Our own outreach footer, as it comes back quoted in a reply. */
const OWN_FOOTER = /rather not hear from us|reply "unsubscribe"|^Francisco( Zuluaga)? [·-] Recommended First$/i;

/** Drop quoted history and trailers so the classifier sees only what the
 * human typed: everything from an "On … wrote:" line, any "> " quoted line,
 * and anything after a "--" / "—" / "From:" boundary or our own footer.
 * Returns "" when nothing human-typed remains (an all-quoted or redacted
 * body) — callers then record an "unclear" reply that stops the sequence
 * for review and never suppresses. Our footer's "unsubscribe" must never
 * classify the reply (2026-09-03 misfire). */
export function stripQuotedReply(text: string): string {
  if (REDACTED_MARKER.test(text)) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (
      /^on .{3,120} wrote:$/i.test(t) ||
      /^-{2,}\s*(original|forwarded) message/i.test(t) ||
      /^from:\s/i.test(t) ||
      /^(--|—)$/.test(t) ||
      OWN_FOOTER.test(t)
    ) {
      break;
    }
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function classifyReplyText(text: string): ReplyClassification {
  // Quoted history and our own footer never classify the reply, whichever
  // path recorded it (Gmail sync or a hand-recorded paste).
  const normalized = stripQuotedReply(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "unclear";
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(normalized))) return rule.classification;
  }
  return "unclear";
}

/** Objection flags read off a reply, using the pricing policy's vocabulary.
 * Flags are evidence for the founder, never a routing decision. */
export const REPLY_OBJECTION_FLAGS = ["PRICE_TOO_HIGH", "PREFERS_DIY", "NOT_PRIORITY", "TIMING", "BUDGET_UNAVAILABLE", "PROOF_INSUFFICIENT"] as const;
export type ReplyObjectionFlag = (typeof REPLY_OBJECTION_FLAGS)[number];
const OBJECTION_RULES: { flag: ReplyObjectionFlag; patterns: RegExp[] }[] = [
  { flag: "PRICE_TOO_HIGH", patterns: [/\b(higher|more)\s+than\s+(i|we)\b.*\b(spend|pay|invest)/i, /\btoo\s+(expensive|pricey|steep|much)\b/i, /\bcan'?t\s+(justify|afford)\b/i, /\bprice\b.*\b(high|much)\b/i] },
  { flag: "PREFERS_DIY", patterns: [/\b(ourselves|in[- ]house|internally|organically|on\s+(my|our)\s+own)\b/i, /\blearn\s+more\s+about\s+the\s+subject\b/i] },
  { flag: "BUDGET_UNAVAILABLE", patterns: [/\bnot\s+(in|within)\s+(the|our|my)\s+budget\b/i, /\bno\s+budget\b/i] },
  { flag: "TIMING", patterns: [/\b(not\s+(right\s+)?now|later\s+this\s+year|next\s+(quarter|year)|revisit|circle\s+back)\b/i] },
  { flag: "NOT_PRIORITY", patterns: [/\bnot\s+a\s+priority\b/i, /\bother\s+priorities\b/i] },
  { flag: "PROOF_INSUFFICIENT", patterns: [/\b(prove|proof|show\s+me\s+results|case\s+stud(y|ies)|references)\b/i] },
];
export function replyObjections(text: string): ReplyObjectionFlag[] {
  const t = stripQuotedReply(text).replace(/\s+/g, " ").trim();
  if (!t) return [];
  return OBJECTION_RULES.filter((r) => r.patterns.some((p) => p.test(t))).map((r) => r.flag);
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
  "decline",
  "unclear",
];
