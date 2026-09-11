/**
 * Spec 132 — deterministic delivery QA. Load-bearing: unknown billing never
 * reads as current, a vague completion without an after-state is refused, a
 * draft naming another client is P0, non-canonical counts are P0, causal
 * language is flagged, and portfolio alerts rank client-waiting-on-us above
 * routine work.
 */
import { describe, expect, it } from "vitest";
import {
  activationQa,
  billingState,
  causalLanguageIssues,
  communicationQa,
  comparabilityLabel,
  evidenceDriftQa,
  executionCompleteQa,
  executionStartQa,
  executionState,
  loopPosition,
  offboardingQa,
  portfolioAlerts,
  qaStatusFor,
  scopeSuspicion,
  waitingOnSummary,
  type ExecutionTask,
  type PortfolioClientInput,
} from "@/lib/engagements/qa";
import type { MeasurementSnapshot } from "@/lib/engagements/rules";

const snapshot = (over: Partial<MeasurementSnapshot> = {}): MeasurementSnapshot => ({
  methodologyVersion: "engagement-measurement-v1",
  runId: "r",
  sourceProjectId: "p",
  provider: "openai",
  models: ["m"],
  repetitions: 4,
  promptSetVersionId: "v1",
  questionCount: 64,
  answerCount: 256,
  capturedAt: "2026-08-31T11:00:00.000Z",
  subject: { companyId: "blu", name: "Blu House Properties", aliases: ["Ryan Ogle"], recommendedCount: 29, distinctQuestions: 20 },
  competitors: [{ companyId: "josh", name: "Josh May", aliases: [], recommendedCount: 38, distinctQuestions: 21 }],
  questions: [],
  versions: { scoringVersion: "v1.1", parserVersions: [], classifierModels: [], resolverPolicy: "verified-lead-agent-alias-v1" },
  ...over,
});

const task = (over: Partial<ExecutionTask> = {}): ExecutionTask => ({
  title: "Align identity line on the about page",
  description: null,
  status: "approved",
  evidenceCount: 1,
  observation: "o",
  hypothesis: "h",
  confidence: "high_confidence",
  control: "we_control",
  scope: "in_scope",
  clientApproval: "approved",
  blockedReason: null,
  targetUrl: "https://example.invalid/about",
  beforeState: "team only",
  afterState: "owner + team",
  measurementNote: "same instrument",
  ownerId: "u",
  ...over,
});

describe("activation QA", () => {
  const base = {
    stage: "active" as const,
    subjectLinked: true,
    primaryContactNamed: true,
    startsOn: "2026-09-07",
    endsOn: "2026-12-06",
    monthlyFeeUsd: 7500,
    totalValueUsd: 22500,
    contractStatus: "signed" as const,
    contractRef: "ref",
    paymentsReceivedCents: 750_000,
    activationOverrideReason: null,
    marketDefinitionConfirmed: true,
    exclusivityStatus: "active" as const,
    marketConflicts: 0,
    competitorCount: 1,
    competitorConfirmed: true,
    baseline: snapshot(),
    baselineImmutableTrigger: true,
    priorityItems: 1,
    accessUnknown: 0,
    today: "2026-09-08",
  };
  it("passes a complete activation and blocks on each P0 condition", () => {
    expect(activationQa(base).verdict).toBe("PASS");
    for (const broken of [
      { contractStatus: "sent" as const },
      { contractRef: null },
      { paymentsReceivedCents: 0 },
      { marketDefinitionConfirmed: false },
      { exclusivityStatus: "reserved" as const },
      { baseline: null },
      { marketConflicts: 1 },
      { baselineImmutableTrigger: false },
    ]) {
      expect(activationQa({ ...base, ...broken }).verdict, JSON.stringify(broken)).toBe("BLOCKED");
    }
  });
  it("flags an outdated resolver policy and stale evidence as review, not block", () => {
    const old = snapshot();
    old.versions = { ...old.versions, resolverPolicy: "old" };
    expect(activationQa({ ...base, baseline: old }).verdict).toBe("REVIEW_REQUIRED");
    expect(activationQa({ ...base, today: "2027-03-01" }).issues.map((i) => i.code)).toContain("STALE_EVIDENCE");
  });
});

