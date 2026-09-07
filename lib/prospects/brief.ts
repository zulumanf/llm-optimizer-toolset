/**
 * Executive brief (spec 121). One deterministic synthesis of the cockpit's
 * already-derived facts: a headline, the top three actions, and grouped
 * observations — every claim carrying its evidence numbers. Pure function,
 * no I/O, no LLM; versioned like every other interpretation (diagnose,
 * score-feedback). Sample-size judgment is NOT re-implemented here: the
 * bottleneck/early-sample gate is the cohort's own `diagnosis`, so the brief
 * can never disagree with the funnel section below it.
 */
import type { CohortSummary } from "@/lib/prospects/intent";
import type { DashboardFilters } from "@/lib/prospects/dashboard-url";

export const BRIEF_VERSION = "prospecting-brief-v1";
export const BRIEF_MAX_ACTIONS = 3;

export interface BriefFacts {
  cohortName: string;
  /** All prospects in the cohort, contacted or not. */
  prospectCount: number;
  cohort: CohortSummary;
  repliesWaiting: number;
  meetingsToPrepare: number;
  approvals: number;
  blockedSends: number;
  scheduledPending: number;
  followUpsEligible24h: number;
  unresolvedAttribution: number;
  expiringAudits: number;
  researchQueue: number;
  gmailHealthy: boolean;
  gmailStatus: string | null;
  capUsed24h: number;
  capLimit: number;
  sentToday: number;
  quota: number;
  quotaStreak: number;
  /** Contacted, one touch, no reply, follow-up already due (spec 119). */
  stalledAtOne: number;
  /** Operator-timezone business day — quota pressure pauses on weekends. */
  businessDay: boolean;
}

export type BriefTarget =
  | { kind: "filter"; patch: Partial<DashboardFilters> }
  | { kind: "none" };

export interface BriefAction {
  text: string;
  evidence: string;
  target: BriefTarget;
}

export interface BriefObservation {
  tone: "good" | "watch" | "bad";
  text: string;
  evidence: string;
}

export interface ExecutiveBrief {
  version: string;
  headline: string;
  actions: BriefAction[];
  observations: BriefObservation[];
  epilogue: string | null;
}

const n = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

const pct = (num: number, of: number): string => `${Math.round((num / of) * 100)}%`;

