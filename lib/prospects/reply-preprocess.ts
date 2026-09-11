/**
 * Reply preprocessing + autonomy classification (spec 137). Pure, no I/O.
 *
 * Before the lane decides anything about a reply it reduces the message to
 * what the human typed: quoted history, our own footer, known signature
 * blocks and legal trailers are removed; autoresponders are flagged; the
 * raw body is never modified (callers keep it separately). The autonomy
 * class is then a narrow allowlist over that human text — a reply is
 * `autonomy_eligible` only when it is a short, unambiguous "send it" with
 * no commercial, legal, corrective or questioning language. Everything
 * else escalates with a deterministic reason. Precision over coverage.
 */
import { classifyReplyText, stripQuotedReply } from "@/lib/prospects/reply-classify";
import type { ReplyClassification } from "@/lib/prospects/constants";

export const AUTONOMY_CLASSIFIER_VERSION = "autonomy-class-v1";

export const AUTONOMY_CLASSES = ["autonomy_eligible", "escalate"] as const;
export type AutonomyClass = (typeof AUTONOMY_CLASSES)[number];

export interface PreprocessedReply {
  /** What the human typed, after quoted history / signature / legal removal. */
  human: string;
  /** The message reads as an autoresponder (OOO, vacation, auto-reply). */
  autoresponder: boolean;
  /** True when a trailer was removed (signature or legal block). */
  strippedTrailer: boolean;
}

