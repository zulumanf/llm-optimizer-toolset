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
