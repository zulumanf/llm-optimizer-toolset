/** Shared between the server service and client components — no server
 * imports here, so the client bundle stays clean. */
/** Full hierarchy vocabulary (spec 040): country → state → metro → city →
 * borough/county → neighborhood (→ zip). Containment logic is kind-agnostic. */
export const MARKET_KINDS = [
  "country",
  "state",
  "metro",
  "city",
  "borough",
  "county",
  "neighborhood",
  "zip",
  "region",
  "custom",
] as const;
export type MarketKind = (typeof MARKET_KINDS)[number];
