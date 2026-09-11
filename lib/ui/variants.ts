/**
 * Shared badge-variant vocabulary (cleanup 2026-08-18). The audit found 20
 * independent status/severity → variant maps across app/ and components/;
 * this registry is the single home for the cross-surface ones. A surface
 * with a deliberate local deviation spreads the registry and overrides the
 * one key, with a comment saying why.
 */
export type BadgeVariant = "default" | "destructive" | "outline" | "secondary";

/** Finding/alert severity — destructive only for act-now levels. */
export const SEVERITY_VARIANT: Record<string, BadgeVariant> = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
  info: "outline",
};