describe("evidence drift QA", () => {
  it("flags count and entity drift without touching the frozen package", () => {
    const frozen = snapshot();
    const now = snapshot();
    now.subject = { ...now.subject, recommendedCount: 31 };
    const issues = evidenceDriftQa({ frozen, current: now, subjectAliasesNow: ["Ryan Ogle", "Blu House Team"], competitorsArchived: ["josh"] });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["COUNT_DRIFT", "BASELINE_ENTITY_DRIFT", "COMPETITOR_MISMATCH"]));
    expect(frozen.subject.recommendedCount).toBe(29);
  });
  it("is quiet when nothing changed", () => {
    expect(evidenceDriftQa({ frozen: snapshot(), current: snapshot(), subjectAliasesNow: ["Ryan Ogle"], competitorsArchived: [] })).toEqual([]);
  });
});

describe("execution QA", () => {
  it("derives the state in priority order", () => {
    expect(executionState(task()).state).toBe("PASS");
    expect(executionState(task({ scope: "needs_founder_review" })).state).toBe("OUT_OF_SCOPE");
    expect(executionState(task({ evidenceCount: 0 })).state).toBe("EVIDENCE_MISSING");
    expect(executionState(task({ clientApproval: "required" })).state).toBe("APPROVAL_REQUIRED");
    expect(executionState(task({ blockedReason: "client_input" })).state).toBe("BLOCKED_CLIENT");
    expect(executionState(task({ blockedReason: "third_party" })).state).toBe("BLOCKED_THIRD_PARTY");
    expect(executionState(task({ blockedReason: "internal" })).state).toBe("BLOCKED_INTERNAL");
  });
  it("refuses a vague completion and one without before/after/where", () => {
    const vague = executionCompleteQa(task({ title: "Optimized Zillow profile", afterState: null }));
    expect(vague.map((i) => i.code)).toEqual(expect.arrayContaining(["VAGUE_COMPLETION", "AFTER_STATE_MISSING"]));
    expect(executionCompleteQa(task({ targetUrl: null })).map((i) => i.code)).toContain("TARGET_MISSING");
    expect(executionCompleteQa(task()).filter((i) => i.severity === "P1")).toEqual([]);
  });
  it("suspects adjacent services unless the scope names them", () => {
    expect(scopeSuspicion("Run Google Ads for listings", "AI recommendation diagnosis")).toBe("paid advertising");
    expect(scopeSuspicion("Run Google Ads for listings", "Scope includes Google Ads for two listings")).toBeNull();
    expect(scopeSuspicion("Align identity line", "AI recommendation diagnosis")).toBeNull();
    expect(executionStartQa(task({ title: "Full website redesign" }), "diagnosis").map((i) => i.code)).toContain("SCOPE_SUSPECTED");
  });
});

describe("measurement QA", () => {
  it("labels comparability and catches causal language", () => {
    expect(comparabilityLabel("high", "completed")).toBe("HIGH_COMPARABILITY");
    expect(comparabilityLabel("high", "partial")).toBe("PARTIAL_COMPARABILITY");
    expect(comparabilityLabel("medium", "completed")).toBe("PARTIAL_COMPARABILITY");
    expect(comparabilityLabel("not_comparable", "completed")).toBe("NON_COMPARABLE");
    expect(causalLanguageIssues("Recommendation frequency moved from 29 of 256 to 35 of 256.")).toEqual([]);
    expect(causalLanguageIssues("Our changes increased Ryan by six recommendations.").map((i) => i.code)).toContain("CAUSAL_OVERCLAIM");
    expect(causalLanguageIssues("Fixing Zillow caused the increase.").length).toBeGreaterThan(0);
    expect(causalLanguageIssues("We guarantee you will rank #1 on ChatGPT.").map((i) => i.code)).toContain("GUARANTEE");
    expect(causalLanguageIssues("Visibility increased 37%").map((i) => i.code)).toContain("UNSUPPORTED_PERCENT");
  });
});

