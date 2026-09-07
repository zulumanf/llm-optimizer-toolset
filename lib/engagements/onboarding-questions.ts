/**
 * Onboarding question framework (spec 132). Every client is asked only what
 * the canonical record cannot answer AND that changes the work. Core
 * questions hide themselves when a context item or the evidence already
 * answers them; conditional questions appear only when a specific gap exists.
 * Client-safe: pure over inputs the caller assembled.
 */
import type { ContextItem } from "@/lib/engagements/service";
import type { MeasurementSnapshot } from "@/lib/engagements/rules";

export interface OnboardingQuestion {
  key: string;
  kind: "required_core" | "conditional";
  question: string;
  /** Why we still need it — shown to the operator, not the client. */
  reason: string;
  /** Evidence hint appended to the client-facing wording. */
  hint: string | null;
  /** Context item kind the answer is recorded as. */
  recordsAs: string;
}

export interface OnboardingQuestionInput {
  context: ContextItem[];
  baseline: MeasurementSnapshot | null;
  competitorNames: string[];
  ownSiteKnown: boolean;
  brokerageKnown: boolean;
  primaryContactNamed: boolean;
  /** Neighborhood-like question texts where the rival leads, from the baseline. */
  rivalLeadsOn: string[];
}

const has = (items: ContextItem[], kind: string, provenance?: string) =>
  items.some((i) => i.kind === kind && (!provenance || i.provenance === provenance));

export function onboardingQuestions(i: OnboardingQuestionInput): OnboardingQuestion[] {
  const out: OnboardingQuestion[] = [];
  // 1. Priorities (areas + buyer/seller focus) — hidden once a client_priority exists.
  if (!has(i.context, "priority_area", "client_priority") && !has(i.context, "client_focus", "client_priority")) {
    const areas = i.rivalLeadsOn.slice(0, 3);
    out.push({
      key: "priorities",
      kind: "required_core",
      question: "For the term, which two or three areas matter most to you, and is that mostly sellers, buyers, or both?",
      reason: "Decides which neighborhood/segment evidence we work on; the benchmark shows where the rival leads, not what the client wants.",
      hint: areas.length > 0 ? `The answers we captured point at ${areas.join(", ")} most; tell me if those are the right ones.` : null,
      recordsAs: "priority_area / client_focus (client_priority)",
    });
  }
  // 2. Competitor set — confirm-with-default; hidden once confirmed or excluded.
  if (!has(i.context, "competitor", "client_confirmed") && !has(i.context, "excluded_competitor", "client_confirmed")) {
    const rival = i.competitorNames[0] ?? null;
    out.push({
      key: "competitors",
      kind: "required_core",
      question: rival
        ? `We measure you against ${rival} because the answers recommend them most. Is there anyone else you consider the real comparison, or is that right?`
        : "Which two or three teams do you consider your real comparison set?",
      reason: "The competitor set is frozen into the baseline; confirm it before freezing.",
      hint: null,
      recordsAs: "competitor / excluded_competitor (client_confirmed)",
    });
  }
  // 3. Editable assets / access — hidden once any access item exists.
  if (!has(i.context, "access")) {
    out.push({
      key: "access",
      kind: "required_core",
      question: "Who on your team can edit your website and your Zillow, Realtor.com and Homes.com profiles? If you can add me as an editor on the website, please do; for the profiles I will send exact field-by-field changes for your team to apply.",
      reason: "Week 2 work cannot start without knowing who applies changes; never a password.",
      hint: null,
      recordsAs: "access (requested → granted / not_needed / declined)",
    });
  }
  // Conditional: own site unknown.
  if (!i.ownSiteKnown && !has(i.context, "asset")) {
    out.push({
      key: "own_site",
      kind: "conditional",
      question: "What is your main website address?",
      reason: "No domain on the company record and no asset item.",
      hint: null,
      recordsAs: "asset (client_confirmed)",
    });
  }
  // Conditional: brokerage unknown.
  if (!i.brokerageKnown && !has(i.context, "identity")) {
    out.push({
      key: "brokerage",
      kind: "conditional",
      question: "Which brokerage are you licensed under, exactly as it should appear publicly?",
      reason: "Identity line needs the brokerage; not on the record.",
      hint: null,
      recordsAs: "identity (client_confirmed)",
    });
  }
  // Conditional: no primary contact.
  if (!i.primaryContactNamed) {
    out.push({
      key: "approver",
      kind: "conditional",
      question: "Who should approve public-facing changes, and by which channel?",
      reason: "No primary contact named on the engagement.",
      hint: null,
      recordsAs: "primary contact",
    });
  }
  return out;
}

/** Client-facing wording: numbered questions with hints. */
export function renderQuestions(questions: OnboardingQuestion[]): string {
  return questions.map((q, n) => `${n + 1}. ${q.question}${q.hint ? ` (${q.hint})` : ""}`).join("\n");
}
