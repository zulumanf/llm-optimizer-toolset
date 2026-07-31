/** Shared between the server service and client components — no server
 * imports here, so the client bundle stays clean. */
export const MARKET_KINDS = [
  "city",
  "borough",
  "neighborhood",
  "region",
  "custom",
] as const;
export type MarketKind = (typeof MARKET_KINDS)[number];
