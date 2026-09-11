/**
 * Deterministic outreach engagement state (spec 127). Pure: facts in,
 * verdict out. Opens are noisy (Apple MPP, Gmail proxies, security
 * scanners, prefetch), so a single open never counts; a reply, stop or
 * pause always wins over any open.
 */
import type { ReplyClassification } from "@/lib/prospects/constants";
import {
  FOLLOWUP_MEANINGFUL_OPEN_GAP_MINUTES,
  MAIL_SCANNER_WINDOW_SECONDS as SCANNER_WINDOW_SECONDS,
} from "@/lib/prospects/constants";

export const ENGAGEMENT_STATES = [
  "REPLIED",
  "STOPPED",
  "OOO_PAUSED",
  "MEANINGFUL_ENGAGEMENT",
  "NO_MEANINGFUL_ENGAGEMENT",
] as const;
export type EngagementState = (typeof ENGAGEMENT_STATES)[number];

export interface SendFact {
  id: string;
  sentAt: Date;
}
export interface OpenFact {
  sendId: string;
  openedAt: Date;
  userAgent: string | null;
}
export interface ReplyFact {
  classification: ReplyClassification;
  receivedAt: Date;
}
export interface EngagementFacts {
  sends: SendFact[];
  opens: OpenFact[];
  /** `summarizeEngagement(...).meaningfullyEngaged` on attributed audit views. */
  auditMeaningfullyEngaged: boolean;
  replies: ReplyFact[];
  stopReason: string | null;
  pausedUntil: Date | null;
  now: Date;
}
export interface EngagementVerdict {
  state: EngagementState;
  credibleOpens: number;
  discountedOpens: number;
  reason: string;
}

export type OpenSignalClass = "scanner" | "credible";

/** A bare `Mozilla/5.0` or missing user agent is a security gateway or link
 * checker; anything inside the mail-scanner window after the send is a
 * scan regardless of client (proxies prefetch within seconds). */
export function classifyOpen(open: OpenFact, sentAt: Date): OpenSignalClass {
  const ua = (open.userAgent ?? "").trim();
  if (ua === "" || ua === "Mozilla/5.0") return "scanner";
  if (open.openedAt.getTime() - sentAt.getTime() < SCANNER_WINDOW_SECONDS * 1000) return "scanner";
  return "credible";
}

export function evaluateEngagement(f: EngagementFacts): EngagementVerdict {
  const firstSentAt = f.sends.reduce<Date | null>(
    (min, s) => (min === null || s.sentAt < min ? s.sentAt : min),
    null
  );
  const sentAtById = new Map(f.sends.map((s) => [s.id, s.sentAt]));
  let credible: Date[] = [];
  let discounted = 0;
  for (const o of f.opens) {
    const sentAt = sentAtById.get(o.sendId);
    if (!sentAt) continue;
    if (classifyOpen(o, sentAt) === "credible") credible.push(o.openedAt);
    else discounted += 1;
  }
  credible = credible.sort((a, b) => a.getTime() - b.getTime());
  const base = { credibleOpens: credible.length, discountedOpens: discounted };

  const humanReplies = f.replies.filter(
    (r) => r.classification !== "out_of_office" && (!firstSentAt || r.receivedAt >= firstSentAt)
  );
  if (humanReplies.length > 0) {
    return { state: "REPLIED", ...base, reason: `${humanReplies.length} human reply on record` };
  }
  if (f.stopReason) return { state: "STOPPED", ...base, reason: f.stopReason };
  if (f.pausedUntil && f.pausedUntil.getTime() > f.now.getTime()) {
    return { state: "OOO_PAUSED", ...base, reason: `paused until ${f.pausedUntil.toISOString()}` };
  }
  const gapMs = FOLLOWUP_MEANINGFUL_OPEN_GAP_MINUTES * 60_000;
  const spaced = credible.some((t, i) => i > 0 && t.getTime() - credible[0]!.getTime() >= gapMs);
  if (credible.length >= 2 && spaced) {
    return {
      state: "MEANINGFUL_ENGAGEMENT", ...base,
      reason: `${credible.length} credible opens at least ${FOLLOWUP_MEANINGFUL_OPEN_GAP_MINUTES} min apart`,
    };
  }
  if (credible.length >= 1 && f.auditMeaningfullyEngaged) {
    return {
      state: "MEANINGFUL_ENGAGEMENT", ...base,
      reason: "one credible open plus a meaningful attributed audit view",
    };
  }
  return {
    state: "NO_MEANINGFUL_ENGAGEMENT", ...base,
    reason:
      credible.length === 0
        ? discounted > 0 ? "opens were scanner/proxy only" : "no opens"
        : "a single open is ambiguous",
  };
}