/** Signature openers: the line and everything after it are a trailer. */
const SIGNATURE_LINE = [
  /^(best|thanks|thank you|regards|kind regards|warm regards|cheers|sincerely|talk soon|all the best)[,!.]?\s*$/i,
  /^sent from my (iphone|ipad|android|galaxy|mobile|phone)/i,
  /^get outlook for (ios|android)/i,
  /^(cell|mobile|office|direct|phone|tel)[:.]?\s*[\d(]/i,
  /^(realtor|broker|team lead|team leader|owner|principal|associate broker|sales associate)[®™]?\s*[|·,-]?\s*/i,
  /^www\.[a-z0-9-]+\.[a-z]{2,}/i,
  /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i,
];
/** Legal / confidentiality trailers. */
const LEGAL_LINE = [
  /^(confidential(ity)?( notice)?|disclaimer|notice)\s*[:.-]/i,
  /this (e-?mail|message|communication)( and any attachments)? (is|are|may be|contains)/i,
  /intended (only|solely) for the (use of the )?(addressee|recipient|individual)/i,
  /if you (are not the intended recipient|have received this (e-?mail|message) in error)/i,
  /wire fraud (is|advisory|alert)/i,
  /equal housing opportunity/i,
];
const AUTORESPONDER = [
  /\bout\s+of\s+(the\s+)?office\b/i,
  /\bon\s+(vacation|leave|pto)\b/i,
  /\bauto(matic)?[- ]?(reply|response)\b/i,
  /\baway\s+from\s+(my\s+)?(email|desk|the office)\b/i,
  /\blimited\s+access\s+to\s+email\b/i,
  /\bwill\s+(respond|reply|return)\s+(when|on|after)\b/i,
];

/** Reduce a reply body to the human-typed text. Quoted history is removed
 * by the classifier's own splitter (one implementation); signatures and
 * legal trailers are cut at their first line. */
export function preprocessReply(raw: string): PreprocessedReply {
  const unquoted = stripQuotedReply(raw);
  const lines = unquoted.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let strippedTrailer = false;
  for (const line of lines) {
    const t = line.trim();
    if (kept.length > 0 && (SIGNATURE_LINE.some((p) => p.test(t)) || LEGAL_LINE.some((p) => p.test(t)))) {
      strippedTrailer = true;
      break;
    }
    if (kept.length === 0 && LEGAL_LINE.some((p) => p.test(t))) {
      strippedTrailer = true;
      break;
    }
    kept.push(line);
  }
  // A closing on the same line as the yes ("Yes please. Thanks, Ryan").
  let human = kept.join("\n").trim();
  human = human.replace(/[.!,]?\s*(thanks|thank you|best|regards|cheers)[,!.]?\s+[A-Z][a-z]+\.?\s*$/i, "").trim();
  const autoresponder = AUTORESPONDER.some((p) => p.test(unquoted)) || AUTORESPONDER.some((p) => p.test(raw.slice(0, 400)));
  return { human, autoresponder, strippedTrailer };
}

/** Exclusion vocabulary: any hit escalates regardless of sentiment. Named
 * groups give the founder the reason without reading the message. */
const EXCLUSIONS: { reason: string; patterns: RegExp[] }[] = [
  { reason: "pricing or cost language", patterns: [/\b(price|prices|pricing|cost|costs|how much|discount|fee|fees|rate|rates|budget|invoice|charge)\b/i] },
  { reason: "contract, guarantee or legal language", patterns: [/\b(contract|guarantee|guaranteed|promise|legal|liability|terms|agreement|refund)\b/i] },
  { reason: "scope or custom-work request", patterns: [/\b(scope|custom|customize|customise|bespoke|specific(ally)? for|what would you (actually )?(change|do))\b/i] },
  { reason: "methodology challenge or correction", patterns: [/\b(methodology|method|how did you|where did|wrong|incorrect|inaccurate|mistake|correction|not (right|accurate)|actually we|we are not|that's not)\b/i] },
  { reason: "complaint or negative sentiment", patterns: [/\b(complaint|spam|stop|annoy|harass|unsolicited|not interested|no thanks|remove me)\b/i, /\bunsubscribe\b/i] },
  { reason: "question in the reply", patterns: [/\?/] },
  { reason: "hedged or conditional intent", patterns: [/\b(maybe|perhaps|possibly|might|depends|not sure|if|but|however|although|unless|before)\b/i] },
  { reason: "implementation question", patterns: [/\b(implement|integration|integrate|api|website|seo|how (does|do|would) (it|this|that) work)\b/i] },
];

/** The allowlist. Whole-message match after greeting/name/closing removal. */
const SIMPLE_POSITIVE = [
  /^(yes|yep|yeah|yup|sure|ok|okay|absolutely|definitely|certainly|please|of course|sounds good|great|perfect|interested)(\s*(please|thanks|thank you|do|go ahead|send it( over)?|send them|do it|let'?s see it|show me))*$/i,
  /^(please\s+)?(send|share|shoot|forward)\s+(it|them|that|those|the (report|comparison|questions|side[- ]by[- ]side|results))(\s+(over|through|along|my way|to me))?(\s+please)?$/i,
  /^(show|send)\s+me(\s+(the\s+)?(report|questions|comparison|results|side[- ]by[- ]side))?$/i,
  /^(i'?d|i would|we'?d|we would)\s+(like|love|be (happy|glad|curious))\s+to\s+(see|take a look at|look at|read)\s+(it|them|that|those|the (report|comparison|questions|results))$/i,
  /^(let'?s|i'?d like to|i want to|i'?m curious to)\s+(see|take a look at)\s+(it|them|that|those|the (report|comparison|questions|results))$/i,
  /^(go ahead|go for it|do it|send away|fire away)$/i,
  /^please send( it| them)?( over)?$/i,
  /^(i'?m|we'?re|i am|we are)\s+(interested|in)$/i,
];
const MAX_HUMAN_CHARS = 160;

export interface AutonomyClassification {
  autonomyClass: AutonomyClass;
  classification: ReplyClassification;
  reason: string;
  version: string;
}

/** Strip a leading greeting/name and trailing pleasantries so the allowlist
 * sees the intent alone: "Hi Francisco — yes, send it. Thanks!" → "yes send it". */
function intentCore(human: string): string {
  return human
    .replace(/\s+/g, " ")
    .replace(/^(hi|hey|hello|good (morning|afternoon|evening))[,!.]?\s*(francisco|there)?[,!.\-—–:]?\s*/i, "")
    .replace(/^francisco[,!.\-—–:]?\s*/i, "")
    .replace(/[,!.\-—–:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classify a reply for the autonomous lane. The deterministic reply
 * classifier decides positivity; this decides whether the positive reply
 * is narrow enough to fulfil without a human. */
export function classifyForAutonomy(raw: string): AutonomyClassification {
  const version = AUTONOMY_CLASSIFIER_VERSION;
  const pre = preprocessReply(raw);
  const classification = classifyReplyText(raw);
  const esc = (reason: string): AutonomyClassification => ({ autonomyClass: "escalate", classification, reason, version });
  if (pre.autoresponder || classification === "out_of_office") return esc("autoresponder");
  if (classification !== "positive_interest") return esc(`reply class ${classification}`);
  if (!pre.human) return esc("no human-typed text");
  if (pre.human.length > MAX_HUMAN_CHARS) return esc("reply longer than a simple yes");
  for (const group of EXCLUSIONS) {
    if (group.patterns.some((p) => p.test(pre.human))) return esc(group.reason);
  }
  const core = intentCore(pre.human);
  if (!SIMPLE_POSITIVE.some((p) => p.test(core))) return esc("positive but not a plain send-it form");
  return { autonomyClass: "autonomy_eligible", classification, reason: "plain positive reply with no commercial, legal, corrective or questioning language", version };
}