export function executiveBrief(f: BriefFacts): ExecutiveBrief {
  if (f.prospectCount === 0) {
    return {
      version: BRIEF_VERSION,
      headline: "No prospects in this cohort yet — import or discover to begin.",
      actions: [],
      observations: [],
      epilogue: null,
    };
  }

  const c = f.cohort;
  const d = c.diagnosis;
  const quotaGap = Math.max(0, f.quota - f.sentToday);
  const conversations = f.repliesWaiting + f.meetingsToPrepare;
  const bottleneck = d.verdict === "possible_bottleneck";

  // ------------------------------------------------------------- headline
  let headline: string;
  if (!f.gmailHealthy) {
    headline = `Outbound is blocked — Gmail connection is ${(f.gmailStatus ?? "not connected").replaceAll("_", " ")}. Nothing sends until it is reconnected.`;
  } else if (conversations > 0) {
    const parts = [
      f.repliesWaiting > 0 ? `${n(f.repliesWaiting, "reply", "replies")} to answer` : null,
      f.meetingsToPrepare > 0 ? `${n(f.meetingsToPrepare, "meeting")} to prepare` : null,
    ].filter(Boolean);
    headline = `${parts.join(" and ")} — conversations before volume.`;
  } else if (f.businessDay && quotaGap > 0) {
    headline = `${n(quotaGap, "send")} short of today's quota (${f.sentToday}/${f.quota}) — volume is the lever right now.`;
  } else if (f.followUpsEligible24h + f.stalledAtOne > 0) {
    headline = `Follow-up debt is the constraint — ${n(f.followUpsEligible24h, "follow-up")} eligible within 24h, ${f.stalledAtOne} stalled at one touch.`;
  } else if (bottleneck) {
    headline = `Possible bottleneck: ${d.bottleneck?.replaceAll("_", " ")} — ${d.reason}`;
  } else if (d.verdict === "healthy") {
    headline = "On track — no funnel step is under-converting. Keep the inputs up.";
  } else {
    headline = "Inputs are on track; the sample is still too small to judge the funnel.";
  }

  // -------------------------------------------------------------- actions
  const candidates: (BriefAction | null)[] = [
    !f.gmailHealthy
      ? {
          text: "Reconnect Gmail from the operator machine: npx tsx scripts/connect-gmail.ts.",
          evidence: `connection ${(f.gmailStatus ?? "not connected").replaceAll("_", " ")} · ${n(f.scheduledPending, "scheduled send")} waiting`,
          target: { kind: "none" },
        }
      : null,
    f.repliesWaiting > 0
      ? {
          text: `Answer ${n(f.repliesWaiting, "reply", "replies")} — the fastest path to meetings.`,
          evidence: `${f.repliesWaiting} replied with no meeting recorded yet`,
          target: { kind: "filter", patch: { sales: "replied" } },
        }
      : null,
    f.meetingsToPrepare > 0
      ? {
          text: `Prepare ${n(f.meetingsToPrepare, "meeting")}.`,
          evidence: "recorded stage ≥ discovery scheduled, not yet won or lost",
          target: { kind: "filter", patch: { sales: "meeting" } },
        }
      : null,
    f.approvals > 0
      ? {
          text: `Approve ${n(f.approvals, "waiting draft")} so the worker can send.`,
          evidence: `${f.approvals} awaiting approval`,
          target: { kind: "none" },
        }
      : null,
    f.gmailHealthy && f.businessDay && quotaGap > 0
      ? {
          text: `Send ${n(quotaGap, "more email")} today${f.quotaStreak > 0 ? ` to keep the ${f.quotaStreak}-business-day streak` : ""}.`,
          evidence: `${f.sentToday}/${f.quota} sent today`,
          target: { kind: "filter", patch: { outreach: "not" } },
        }
      : null,
    f.followUpsEligible24h > 0
      ? {
          text: `Draft ${n(f.followUpsEligible24h, "follow-up")} becoming eligible in the next 24 hours.`,
          evidence: "cadence-eligible with no draft on file",
          target: { kind: "filter", patch: { outreach: "due" } },
        }
      : null,
    f.unresolvedAttribution > 0
      ? {
          text: `Resolve ${n(f.unresolvedAttribution, "attribution issue")} so campaign metrics stay honest.`,
          evidence: "audit activity with no recorded outbound send",
          target: { kind: "none" },
        }
      : null,
    bottleneck
      ? {
          text: `Work the ${d.bottleneck?.replaceAll("_", " ")} bottleneck — review ${d.review.join(", ")}.`,
          evidence: d.reason,
          target: { kind: "none" },
        }
      : null,
    f.researchQueue > 0
      ? {
          text: `Research contacts for ${n(f.researchQueue, "published audit")}.`,
          evidence: "published audit with no sendable contact",
          target: { kind: "none" },
        }
      : null,
  ];
  const actions = candidates.filter((a): a is BriefAction => a !== null).slice(0, BRIEF_MAX_ACTIONS);

  // --------------------------------------------------------- observations
  const observations: BriefObservation[] = [];
  if (f.quotaStreak > 0) {
    observations.push({
      tone: "good",
      text: `Quota streak at ${n(f.quotaStreak, "business day")}.`,
      evidence: `${f.sentToday}/${f.quota} sent today`,
    });
  }
  if (c.contacted > 0 && c.viewed > 0) {
    observations.push({
      tone: "good",
      text: `${pct(c.viewed, c.contacted)} of contacted prospects viewed their audit.`,
      evidence: `${c.viewed}/${c.contacted}`,
    });
  }
  if (c.replied > 0) {
    observations.push({
      tone: "good",
      text: `${n(c.replied, "reply", "replies")} and ${n(c.meeting, "meeting")} from ${n(c.contacted, "contacted prospect")}.`,
      evidence: "recorded stage changes",
    });
  }
  if (d.verdict === "healthy") {
    observations.push({
      tone: "good",
      text: "No funnel step is under-converting against the early benchmarks.",
      evidence: `${c.contacted} contacted → ${c.viewed} viewed → ${c.engaged} engaged → ${c.replied} replied`,
    });
  }
  if (f.approvals > 0) {
    observations.push({
      tone: "watch",
      text: `${n(f.approvals, "draft")} awaiting approval.`,
      evidence: "nothing sends without an approved draft",
    });
  }
  if (f.stalledAtOne > 0) {
    observations.push({
      tone: "watch",
      text: `${n(f.stalledAtOne, "prospect")} stalled at one touch with a follow-up already due.`,
      evidence: "one send, no reply, cadence-eligible",
    });
  }
  if (f.capUsed24h >= f.capLimit - 3) {
    observations.push({
      tone: "watch",
      text: "Send capacity is nearly used — further gmail sends refuse until the window clears.",
      evidence: `${f.capUsed24h}/${f.capLimit} in the trailing 24h`,
    });
  }
  if (f.researchQueue > 0) {
    observations.push({
      tone: "watch",
      text: `${n(f.researchQueue, "prospect")} with a published audit but no sendable contact.`,
      evidence: "research queue",
    });
  }
  if (f.expiringAudits > 0) {
    observations.push({
      tone: "bad",
      text: `${n(f.expiringAudits, "audit")} expiring soon — republish or let them lapse.`,
      evidence: `${f.expiringAudits} within the expiry window`,
    });
  }
  if (f.blockedSends > 0) {
    observations.push({
      tone: "bad",
      text: `${n(f.blockedSends, "send")} parked after a transport error.`,
      evidence: "see Needs review",
    });
  }
  if (f.unresolvedAttribution > 0) {
    observations.push({
      tone: "bad",
      text: `${n(f.unresolvedAttribution, "prospect")} with audit activity but no recorded send.`,
      evidence: "excluded from campaign metrics until resolved",
    });
  }
  if (bottleneck) {
    observations.push({
      tone: "bad",
      text: `Possible bottleneck: ${d.bottleneck?.replaceAll("_", " ")} — ${d.reason}`,
      evidence: `review ${d.review.join(", ")}`,
    });
  }

  return {
    version: BRIEF_VERSION,
    headline,
    actions,
    observations,
    epilogue:
      d.verdict === "not_enough_data"
        ? "Early sample — directional only; do not re-plan from these numbers."
        : null,
  };
}