describe("communication QA", () => {
  const pack = {
    clientName: "Blu House Properties",
    marketName: "Grand Rapids",
    otherClientNames: ["JC Luxury Group"],
    canonicalCounts: ["29 of 256", "38 of 256", "20 of 64"],
    doneTitles: ["Align identity line on the about page"],
    inProgressTitles: ["Profile field changes"],
    blockedTitles: [],
    approvalTitles: [],
    nextMeasurementOn: "2026-10-22",
    engagementEndsOn: "2026-12-06",
  };
  it("passes a canonical draft", () => {
    const draft = "Weekly update — Blu House Properties\n\nDONE — what changed this week\n- Align identity line on the about page\n\nIN PROGRESS\n- Profile field changes\n\nNEED FROM YOU\n- Nothing is waiting on you.\n\nMEASUREMENT\n- Baseline stands at 29 of 256. Next remeasurement 2026-10-22.\n\nNEXT\n- Continue.";
    expect(communicationQa(draft, pack).verdict).toBe("PASS");
  });
  it("flags other-client data, non-canonical numbers, stale dates, status mismatch, prospecting words and jargon", () => {
    const draft = "Weekly update — Blu House Properties\n\nDONE — what changed this week\n- Profile field changes\n\nIN PROGRESS\n- Align identity line on the about page\n\nMEASUREMENT\n- You are at 31 of 256, like JC Luxury Group. Our changes increased recommendations. Next remeasurement 2026-11-01. Denominator excludes holdout prompts from the prompt set.\n\nNEXT\n- Touch 2 of the sequence.";
    const codes = communicationQa(draft, pack).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["OTHER_CLIENT_DATA", "NUMBER_NOT_CANONICAL", "STATUS_MISMATCH", "CAUSAL_OVERCLAIM", "MEASUREMENT_DATE_MISMATCH", "PROSPECTING_LANGUAGE", "TECHNICAL_JARGON"]));
    expect(communicationQa(draft, pack).issues.some((i) => i.severity === "P0")).toBe(true);
  });
});

describe("billing state", () => {
  const today = "2026-09-20";
  it("never reads unknown as current", () => {
    expect(billingState([], today)).toBe("UNKNOWN");
    expect(billingState([{ kind: "invoice_created", amountCents: 750000, dueDate: "2026-09-10", externalInvoiceId: "INV-1" }], today)).toBe("PAYMENT_OVERDUE");
    expect(billingState([{ kind: "invoice_created", amountCents: 750000, dueDate: "2026-09-30", externalInvoiceId: "INV-1" }], today)).toBe("PAYMENT_DUE");
    expect(billingState([{ kind: "invoice_created", amountCents: 750000, dueDate: "2026-09-10", externalInvoiceId: "INV-1" }, { kind: "payment_received", amountCents: 750000, dueDate: null, externalInvoiceId: "INV-1" }], today)).toBe("PAYMENT_CURRENT");
  });
});

