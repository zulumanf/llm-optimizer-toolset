/**
 * Privacy vocabulary for knowledge packets — a leaf module so that
 * packet.ts and context/builder.ts (which both need it) no longer import
 * each other. This was the codebase's only runtime import cycle (cleanup
 * audit 2026-08-04); with it broken, "cycle-free" is a claim CI can enforce.
 */
export const PRIVACY_ORDER = ["public", "client_only", "internal", "restricted"] as const;
export type PrivacyStatus = (typeof PRIVACY_ORDER)[number];
