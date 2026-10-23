/**
 * The ONLY server actions callable without a staff role (spec 156). Shared by
 * the structural and runtime authorization suites so the two can never
 * disagree. Adding an entry is a security decision: state the gate that
 * replaces the staff check. Do not add entries to make a feature pass.
 */
export const ACTION_ALLOW_LIST: Readonly<Record<string, string>> = {
  "app/(marketing)/actions.ts:requestAuditAction":
    "public marketing intake (spec 061); anonymous by design, rate-limited and honeypotted in submitAuditRequest",
  "app/report/[slug]/walkthrough/actions.ts:submitReportWalkthroughRequest":
    "prospect report session cookie (spec 134), not a workspace account",
};

/** Directories whose actions run before any account exists. */
export const ACTION_EXCLUDED_DIRS: Readonly<Record<string, string>> = {
  "app/login/": "sign-in and sign-out: callable before and after a session by design",
};

/**
 * Client-callable server actions (spec 155 R1/R2). Each is refused for staff,
 * for `client_viewer`, and for any project the caller is not granted; it
 * runs only for the AUDIENCE on its own granted project. Both authorization
 * suites read this list: the structural one requires the portal wrapper, the
 * runtime one proves every non-audience caller is refused with zero writes.
 */
export const CLIENT_ACTIONS: Readonly<Record<string, { audience: "CLIENT_VALIDATOR"; reason: string }>> = {
  "app/portal/[projectId]/actions.ts:saveOnboardingPriorities": { audience: "CLIENT_VALIDATOR", reason: "the approver corrects their onboarding priorities (working copy only)" },
  "app/portal/[projectId]/actions.ts:confirmOnboardingPriorities": { audience: "CLIENT_VALIDATOR", reason: "the approver confirms their priorities" },
  "app/portal/[projectId]/actions.ts:reopenOnboardingPriorities": { audience: "CLIENT_VALIDATOR", reason: "the approver goes back a step (keeps every saved value)" },
  "app/portal/[projectId]/actions.ts:completeClientOnboarding": { audience: "CLIENT_VALIDATOR", reason: "the approver confirms contacts and completes onboarding" },
  "app/portal/[projectId]/actions.ts:submitDetailCorrection": { audience: "CLIENT_VALIDATOR", reason: "the approver records a versioned correction after onboarding" },
  "app/portal/[projectId]/actions.ts:reviewQuestions": { audience: "CLIENT_VALIDATOR", reason: "informal per-question review (approve / request edit / remove)" },
  "app/portal/[projectId]/actions.ts:approveRemainingQuestions": { audience: "CLIENT_VALIDATOR", reason: "informal batch review of undecided questions" },
  "app/portal/[projectId]/actions.ts:submitQuestionReview": { audience: "CLIENT_VALIDATOR", reason: "sends review feedback; never records an approval (R3)" },
  "app/portal/[projectId]/actions.ts:approveMeasurementPlan": { audience: "CLIENT_VALIDATOR", reason: "the binding approval: exact final questions + protocol (R3)" },
};