describe("portfolio alerts", () => {
  const base: PortfolioClientInput = {
    stage: "active",
    startsOn: "2026-09-07",
    endsOn: "2026-12-06",
    renewalReviewOn: "2026-11-15",
    renewalStatus: "not_due",
    onboardingDone: true,
    checklist: [],
    commercialReady: true,
    commercialReasons: [],
    exclusivityStatus: "active",
    agreementEndsOn: "2026-12-06",
    marketConflicts: 0,
    tasks: [{ status: "in_progress", clientApproval: "not_required", blockedReason: null, updatedAt: "2026-09-20", implementedAt: null, scope: "in_scope" }],
    lastChangeAt: "2026-09-18",
    lastMeasurementAt: null,
    nextMeasurementOn: "2026-10-22",
    lastClientUpdateOn: "2026-09-18",
    billing: "PAYMENT_CURRENT",
    portalGrants: 1,
    openQaIssues: [],
    today: "2026-09-21",
  };
  it("is quiet for a healthy active client", () => {
    expect(portfolioAlerts(base)).toEqual([]);
    expect(qaStatusFor([])).toBe("CLEAR");
  });
  it("ranks P0, then client waiting on us, then measurement, then communication", () => {
    const alerts = portfolioAlerts({
      ...base,
      marketConflicts: 1,
      tasks: [{ status: "approved", clientApproval: "approved", blockedReason: null, updatedAt: "2026-09-20", implementedAt: null, scope: "in_scope" }, { status: "approved", clientApproval: "required", blockedReason: null, updatedAt: "2026-09-20", implementedAt: null, scope: "in_scope" }],
      nextMeasurementOn: "2026-09-20",
      lastClientUpdateOn: "2026-09-01",
    });
    const codes = alerts.map((a) => a.code);
    expect(codes[0]).toBe("EXCLUSIVITY_CONFLICT");
    expect(codes.indexOf("CLIENT_WAITING_ON_US")).toBeLessThan(codes.indexOf("MEASUREMENT_OVERDUE"));
    expect(codes.indexOf("MEASUREMENT_OVERDUE")).toBeLessThan(codes.indexOf("CLIENT_UPDATE_DUE"));
    expect(codes).toContain("CLIENT_APPROVAL_WAITING");
    expect(waitingOnSummary(alerts)).toBe("us");
    expect(qaStatusFor(alerts)).toBe("P0");
  });
  it("flags neglect: no active work, nothing completed recently, unknown billing", () => {
    const alerts = portfolioAlerts({ ...base, tasks: [], lastChangeAt: null, today: "2026-10-05", billing: "UNKNOWN" });
    expect(alerts.map((a) => a.code)).toEqual(expect.arrayContaining(["NO_ACTIVE_WORK", "NO_WORK_COMPLETED_RECENTLY", "BILLING_ATTENTION", "CLIENT_UPDATE_DUE"]));
  });
  it("a client waiting on their own approval is not waiting on us", () => {
    const alerts = portfolioAlerts({ ...base, tasks: [{ status: "approved", clientApproval: "required", blockedReason: null, updatedAt: "2026-09-20", implementedAt: null, scope: "in_scope" }] });
    expect(waitingOnSummary(alerts)).toBe("client");
  });
});

describe("loop position and offboarding", () => {
  it("names the missing link and the next decision", () => {
    const pos = loopPosition({ stage: "active", baseline: true, hypotheses: 0, activeWork: 0, implemented: 0, nextMeasurementOn: null, latestResult: null, renewalStatus: "not_due" });
    expect(pos.missing).toEqual(["hypotheses", "work", "next measurement"]);
    expect(pos.nextDecision).toBe("plan the next measurement");
  });
  it("keeps an incomplete offboarding visible", () => {
    const issues = offboardingQa({ stage: "completed", agreementStatus: "active", portalGrants: 1, plannedMeasurements: 1, openTasks: 2, accessGranted: 1, cooldownUntil: null, prospectDoNotContact: false });
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["EXCLUSIVITY_NOT_RELEASED", "PORTAL_GRANTS_OPEN", "MEASUREMENTS_NOT_STOPPED", "WORK_UNHANDLED", "ACCESS_NOT_REVOKED", "COOLDOWN_MISSING"]));
    expect(offboardingQa({ stage: "active", agreementStatus: "active", portalGrants: 1, plannedMeasurements: 1, openTasks: 0, accessGranted: 0, cooldownUntil: null, prospectDoNotContact: false })).toEqual([]);
  });
});
