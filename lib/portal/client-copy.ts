/**
 * Client-facing copy for the portal (spec 155). Plain English, "we" for
 * Recommended First, "you" for the client. Kept here so components carry no
 * semantic strings and the same sentence is used wherever it appears.
 */
import type { JourneyStepKey } from "@/lib/engagements/delivery-rules";

export function portalTabs(projectId: string, engaged: boolean): { href: string; label: string }[] {
  const base = `/portal/${projectId}`;
  return engaged
    ? [
        { href: base, label: "Overview" },
        { href: `${base}/results`, label: "Results" },
        { href: `${base}/plan`, label: "90-Day Plan" },
        { href: `${base}/approvals`, label: "Approvals" },
        { href: `${base}/reports`, label: "Reports" },
      ]
    : [
        { href: base, label: "Overview" },
        { href: `${base}/work`, label: "Work" },
        { href: `${base}/reports`, label: "Reports" },
      ];
}

/** "This week's focus" when no client-visible work is in progress. */
export const FOCUS_BY_STEP: Record<JourneyStepKey, string> = {
  commercial: "We're getting your agreement in place.",
  welcome: "We're setting up your workspace.",
  details: "We're setting up your workspace and confirming your details.",
  questions: "We're finalizing the customer-search questions we'll measure for you.",
  protocol: "We're agreeing exactly how your results will be measured.",
  baseline: "We're establishing your starting AI visibility, so every later result has an honest comparison.",
  roadmap: "We're preparing your personalized 90-day roadmap from your starting point.",
  delivery: "We're working through your 90-day plan.",
  final_review: "We're preparing your Day-90 results review.",
  closed: "Your 90-day engagement is complete.",
};

/** Task titles are shown exactly as written (they are client-visible work). */
export function focusFromWork(titles: string[]): string[] {
  return titles.slice(0, 2);
}

export const FOCUS_WORK_LEAD = "This week we're working on:";

export const ESTABLISHING_STARTING_POINT = "We're establishing your starting point.";
export const NOTHING_NEEDED = "Nothing needed from you right now.";
export const ROADMAP_NOT_YET = "We'll share your 90-day roadmap once your starting point is measured.";

export const ONBOARDING_COPY = {
  stepLabel: (n: number, of: number) => `Step ${n} of ${of}`,
  welcomeTitle: (name: string) => `Welcome, ${name}.`,
  welcomeLead: "We've already prepared your workspace. Just confirm a few details so we can get started.",
  contactsTitle: "Who should we work with?",
  contactsLead: "We'll handle the work and reach out when something needs your approval.",
  contactsFootnote: "We'll never ask for passwords. You can invite colleagues later.",
  doneTitle: "You're all set. We'll take it from here.",
  doneLead: "Here's what happens next. We'll keep you posted on your dashboard.",
  nextSteps: [
    "We'll finalize your customer-search questions.",
    "We'll establish and verify your starting AI visibility.",
    "We'll prepare your personalized 90-day roadmap.",
  ],
  previewNote: "Preview — only the client can confirm these details.",
  genericError: "Something went wrong saving that. Please try again.",
} as const;

export const QUESTION_REVIEW_COPY = {
  title: "Your customer questions",
  why: "These are the questions real customers type into AI assistants when they're looking for an agent. We measure how often you're recommended for each one, so the list should reflect the business you want more of.",
  how: "Approve the ones that fit. Ask for an edit or remove any that don't. Your choices save as you go — you can stop and come back any time.",
  locked: "Approved. These questions are now the fixed set we measure, so every result compares like with like.",
  changesSent: "Thanks — we've received your requested changes. We'll send an updated list for your review.",
} as const;

/** Client-facing name of a pending to-do on the Overview. */
export function questionReviewTodo(remaining: number, total: number): string {
  return remaining === total ? `Review your ${total} customer questions` : remaining > 0 ? `Finish reviewing your customer questions (${remaining} left)` : "Send your question review";
}
